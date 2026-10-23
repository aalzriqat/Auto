import { v, ConvexError } from "convex/values";
import { PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED, PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE } from "./utils/partnerDistributionContainment";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";
import { toMinorSameCurrencyOrUndefined } from "./utils/money";
import {
  hookCapitalContributed,
  hookPartnerDrew,
  hookProfitDistributed,
  getOrgCurrency,
  shouldPost,
} from "./accounting/workflowHooks";
import { paymentMethodValidator, PaymentMethod } from "./utils/paymentMethods";
import { runWithIdempotency } from "./utils/idempotency";
import { listEligibleBanks, requireActiveBankInCurrency } from "./utils/bankAccountGuards";
import { partnerEquityNeedsBank } from "./utils/partnerEquityBank";
import { loadPartnerOpening, openingPartnerBasis, type PartnerOpeningContext } from "./utils/openingPartnerBasis";

const movementTypeValidator = v.union(
  v.literal("CONTRIBUTION"),
  v.literal("DRAW"),
  v.literal("PROFIT_DISTRIBUTION"),
);

async function validateMovementBank(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    type: "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION";
    paymentMethod?: PaymentMethod;
    bankAccountId?: Id<"bankAccounts">;
    currency: string;
  }
): Promise<Id<"bankAccounts"> | undefined> {
  if (args.type === "PROFIT_DISTRIBUTION" && args.paymentMethod) {
    throw new ConvexError("A profit distribution does not move cash or bank money.");
  }
  if (!partnerEquityNeedsBank(args.type, args.paymentMethod)) {
    if (args.bankAccountId) {
      throw new ConvexError("A bank account does not apply to this partner movement.");
    }
    return undefined;
  }
  return await requireActiveBankInCurrency(ctx, {
    orgId: args.orgId,
    bankAccountId: args.bankAccountId,
    currency: args.currency,
    missingMessage: "Select the physical bank for this partner movement. Nothing has been recorded.",
    currencySubject: "partner movement",
  });
}

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
  orgCurrency: string,
  opening: PartnerOpeningContext
): Promise<{ balanceMinor: number | null; balanceStatus: "VERIFIED" | "UNAVAILABLE"; transactionCount: number }> {
  const transactions = await ctx.db
    .query("partnerEquityTransactions")
    .withIndex("by_org_partner_time", (q) =>
      q.eq("orgId", partner.orgId).eq("partnerId", partner._id)
    )
    .collect();

  let delta = 0;
  let validMovements = true;
  for (const tx of transactions) {
    if (tx.currency !== orgCurrency || !Number.isSafeInteger(tx.amountMinor) || tx.amountMinor <= 0 ||
        (opening.parent && tx.occurredAt < opening.parent.asOfDate)) validMovements = false;
    delta += tx.type === "DRAW" ? -tx.amountMinor : tx.amountMinor;
  }
  const legacyBaseMinor = partner.openingBalanceMinor ??
    toMinorSameCurrencyOrUndefined(partner.currentBalance ?? 0, orgCurrency, orgCurrency) ?? Number.NaN;
  const basis = openingPartnerBasis(partner, orgCurrency, opening, legacyBaseMinor);
  const balanceMinor = basis.kind === "INVALID" ? null : basis.amountMinor + delta;
  if (!validMovements || !Number.isSafeInteger(balanceMinor)) {
    return { balanceMinor: null, balanceStatus: "UNAVAILABLE", transactionCount: transactions.length };
  }
  return { balanceMinor, balanceStatus: "VERIFIED", transactionCount: transactions.length };
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const opening = await loadPartnerOpening(ctx, args.orgId);
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
        const balance = await derivePartnerBalanceMinor(ctx, partner, currency, opening);
        return { ...partner, ...balance, currency };
      })
    );
    return { ...page, page: enriched };
  },
});

