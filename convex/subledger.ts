import { v, ConvexError } from "convex/values";
import { internalMutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { scaleForCurrency, assertValidMinorAmount, assertSameCurrency } from "./utils/money";
import { requireFeature } from "./subscriptions";

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getReceivableOutstandingMinor(
  ctx: QueryCtx | MutationCtx,
  receivableId: Id<"receivableDocuments">
): Promise<number> {
  const doc = await ctx.db.get(receivableId);
  if (!doc) throw new ConvexError("Receivable not found.");

  const activeAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();

  const allocated = activeAllocations.reduce((s, a) => s + a.amountMinor, 0);
  return Math.max(0, doc.originalAmountMinor - allocated);
}

async function getPaymentUnappliedMinor(
  ctx: QueryCtx | MutationCtx,
  paymentId: Id<"canonicalPayments">
): Promise<number> {
  const payment = await ctx.db.get(paymentId);
  if (!payment) throw new ConvexError("Payment not found.");

  const activeAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();

  const allocated = activeAllocations.reduce((s, a) => s + a.amountMinor, 0);
  return Math.max(0, payment.amountMinor - allocated);
}

export async function createReceivableDocument(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    documentType: "INVOICE" | "INSTALLMENT" | "DEBIT_ADJUSTMENT" | "CREDIT_ADJUSTMENT" | "WRITE_OFF" | "REFUND_PAYABLE";
    payerType: "CUSTOMER" | "FINANCE_COMPANY";
    customerId?: Id<"customers">;
    financeCompanyId?: Id<"financeCompanies">;
    sourceType: string;
    sourceId: string;
    originalAmountMinor: number;
    currency: string;
    issueDate: number;
    dueDate: number;
    actorId: Id<"users">;
    accountingEventId?: Id<"accountingEvents">;
    branchId?: Id<"branches">;
  }
): Promise<Id<"receivableDocuments">> {
  assertValidMinorAmount(args.originalAmountMinor, "originalAmountMinor");
  const currency = args.currency.toUpperCase();
  const scale = scaleForCurrency(currency);
  const now = Date.now();

  // Generate document number
  const countSoFar = (await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(1)).length;
  const docNumber = `REC-${new Date(now).getFullYear()}-${String(Date.now()).slice(-6)}`;

  return ctx.db.insert("receivableDocuments", {
    orgId: args.orgId,
    branchId: args.branchId,
    documentType: args.documentType,
    documentNumber: docNumber,
    payerType: args.payerType,
    customerId: args.customerId,
    financeCompanyId: args.financeCompanyId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    originalAmountMinor: args.originalAmountMinor,
    currency,
    scale,
    issueDate: args.issueDate,
    dueDate: args.dueDate,
    status: "OPEN",
    accountingEventId: args.accountingEventId,
    createdAt: now,
    createdBy: args.actorId,
  });
}

export async function ensureReceivableDocument(
  ctx: MutationCtx,
  args: Parameters<typeof createReceivableDocument>[1]
): Promise<Id<"receivableDocuments">> {
  const existing = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", args.sourceType).eq("sourceId", args.sourceId)
    )
    .unique();
  if (existing) return existing._id;
  return await createReceivableDocument(ctx, args);
}

export async function createCanonicalPayment(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    direction: "IN" | "OUT";
    payerType?: "CUSTOMER" | "FINANCE_COMPANY";
    customerId?: Id<"customers">;
    financeCompanyId?: Id<"financeCompanies">;
    method: "CASH" | "BANK_TRANSFER" | "CARD" | "PAYMENT_LINK" | "CHEQUE" | "INTERNAL_TRANSFER" | "OTHER";
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    actorId: Id<"users">;
    status?: "DRAFT" | "PENDING_VERIFICATION" | "VERIFIED" | "PENDING_SETTLEMENT" | "SETTLED";
    externalReference?: string;
    provider?: string;
    providerTransactionId?: string;
    receivedAt?: number;
    branchId?: Id<"branches">;
    cashierSessionId?: Id<"cashierReconciliations">;
    accountingEventId?: Id<"accountingEvents">;
  }
): Promise<Id<"canonicalPayments">> {
  assertValidMinorAmount(args.amountMinor, "amountMinor");
  const currency = args.currency.toUpperCase();
  const scale = scaleForCurrency(currency);
  const now = Date.now();

  // Idempotency check
  const existing = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  if (existing) return existing._id;

  return ctx.db.insert("canonicalPayments", {
    orgId: args.orgId,
    branchId: args.branchId,
    direction: args.direction,
    payerType: args.payerType,
    customerId: args.customerId,
    financeCompanyId: args.financeCompanyId,
    method: args.method,
    amountMinor: args.amountMinor,
    currency,
    scale,
    status: args.status ?? "SETTLED",
    idempotencyKey: args.idempotencyKey,
    externalReference: args.externalReference,
    provider: args.provider,
    providerTransactionId: args.providerTransactionId,
    receivedAt: args.receivedAt ?? now,
    cashierSessionId: args.cashierSessionId,
    accountingEventId: args.accountingEventId,
    createdBy: args.actorId,
    createdAt: now,
  });
}

