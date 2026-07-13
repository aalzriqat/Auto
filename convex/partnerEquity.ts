import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";
import { toMinorUnits } from "./utils/money";
import {
  hookCapitalContributed,
  hookPartnerDrew,
  hookProfitDistributed,
  getOrgCurrency,
} from "./accounting/workflowHooks";

const movementTypeValidator = v.union(
  v.literal("CONTRIBUTION"),
  v.literal("DRAW"),
  v.literal("PROFIT_DISTRIBUTION"),
);

/**
 * GL Phase 12 balance model: the partner's opening base plus every movement
 * since is an immutable partnerEquityTransactions row. The live balance is
 * always base + Σtransactions — never a directly-patched number.
 *
 * GL Phase 17: the base itself prefers openingBalanceMinor (the backfilled
 * minor-unit value) when present, falling back to converting the legacy
 * major-unit currentBalance live for rows the backfill migration hasn't
 * reached yet — see accountingMigration.backfillPartnerEquityMinorUnits.
 */
async function derivePartnerBalanceMinor(
  ctx: QueryCtx,
  partner: Doc<"partnerEquity">,
  orgCurrency: string
): Promise<{ balanceMinor: number; transactionCount: number }> {
  const transactions = await ctx.db
    .query("partnerEquityTransactions")
    .withIndex("by_org_partner_time", (q) =>
      q.eq("orgId", partner.orgId).eq("partnerId", partner._id)
    )
    .collect();

  let delta = 0;
  for (const tx of transactions) {
    delta += tx.type === "DRAW" ? -tx.amountMinor : tx.amountMinor;
  }
  const legacyBaseMinor = partner.openingBalanceMinor ?? toMinorUnits(partner.currentBalance ?? 0, orgCurrency);
  return { balanceMinor: legacyBaseMinor + delta, transactionCount: transactions.length };
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const page = await ctx.db
      .query("partnerEquity")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .paginate(args.paginationOpts);

    // Partner counts per dealership are inherently tiny (a handful of owners),
    // so deriving each row's balance inline is fine at this scale.
    const enriched = await Promise.all(
      page.page.map(async (partner) => {
        const { balanceMinor, transactionCount } = await derivePartnerBalanceMinor(ctx, partner, currency);
        return { ...partner, balanceMinor, transactionCount, currency };
      })
    );
    return { ...page, page: enriched };
  },
});

export const listTransactions = query({
  args: { orgId: v.id("organizations"), partnerId: v.id("partnerEquity") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const partner = await ctx.db.get(args.partnerId);
    if (!partner || partner.orgId !== args.orgId) {
      throw new ConvexError("Partner not found in this organization.");
    }
    return await ctx.db
      .query("partnerEquityTransactions")
      .withIndex("by_org_partner_time", (q) =>
        q.eq("orgId", args.orgId).eq("partnerId", args.partnerId)
      )
      .order("desc")
      .collect();
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    partnerName: v.string(),
    notes: v.optional(v.string()),
    // Optional opening contribution, posted to the GL like any other
    // contribution — replaces the old free-typed initialCapital/currentBalance.
    openingContributionMinor: v.optional(v.number()),
    paymentMethod: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!args.partnerName.trim()) {
      throw new ConvexError("Partner name is required.");
    }

    const partnerId = await ctx.db.insert("partnerEquity", {
      orgId: args.orgId,
      partnerName: args.partnerName.trim(),
      notes: args.notes,
    });

    if (args.openingContributionMinor != null && args.openingContributionMinor > 0) {
      await recordMovement(ctx, {
        orgId: args.orgId,
        partnerId,
        type: "CONTRIBUTION",
        amountMinor: args.openingContributionMinor,
        paymentMethod: args.paymentMethod,
        actorId: user._id,
      });
    }

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
      link: `/${args.orgId}/accounting`,
    });

    return partnerId;
  },
});