export const listTransactions = query({
  args: { orgId: v.id("organizations"), partnerId: v.id("partnerEquity") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireOwnedRow(ctx, args.orgId, "partnerEquity", args.partnerId, "Partner not found in this organization.");
    return await ctx.db
      .query("partnerEquityTransactions")
      .withIndex("by_org_partner_time", (q) =>
        q.eq("orgId", args.orgId).eq("partnerId", args.partnerId)
      )
      .order("desc")
      .collect();
  },
});

export const listBankOptions = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await listEligibleBanks(ctx, args.orgId, await getOrgCurrency(ctx, args.orgId));
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
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    // SCRUM-313 census. With an opening contribution this calls
    // `recordMovement`, which mints a `partnerEquityTransactions` id and posts
    // a CAPITAL_CONTRIBUTED event keyed on it, so a retry mints a new id, a new
    // key and a SECOND contribution journal.
    //
    // Identity is required UNCONDITIONALLY, not only when a contribution is
    // present. The command is only *conditionally* economic, and a compile-time
    // `economic: true | false` discriminant cannot express a runtime condition;
    // making it conditional would put the discriminant back at the mercy of a
    // payload value, which is the exact failure this design removes. Guarding
    // the whole command also removes the duplicate partner row a retry creates
    // even when no opening capital is supplied.
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!args.partnerName.trim()) {
      throw new ConvexError("Partner name is required.");
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "partnerEquity.add",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          partnerName: args.partnerName.trim(),
          openingContributionMinor: args.openingContributionMinor ?? null,
          paymentMethod: args.paymentMethod ?? null,
          // Omit an absent bank so keys issued before bank attribution keep
          // their original fingerprint across this deployment.
          bankAccountId: args.bankAccountId,
        }),
      },
      async () => {
        if (args.openingContributionMinor !== undefined &&
            (!Number.isSafeInteger(args.openingContributionMinor) || args.openingContributionMinor < 0)) {
          throw new ConvexError("Opening contribution must be a non-negative whole minor-unit amount.");
        }
        const hasContribution = (args.openingContributionMinor ?? 0) > 0;
        if (!hasContribution && args.bankAccountId) {
          throw new ConvexError("A bank account requires a positive opening contribution.");
        }
        const bankAccountId = hasContribution
          ? await validateMovementBank(ctx, {
              orgId: args.orgId,
              type: "CONTRIBUTION",
              paymentMethod: args.paymentMethod,
              bankAccountId: args.bankAccountId,
              currency: await getOrgCurrency(ctx, args.orgId),
            })
          : undefined;
        const partnerId = await ctx.db.insert("partnerEquity", {
          orgId: args.orgId,
          partnerName: args.partnerName.trim(),
          notes: args.notes,
        });

        if (hasContribution && args.openingContributionMinor !== undefined) {
          await recordMovement(ctx, {
            orgId: args.orgId,
            partnerId,
            type: "CONTRIBUTION",
            amountMinor: args.openingContributionMinor,
            paymentMethod: args.paymentMethod,
            bankAccountId,
            actorId: user._id,
          });
        }

        const actorName = await getActorName(ctx);
        await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
          link: `/${args.orgId}/accounting`,
        });

        return partnerId;
      }
    );
  },
});

