import { defineTable } from "convex/server";
import { v } from "convex/values";

export const accountsReceivableTables = {
  // ─── Phase 3: Receivables, payments, and allocations subledger ────────────

  receivableDocuments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    documentType: v.union(
      v.literal("INVOICE"),
      v.literal("INSTALLMENT"),
      v.literal("DEBIT_ADJUSTMENT"),
      v.literal("CREDIT_ADJUSTMENT"),
      v.literal("WRITE_OFF"),
      v.literal("REFUND_PAYABLE"),
    ),
    documentNumber: v.string(),
    payerType: v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"), v.literal("MANUAL_FINANCE_COMPANY")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    /** SCRUM-27: set exactly when payerType is MANUAL_FINANCE_COMPANY (no party row exists). */
    payerNameSnapshot: v.optional(v.string()),
    sourceType: v.string(),
    sourceId: v.string(),
    originalAmountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    issueDate: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("WRITTEN_OFF"),
      v.literal("CANCELLED"),
      v.literal("REVERSED"),
    ),
    accountingEventId: v.optional(v.id("accountingEvents")),
    reversedDocumentId: v.optional(v.id("receivableDocuments")),
    createdAt: v.number(),
    createdBy: v.id("users"),
    // Set only when status transitions to CANCELLED (saleCancellation.ts).
    // Historical AR reports (arAging, subledgerReconciliation) need this to
    // tell "was open as of asOfDate, cancelled later" (still counts) apart
    // from "already cancelled by asOfDate" (must not count) — the receivable's
    // CURRENT status alone can't make that distinction for a past asOfDate.
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    cancellationReason: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_source_issueDate", ["orgId", "sourceType", "issueDate"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_dueDate", ["orgId", "dueDate"])
    // SCRUM-555 lane-B: getReceivablesAsOf (not-cancelled-by-asOf) without a
    // query filter.
    .index("by_org_cancelledAt_issueDate", ["orgId", "cancelledAt", "issueDate"]),

  canonicalPayments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    payerType: v.optional(v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"), v.literal("MANUAL_FINANCE_COMPANY"))),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    /** SCRUM-27: set exactly when payerType is MANUAL_FINANCE_COMPANY. */
    payerNameSnapshot: v.optional(v.string()),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CARD"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("INTERNAL_TRANSFER"),
      v.literal("TRADE_IN"),
      v.literal("OTHER"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    receivedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_VERIFICATION"),
      v.literal("VERIFIED"),
      v.literal("PENDING_SETTLEMENT"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("RETURNED"),
      v.literal("REVERSED"),
      v.literal("REFUNDED"),
      v.literal("VOIDED"),
    ),
    externalReference: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerTransactionId: v.optional(v.string()),
    idempotencyKey: v.string(),
    cashierSessionId: v.optional(v.id("cashierReconciliations")),
    originalPaymentId: v.optional(v.id("canonicalPayments")),
    reversalPaymentId: v.optional(v.id("canonicalPayments")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  paymentAllocations: defineTable({
    orgId: v.id("organizations"),
    paymentId: v.id("canonicalPayments"),
    receivableDocumentId: v.id("receivableDocuments"),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    allocationDate: v.number(),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("REVERSED"),
    ),
    reversalOfAllocationId: v.optional(v.id("paymentAllocations")),
    reversedByAllocationId: v.optional(v.id("paymentAllocations")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_payment", ["paymentId"])
    .index("by_receivable", ["receivableDocumentId"])
    .index("by_org_status", ["orgId", "status"]),
};