async function recordMovement(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    partnerId: Id<"partnerEquity">;
    type: "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION";
    amountMinor: number;
    paymentMethod?: string;
    notes?: string;
    occurredAt?: number;
    actorId: Id<"users">;
  }
): Promise<Id<"partnerEquityTransactions">> {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("Amount must be a positive integer minor-unit amount.");
  }
  if (args.paymentMethod === "OTHER") {
    throw new ConvexError("Select a specific payment method — OTHER is not accepted.");
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const occurredAt = args.occurredAt ?? Date.now();

  const transactionId = await ctx.db.insert("partnerEquityTransactions", {
    orgId: args.orgId,
    partnerId: args.partnerId,
    type: args.type,
    amountMinor: args.amountMinor,
    currency,
    occurredAt,
    notes: args.notes,
    actorId: args.actorId,
    createdAt: Date.now(),
  });

  const hookArgs = {
    orgId: args.orgId,
    transactionId,
    partnerId: args.partnerId,
    amountMinor: args.amountMinor,
    currency,
    paymentMethod: args.paymentMethod,
    actorId: args.actorId,
    occurredAt,
  };
  if (args.type === "CONTRIBUTION") await hookCapitalContributed(ctx, hookArgs);
  else if (args.type === "DRAW") await hookPartnerDrew(ctx, hookArgs);
  else await hookProfitDistributed(ctx, hookArgs);

  return transactionId;
}

export const recordEquityMovement = mutation({
  args: {
    orgId: v.id("organizations"),
    partnerId: v.id("partnerEquity"),
    type: movementTypeValidator,
    amountMinor: v.number(),
    paymentMethod: v.optional(v.string()),
    notes: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const partner = await ctx.db.get(args.partnerId);
    if (!partner || partner.orgId !== args.orgId || partner.isDeleted) {
      throw new ConvexError("Partner not found in this organization.");
    }

    if (args.type === "DRAW") {
      const currency = await getOrgCurrency(ctx, args.orgId);
      const { balanceMinor } = await derivePartnerBalanceMinor(ctx, partner, currency);
      if (args.amountMinor > balanceMinor) {
        throw new ConvexError(
          "Draw exceeds this partner's equity balance. Record a profit distribution first if the partner is drawing against undistributed profit."
        );
      }
    }

    const transactionId = await recordMovement(ctx, {
      orgId: args.orgId,
      partnerId: args.partnerId,
      type: args.type,
      amountMinor: args.amountMinor,
      paymentMethod: args.paymentMethod,
      notes: args.notes,
      occurredAt: args.occurredAt,
      actorId: user._id,
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
      link: `/${args.orgId}/accounting`,
    });

    return transactionId;
  },
});

/** Identity fields only — balances change exclusively through recordEquityMovement (GL Phase 12 "no direct balance edits" rule). */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
    partnerName: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, equityId, ...updates } = args;

    const equity = await ctx.db.get(equityId);
    if (!equity || equity.orgId !== orgId) {
      throw new ConvexError("Partner equity record not found in this organization.");
    }

    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    );
    if (Object.keys(cleanedUpdates).length > 0) {
      await ctx.db.patch(equityId, cleanedUpdates);
    }

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, orgId, "partnerEquity.changed", { actorName }, {
      link: `/${orgId}/accounting`,
    });
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const equity = await ctx.db.get(args.equityId);
    if (!equity || equity.orgId !== args.orgId) {
      throw new ConvexError("Partner equity record not found in this organization.");
    }

    // A partner with GL-backed equity movements can't just vanish — their
    // capital is on the books. Pure legacy rows (no transactions) may still be
    // removed; migrating those balances is GL Phase 17's job.
    const currency = await getOrgCurrency(ctx, args.orgId);
    const { balanceMinor, transactionCount } = await derivePartnerBalanceMinor(ctx, equity, currency);
    if (transactionCount > 0 && balanceMinor !== 0) {
      throw new ConvexError(
        "This partner still has an equity balance on the ledger. Draw it down to zero before removing them."
      );
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.equityId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
      link: `/${args.orgId}/accounting`,
    });
  },
});
