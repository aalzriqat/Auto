import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { ensureReceivableDocument, createCanonicalPayment, allocatePaymentToReceivable } from "./subledger";
import { hookClaimSettled, hookClaimWrittenOff, getOrgCurrency } from "./accounting/workflowHooks";

const CLAIM_DUE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const paymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CARD"),
  v.literal("CHEQUE"),
);

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

/**
 * GL Phase 13: creating a claim opens a finance-company receivable in the
 * subledger. Claims always start PENDING — settlement and rejection are the
 * only status transitions, each with its own GL posting; the old free-form
 * status arg is gone.
 */
export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    claimDate: v.number(),
    financingEntity: v.string(),
    buyerName: v.string(),
    claimAmountMinor: v.number(),
    notes: v.optional(v.string()),
    saleId: v.optional(v.id("sales")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!Number.isSafeInteger(args.claimAmountMinor) || args.claimAmountMinor <= 0) {
      throw new ConvexError("Claim amount must be a positive integer minor-unit amount.");
    }
    if (args.saleId) {
      const sale = await ctx.db.get(args.saleId);
      if (!sale || sale.orgId !== args.orgId) {
        throw new ConvexError("Sale not found in this organization.");
      }
    }

    const currency = await getOrgCurrency(ctx, args.orgId);

    const claimId = await ctx.db.insert("claims", {
      orgId: args.orgId,
      claimDate: args.claimDate,
      financingEntity: args.financingEntity,
      buyerName: args.buyerName,
      claimAmountMinor: args.claimAmountMinor,
      currency,
      status: "PENDING",
      notes: args.notes,
      saleId: args.saleId,
    });

    // Claims have no contractual due date of their own; 30 days is the
    // conventional settlement window and only drives aging buckets.
    const receivableDocumentId = await ensureReceivableDocument(ctx, {
      orgId: args.orgId,
      documentType: "INVOICE",
      payerType: "FINANCE_COMPANY",
      sourceType: "claims",
      sourceId: claimId.toString(),
      originalAmountMinor: args.claimAmountMinor,
      currency,
      issueDate: args.claimDate,
      dueDate: args.claimDate + CLAIM_DUE_DAYS_MS,
      actorId: user._id,
    });
    await ctx.db.patch(claimId, { receivableDocumentId });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${args.buyerName} (${args.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );

    return claimId;
  },
});

/**
 * Settles a PENDING claim in full: records the canonical inbound payment,
 * allocates it against the claim's receivable, and posts DR Bank-or-cash /
 * CR Finance-company AR.
 */
export const settle = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    paymentMethod: paymentMethodValidator,
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.orgId !== args.orgId || claim.isDeleted) {
      throw new ConvexError("Claim not found in this organization.");
    }
    if (claim.status !== "PENDING") {
      throw new ConvexError(`Only a PENDING claim can be settled (this one is ${claim.status}).`);
    }
    if (claim.claimAmountMinor == null) {
      throw new ConvexError("This claim predates GL Phase 13 and has no minor-unit amount on record; it cannot be settled through this flow.");
    }

    const occurredAt = args.occurredAt ?? Date.now();
    const currency = claim.currency ?? (await getOrgCurrency(ctx, args.orgId));

    const paymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      direction: "IN",
      payerType: "FINANCE_COMPANY",
      method: args.paymentMethod,
      amountMinor: claim.claimAmountMinor,
      currency,
      idempotencyKey: `claim_settlement_${args.claimId}`,
      actorId: user._id,
      receivedAt: occurredAt,
    });

    if (claim.receivableDocumentId) {
      await allocatePaymentToReceivable(ctx, {
        orgId: args.orgId,
        paymentId,
        receivableDocumentId: claim.receivableDocumentId,
        amountMinor: claim.claimAmountMinor,
        actorId: user._id,
      });
    }

    await hookClaimSettled(ctx, {
      orgId: args.orgId,
      claimId: args.claimId,
      amountMinor: claim.claimAmountMinor,
      currency,
      paymentMethod: args.paymentMethod,
      actorId: user._id,
      occurredAt,
    });

    await ctx.db.patch(args.claimId, {
      status: "PAID",
      settledAt: occurredAt,
      settledBy: user._id,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );
  },
});

/**
 * Rejects a PENDING claim: writes the receivable off the books with a
 * balanced DR Claim Write-off Expense / CR Finance-company AR entry.
 * Pre-Phase-13 legacy claims (no minor-unit amount, no receivable) just flip
 * status — they never had a GL presence to unwind.
 */
export const reject = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.orgId !== args.orgId || claim.isDeleted) {
      throw new ConvexError("Claim not found in this organization.");
    }
    if (claim.status !== "PENDING") {
      throw new ConvexError(`Only a PENDING claim can be rejected (this one is ${claim.status}).`);
    }

    const occurredAt = args.occurredAt ?? Date.now();

    if (claim.receivableDocumentId) {
      await ctx.db.patch(claim.receivableDocumentId, { status: "WRITTEN_OFF" });
    }

    if (claim.claimAmountMinor != null) {
      const currency = claim.currency ?? (await getOrgCurrency(ctx, args.orgId));
      await hookClaimWrittenOff(ctx, {
        orgId: args.orgId,
        claimId: args.claimId,
        amountMinor: claim.claimAmountMinor,
        currency,
        actorId: user._id,
        occurredAt,
      });
    }

    await ctx.db.patch(args.claimId, {
      status: "REJECTED",
      rejectedAt: occurredAt,
      rejectedBy: user._id,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );
  },
});

/** Notes only — status transitions go through settle/reject (GL Phase 13 event-driven rule). */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.orgId !== args.orgId) {
      throw new ConvexError("Claim not found in this organization.");
    }

    if (args.notes !== undefined) {
      await ctx.db.patch(args.claimId, { notes: args.notes });
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.orgId !== args.orgId) {
      throw new ConvexError("Claim not found in this organization.");
    }
    // A pending claim with a receivable has open AR on the books — settling
    // or rejecting is the only GL-safe exit (mirrors fixedAssets.remove).
    if (claim.status === "PENDING" && claim.receivableDocumentId) {
      throw new ConvexError("This claim has an open receivable on the ledger. Settle or reject it instead of deleting it.");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.claimId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );
  },
});