export async function allocatePaymentToReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    paymentId: Id<"canonicalPayments">;
    receivableDocumentId: Id<"receivableDocuments">;
    amountMinor: number;
    actorId: Id<"users">;
  }
): Promise<Id<"paymentAllocations">> {
  const payment = await ctx.db.get(args.paymentId);
  if (!payment || payment.orgId !== args.orgId) throw new ConvexError("Payment not found.");

  const receivable = await ctx.db.get(args.receivableDocumentId);
  if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");

  // Only money actually received and settled can pay down a receivable — an
  // OUT payment (e.g. a deposit refund) or a DRAFT/unsettled one must never be
  // allocatable, or the receivable would show as paid with no funds received.
  if (payment.direction !== "IN") {
    throw new ConvexError("Only inbound payments can be allocated to a receivable.");
  }
  if (payment.status !== "SETTLED") {
    throw new ConvexError("Only settled payments can be allocated to a receivable.");
  }
  // Both sides carry payer identity only when known at creation time — only
  // compare when both are set, so unattributed cash collections (no payer
  // captured yet) can still be allocated by staff judgment; a genuine mismatch
  // between two known identities is always rejected.
  if (payment.payerType && receivable.payerType && payment.payerType !== receivable.payerType) {
    throw new ConvexError("Payment payer type does not match the receivable's payer type.");
  }
  if (payment.customerId && receivable.customerId && payment.customerId !== receivable.customerId) {
    throw new ConvexError("Payment customer does not match the receivable's customer.");
  }
  if (
    payment.financeCompanyId &&
    receivable.financeCompanyId &&
    payment.financeCompanyId !== receivable.financeCompanyId
  ) {
    throw new ConvexError("Payment finance company does not match the receivable's finance company.");
  }

  assertSameCurrency(payment.currency, receivable.currency, "payment allocation");
  assertValidMinorAmount(args.amountMinor, "allocation amount");

  if (args.amountMinor <= 0) throw new ConvexError("Allocation amount must be positive.");

  const unapplied = await getPaymentUnappliedMinor(ctx, args.paymentId);
  if (args.amountMinor > unapplied) {
    throw new ConvexError(
      `Allocation amount ${args.amountMinor} exceeds unapplied payment balance ${unapplied}.`
    );
  }

  const outstanding = await getReceivableOutstandingMinor(ctx, args.receivableDocumentId);
  if (args.amountMinor > outstanding) {
    throw new ConvexError(
      `Allocation amount ${args.amountMinor} exceeds receivable outstanding balance ${outstanding}.`
    );
  }

  const now = Date.now();
  const allocationId = await ctx.db.insert("paymentAllocations", {
    orgId: args.orgId,
    paymentId: args.paymentId,
    receivableDocumentId: args.receivableDocumentId,
    amountMinor: args.amountMinor,
    currency: payment.currency,
    scale: payment.scale,
    allocationDate: now,
    status: "ACTIVE",
    createdBy: args.actorId,
    createdAt: now,
  });

  // Update receivable status
  const newOutstanding = outstanding - args.amountMinor;
  await ctx.db.patch(args.receivableDocumentId, {
    status: newOutstanding === 0 ? "PAID" : "PARTIALLY_PAID",
  });

  return allocationId;
}

/**
 * Marks a canonical payment VOIDED (recorded in error — no money actually
 * moved, unlike a refund which pays money back out). Refuses to void a payment
 * that still has ACTIVE allocations; callers must reverse those first so
 * receivable balances stay consistent.
 */
export async function voidCanonicalPayment(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    paymentId: Id<"canonicalPayments">;
    actorId: Id<"users">;
  }
): Promise<void> {
  const payment = await ctx.db.get(args.paymentId);
  if (!payment || payment.orgId !== args.orgId) throw new ConvexError("Payment not found.");
  if (payment.status === "VOIDED") return;

  const activeAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
  if (activeAllocations.length > 0) {
    throw new ConvexError("Cannot void a payment with active allocations — reverse them first.");
  }

  await ctx.db.patch(args.paymentId, { status: "VOIDED" });
}