async function recordMovement(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    partnerId: Id<"partnerEquity">;
    type: "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION";
    amountMinor: number;
    paymentMethod?: PaymentMethod;
    bankAccountId?: Id<"bankAccounts">;
    notes?: string;
    occurredAt?: number;
    actorId: Id<"users">;
    opening?: PartnerOpeningContext;
  }
): Promise<Id<"partnerEquityTransactions">> {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("Amount must be a positive integer minor-unit amount.");
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const occurredAt = args.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > Date.now()) {
    throw new ConvexError("Choose a valid partner movement date that is not in the future.");
  }
  const opening = args.opening ?? await loadPartnerOpening(ctx, args.orgId);
  const partner = await requireOwnedRow(ctx, args.orgId, "partnerEquity", args.partnerId, "Partner not found in this organization.");
  const legacyBase = partner.openingBalanceMinor ??
    toMinorSameCurrencyOrUndefined(partner.currentBalance ?? 0, currency, currency) ?? Number.NaN;
  if (openingPartnerBasis(partner, currency, opening, legacyBase).kind === "INVALID") {
    throw new ConvexError("The partner opening balance cannot be verified. Ask finance to review it.");
  }
  if (opening.parent && occurredAt < opening.parent.asOfDate) {
    throw new ConvexError("A partner movement cannot precede the posted opening date.");
  }
  // Use the exact predicate that postOrEnqueue uses. A CLOSING period is not
  // postable even though the general period guard has not marked it CLOSED.
  if (!(await shouldPost(ctx, args.orgId, occurredAt))) {
    throw new ConvexError("Set up accounting and open the period before recording a partner movement.");
  }

  const transactionId = await ctx.db.insert("partnerEquityTransactions", {
    orgId: args.orgId,
    partnerId: args.partnerId,
    type: args.type,
    amountMinor: args.amountMinor,
    currency,
    paymentMethod: args.paymentMethod,
    bankAccountId: args.bankAccountId,
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
    bankAccountId: args.bankAccountId,
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
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    notes: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    // SCRUM-313 census. `recordMovement` mints a `partnerEquityTransactions`
    // id and the equity hooks key their accounting event on it, so a retry
    // produces a second movement and a second journal. The DRAW balance check
    // is NOT a retry barrier: a repeated draw of 500 against 5,000 succeeds
    // twice, because the balance still permits it.
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (args.type === "PROFIT_DISTRIBUTION" && PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED) {
      throw new ConvexError(PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE.en);
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "partnerEquity.recordEquityMovement",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          partnerId: args.partnerId.toString(),
          type: args.type,
          amountMinor: args.amountMinor,
          paymentMethod: args.paymentMethod ?? null,
          bankAccountId: args.bankAccountId,
          occurredAt: args.occurredAt ?? null,
        }),
      },
      async () => {
        // A replay must return the first result even if that draw exhausted the
        // partner balance or the partner has since been removed.
        const partner = await requireOwnedRow(ctx, args.orgId, "partnerEquity", args.partnerId, "Partner not found in this organization.");
        if (partner.isDeleted) {
          throw new ConvexError("Partner not found in this organization.");
        }
        const currency = await getOrgCurrency(ctx, args.orgId);
        const opening = await loadPartnerOpening(ctx, args.orgId);
        const bankAccountId = await validateMovementBank(ctx, {
          orgId: args.orgId,
          type: args.type,
          paymentMethod: args.paymentMethod,
          bankAccountId: args.bankAccountId,
          currency,
        });
        if (args.type === "DRAW") {
          const { balanceMinor } = await derivePartnerBalanceMinor(ctx, partner, currency, opening);
          if (balanceMinor === null) throw new ConvexError("The partner balance cannot be verified. Ask finance to review it.");
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
          bankAccountId,
          notes: args.notes,
          occurredAt: args.occurredAt,
          actorId: user._id,
          opening,
        });

        const actorName = await getActorName(ctx);
        await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
          link: `/${args.orgId}/accounting`,
        });

        return transactionId;
      }
    );
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

    await requireOwnedRow(ctx, orgId, "partnerEquity", equityId, "Partner equity record not found in this organization.");

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
    const equity = await requireOwnedRow(ctx, args.orgId, "partnerEquity", args.equityId, "Partner equity record not found in this organization.");

    // A partner with GL-backed equity movements can't just vanish — their
    // capital is on the books. Pure legacy rows (no transactions) may still be
    // removed; migrating those balances is GL Phase 17's job.
    const currency = await getOrgCurrency(ctx, args.orgId);
    const opening = await loadPartnerOpening(ctx, args.orgId);
    const { balanceMinor, transactionCount } = await derivePartnerBalanceMinor(ctx, equity, currency, opening);
    if (balanceMinor === null) throw new ConvexError("The partner balance cannot be verified. Ask finance to review it.");
    if (equity.openingBalanceDraftId) throw new ConvexError("This partner belongs to the posted opening. Ask finance to review retirement.");
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