export async function reverseAllocation(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    allocationId: Id<"paymentAllocations">;
    actorId: Id<"users">;
  }
): Promise<Id<"paymentAllocations">> {
  const allocation = await ctx.db.get(args.allocationId);
  if (!allocation || allocation.orgId !== args.orgId) throw new ConvexError("Allocation not found.");
  if (allocation.status === "REVERSED") throw new ConvexError("Allocation is already reversed.");

  const now = Date.now();
  const reversalId = await ctx.db.insert("paymentAllocations", {
    orgId: args.orgId,
    paymentId: allocation.paymentId,
    receivableDocumentId: allocation.receivableDocumentId,
    amountMinor: allocation.amountMinor,
    currency: allocation.currency,
    scale: allocation.scale,
    allocationDate: now,
    status: "REVERSED",
    reversalOfAllocationId: args.allocationId,
    createdBy: args.actorId,
    createdAt: now,
  });
  await ctx.db.patch(args.allocationId, { status: "REVERSED", reversedByAllocationId: reversalId });

  // Recompute receivable status
  const outstanding = await getReceivableOutstandingMinor(ctx, allocation.receivableDocumentId);
  const receivable = await ctx.db.get(allocation.receivableDocumentId);
  if (receivable) {
    await ctx.db.patch(allocation.receivableDocumentId, {
      status: outstanding >= receivable.originalAmountMinor ? "OPEN" : outstanding > 0 ? "PARTIALLY_PAID" : "PAID",
    });
  }

  return reversalId;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listReceivables = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.optional(v.id("customers")),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const limit = Math.min(args.limit ?? 50, 200);

    if (args.customerId) {
      return ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .take(limit);
    }
    if (args.status) {
      return ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status as "OPEN" | "PARTIALLY_PAID" | "PAID" | "WRITTEN_OFF" | "CANCELLED" | "REVERSED"))
        .take(limit);
    }
    return ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(limit);
  },
});

export const getReceivableBalance = query({
  args: { orgId: v.id("organizations"), receivableDocumentId: v.id("receivableDocuments") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const doc = await ctx.db.get(args.receivableDocumentId);
    if (!doc || doc.orgId !== args.orgId) return null;
    const outstandingMinor = await getReceivableOutstandingMinor(ctx, args.receivableDocumentId);
    return { doc, outstandingMinor };
  },
});

export const getPaymentBalance = query({
  args: { orgId: v.id("organizations"), paymentId: v.id("canonicalPayments") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const payment = await ctx.db.get(args.paymentId);
    if (!payment || payment.orgId !== args.orgId) return null;
    const unappliedMinor = await getPaymentUnappliedMinor(ctx, args.paymentId);
    return { payment, unappliedMinor };
  },
});

export const listAllocations = query({
  args: {
    orgId: v.id("organizations"),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    paymentId: v.optional(v.id("canonicalPayments")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    if (args.receivableDocumentId) {
      return ctx.db.query("paymentAllocations").withIndex("by_receivable", (q) => q.eq("receivableDocumentId", args.receivableDocumentId!)).collect();
    }
    if (args.paymentId) {
      return ctx.db.query("paymentAllocations").withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId!)).collect();
    }
    return [];
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────
//
// These four are internalMutation, not mutation: every production flow already
// calls the underlying createReceivableDocument/createCanonicalPayment/
// allocatePaymentToReceivable/reverseAllocation helpers directly, paired with a
// workflowHooks.ts GL-posting call in the same transaction (saleCompletion.ts,
// claims.ts, deposits.ts, paymentIntents.ts, collections.ts, applications.ts).
// If these were public, any MANAGE_FINANCE user could call them straight from
// the client and write subledger state with no corresponding GL entry, since
// none of these handlers post to the ledger themselves — desyncing the GL from
// the subledger with no trace. Keep them internal-only; a genuine ad-hoc/
// back-office use case should get its own hookXxx-calling wrapper, not expose
// these raw building blocks.

export const createReceivable = internalMutation({
  args: {
    orgId: v.id("organizations"),
    documentType: v.union(
      v.literal("INVOICE"), v.literal("INSTALLMENT"), v.literal("DEBIT_ADJUSTMENT"),
      v.literal("CREDIT_ADJUSTMENT"), v.literal("WRITE_OFF"), v.literal("REFUND_PAYABLE"),
    ),
    payerType: v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    sourceType: v.string(),
    sourceId: v.string(),
    originalAmountMinor: v.number(),
    currency: v.string(),
    issueDate: v.number(),
    dueDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return createReceivableDocument(ctx, { ...args, actorId: user._id });
  },
});

export const recordPayment = internalMutation({
  args: {
    orgId: v.id("organizations"),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    customerId: v.optional(v.id("customers")),
    method: v.union(
      v.literal("CASH"), v.literal("BANK_TRANSFER"), v.literal("CARD"),
      v.literal("PAYMENT_LINK"), v.literal("CHEQUE"), v.literal("INTERNAL_TRANSFER"), v.literal("OTHER"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return createCanonicalPayment(ctx, { ...args, actorId: user._id });
  },
});

export const allocate = internalMutation({
  args: {
    orgId: v.id("organizations"),
    paymentId: v.id("canonicalPayments"),
    receivableDocumentId: v.id("receivableDocuments"),
    amountMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return allocatePaymentToReceivable(ctx, { ...args, actorId: user._id });
  },
});

export const reverseAllocationMutation = internalMutation({
  args: {
    orgId: v.id("organizations"),
    allocationId: v.id("paymentAllocations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return reverseAllocation(ctx, { ...args, actorId: user._id });
  },
});
