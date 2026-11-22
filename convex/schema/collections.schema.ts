import { defineTable } from "convex/server";
import { v } from "convex/values";

const collectionsRecordTrackingFields = {
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  isDeleted: v.optional(v.boolean()),
  deletedAt: v.optional(v.number()),
  deletedBy: v.optional(v.string()),
};

export const collectionsTables = {
  // Receipt voucher (سند قبض) auto-generated as proof of payment whenever a
  // deposit is recorded — one per deposit.
  paymentVouchers: defineTable({
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    voucherNumber: v.string(),
    customerId: v.id("customers"),
    customerNameSnapshot: v.string(),
    descriptionAr: v.string(),
    amount: v.number(),
    amountMinor: v.number(),
    currency: v.string(),
    issuedAt: v.number(),
    issuedBy: v.id("users"),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_deposit", ["depositId"])
    .index("by_customer", ["customerId"]),

  receivables: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    sourceType: v.union(
      v.literal("CUSTOMER_DEPOSIT"),
      v.literal("RESERVATION_PAYMENT"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("BANK_FINANCED_BALANCE"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    ),
    title: v.string(),
    originalAmount: v.number(),
    outstandingAmount: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("OVERDUE"),
      v.literal("RESCHEDULED"),
      v.literal("CANCELLED"),
      v.literal("REFUNDED")
    ),
    installmentNumber: v.optional(v.number()),
    totalInstallments: v.optional(v.number()),
    paymentPlanLabel: v.optional(v.string()),
    assignedTo: v.optional(v.id("users")),
    canonicalReceivableDocumentId: v.optional(v.id("receivableDocuments")),
    openingBalanceDraftId: v.optional(v.id("openingBalanceDrafts")),
    lastReminderAt: v.optional(v.number()),
    lastPaymentAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    ...collectionsRecordTrackingFields,
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_dueDate", ["orgId", "status", "dueDate"])
    .index("by_org_status_isDeleted_dueDate", ["orgId", "status", "isDeleted", "dueDate"])
    .index("by_org_dueDate", ["orgId", "dueDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_sale", ["saleId"])
    .index("by_quote", ["quoteId"])
    .index("by_application", ["applicationId"])
    .index("by_assignedTo", ["assignedTo"]),

  collectionPayments: defineTable({
    orgId: v.id("organizations"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    chequeId: v.optional(v.id("postDatedCheques")),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    paymentAllocationId: v.optional(v.id("paymentAllocations")),
    reconciliationId: v.optional(v.id("cashierReconciliations")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("DEPOSIT_APPLIED"),
      v.literal("REFUND"),
      v.literal("OTHER")
    ),
    amount: v.number(),
    paymentDate: v.number(),
    // SCRUM-264: what `paymentDate` IS, written by the writer that stored it. "calendarKey" is the UTC
    // midnight of a picked calendar date (TC39 PlainDate idea), "instant" is a real moment, "saleDate"
    // is a sale's date passed in by sale completion, which is a key from one screen and an instant from
    // another. Optional: rows written before this field exist have none, and are classified from the
    // row's own footprint (utils/orgBusinessDay.ts paymentDateProvenance). Never inferred from
    // createdAt when this is present.
    paymentDateKind: v.optional(
      v.union(v.literal("calendarKey"), v.literal("instant"), v.literal("saleDate"))
    ),
    status: v.union(
      v.literal("POSTED"),
      v.literal("PENDING_CLEARANCE"),
      v.literal("VOIDED")
    ),
    idempotencyKey: v.optional(v.string()),
    reference: v.optional(v.string()),
    cashierId: v.id("users"),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_paymentDate", ["orgId", "paymentDate"])
    .index("by_receivable", ["receivableId"])
    .index("by_org_customer", ["orgId", "customerId"])
    // SCRUM-259: a cashier's UNRECONCILED, POSTED payments of one method for a
    // business day, read as a bounded range rather than a prefix of everything
    // they ever took. Replaces by_org_cashier, whose only readers these were.
    .index("by_org_cashier_unreconciled_method_date", ["orgId", "cashierId", "reconciliationId", "status", "method", "paymentDate"])
    .index("by_reconciliation", ["reconciliationId"])
    .index("by_cheque", ["chequeId"]),

  postDatedCheques: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    // Customer invoice intent; legacy saleId remains absent when this cheque clears.
    invoiceSaleId: v.optional(v.id("sales")),
    // Set when this cheque is the registered expected-payment method for a
    // finance application, ahead of finalizeDeal — see registerExpectedPayment.
    //
    // SCRUM-447 D0 — PERMANENT LINEAGE. Once set, no writer clears it: it marks
    // the cheque as a finance-company instrument for the rest of its life, and
    // "active" is a STATUS question (HELD / DEPOSITED), never "is this set".
    applicationId: v.optional(v.id("financeApplications")),
    // SCRUM-447 D1 — the cheque's FACE, as the operator recorded it (or as
    // `attestChequeFace` attested it), in minor units of `currency`. `amount`
    // stays the legacy display figure. A row with no `amountMinor` has an
    // UNAVAILABLE face and can never be cleared by confirmDisbursement.
    amountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    faceAttestedBy: v.optional(v.id("users")),
    faceAttestedAt: v.optional(v.number()),
    // SCRUM-447 B4: the operator's stated reason the attested face is correct.
    faceAttestationNote: v.optional(v.string()),
    // SCRUM-447 D2 — who drew it. Absent on an application-linked row means the
    // drawer is UNVERIFIED (history cannot prove it), never "the customer".
    drawerType: v.optional(v.literal("FINANCE_COMPANY")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    // Immutable lineage anchor: the application this cheque was ever opened for.
    originApplicationId: v.optional(v.id("financeApplications")),
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    cancellationReason: v.optional(v.string()),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    depositedDate: v.optional(v.number()),
    status: v.union(
      v.literal("HELD"),
      v.literal("DEPOSITED"),
      v.literal("CLEARED"),
      v.literal("RETURNED"),
      v.literal("REPLACED"),
      v.literal("CANCELLED")
    ),
    replacementChequeId: v.optional(v.id("postDatedCheques")),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
    clearedAt: v.optional(v.number()),
    returnedAfterClearing: v.optional(v.boolean()),
    // SCRUM-239: the application disbursement version this FC cheque cleared under.
    disbursementVersion: v.optional(v.number()),
    bankFeeMinor: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    ...collectionsRecordTrackingFields,
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_chequeDate", ["orgId", "status", "chequeDate"])
    .index("by_org_status_isDeleted_chequeDate", ["orgId", "status", "isDeleted", "chequeDate"])
    .index("by_org_chequeDate", ["orgId", "chequeDate"])
    .index("by_org_bank_and_chequeNumber", ["orgId", "bank", "chequeNumber"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_receivable", ["receivableId"])
    .index("by_replacementCheque", ["replacementChequeId"])
    .index("by_application", ["applicationId"]),

  cashierReconciliations: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    cashierId: v.id("users"),
    businessDate: v.number(),
    expectedCash: v.number(),
    countedCash: v.number(),
    difference: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("SUBMITTED"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_businessDate", ["orgId", "businessDate"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_cashier", ["orgId", "cashierId"]),

  collectionApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    receivableId: v.id("receivables"),
    customerId: v.id("customers"),
    requestedBy: v.id("users"),
    requestType: v.union(
      v.literal("REFUND"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL_RECEIVABLE")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    disbursementMethod: v.optional(v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("CARD")
    )),
    reason: v.string(),
    decisionNotes: v.optional(v.string()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    responseIdempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_receivable", ["receivableId"])
    .index("by_requestedBy", ["requestedBy"])
    .index("by_org_customer", ["orgId", "customerId"]),

  collectionReminders: defineTable({
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    chequeId: v.optional(v.id("postDatedCheques")),
    customerId: v.id("customers"),
    channel: v.union(
      v.literal("WHATSAPP"),
      v.literal("SMS"),
      v.literal("EMAIL"),
      v.literal("MANUAL")
    ),
    messageType: v.union(
      v.literal("DUE_SOON"),
      v.literal("OVERDUE"),
      v.literal("CHEQUE_UPCOMING"),
      v.literal("CHEQUE_RETURNED")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SENT"),
      v.literal("FAILED"),
      v.literal("SKIPPED")
    ),
    scheduledAt: v.number(),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status_and_scheduledAt", ["orgId", "status", "scheduledAt"])
    .index("by_receivable", ["receivableId"])
    .index("by_cheque", ["chequeId"])
    // SCRUM-807: the reminder cooldown asks "is there a PENDING/SENT/SKIPPED row
    // of this message type for this one document, newer than X" - an exact
    // range per status, not a read of the document's whole reminder history.
    .index("by_receivable_and_messageType_and_status_and_createdAt", ["receivableId", "messageType", "status", "createdAt"])
    .index("by_cheque_and_messageType_and_status_and_createdAt", ["chequeId", "messageType", "status", "createdAt"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // Payment intents for payment-link / provider-initiated payments.
  // One intent per customer payment request. Fulfilled by provider webhook.
  paymentIntents: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    receivableId: v.optional(v.id("receivables")),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    saleId: v.optional(v.id("sales")),
    amountMinor: v.number(),
    currency: v.string(),
    provider: v.string(),
    externalId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    collectionPaymentId: v.optional(v.id("collectionPayments")),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    paymentAllocationId: v.optional(v.id("paymentAllocations")),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("EXPIRED"),
      v.literal("REFUNDED"),
      // SCRUM-571 S1 (D-22): the provider reported a capture for this link that
      // AutoFlow has neither settled nor applied; the capture sits in
      // `unmatchedProviderFunds` (heldFundsId). Terminal: never reserved as
      // collectible, never shown as unpaid, never expirable.
      v.literal("CAPTURE_HELD")
    ),
    heldFundsId: v.optional(v.id("unmatchedProviderFunds")),
    // D-22: operator attestation recorded by `expire` that the provider shows no payment.
    providerStatusCheckedAt: v.optional(v.number()),
    providerStatusCheckedBy: v.optional(v.id("users")),
    idempotencyKey: v.string(),
    providerPayload: v.optional(v.any()),
    providerEventId: v.optional(v.string()),
    providerEventType: v.optional(v.string()),
    providerSignatureVerifiedAt: v.optional(v.number()),
    providerAmountMinor: v.optional(v.number()),
    providerCurrency: v.optional(v.string()),
    settledAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_external_id", ["provider", "externalId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_receivable", ["receivableId"]),

  // SCRUM-571 D-8 — a signature-verified provider capture that did NOT settle an
  // intent. `paymentIntents.settleByExternalId` answers the provider 200 only
  // after the capture has a durable outcome: exactly one settlement, OR exactly
  // one row here. A row is finance-visible evidence that money moved at the
  // provider and needs a human decision. It is NOT a receivable, an allocation,
  // a canonical payment or a posting, and nothing here ever creates one: the
  // money is reconciled manually through the existing receipt doors, and
  // `resolveUnmatchedProviderFunds` only records that a person did so.
  //
  // One row per capture, keyed (provider, externalId): redelivery bumps
  // `deliveryCount` instead of inserting. `orgId` is absent only for
  // UNKNOWN_REFERENCE, where no tenant can be named.
  unmatchedProviderFunds: defineTable({
    orgId: v.optional(v.id("organizations")),
    provider: v.string(),
    externalId: v.string(),
    intentId: v.optional(v.id("paymentIntents")),
    reason: v.union(
      v.literal("UNKNOWN_REFERENCE"),
      v.literal("INTENT_NOT_PENDING"),
      v.literal("AMOUNT_OR_ACCOUNT_MISMATCH"),
      v.literal("LIFECYCLE_REFUSED"),
      // SCRUM-571 S1 (D-20): payment links are shut; a verified capture is held, not settled.
      v.literal("PAYMENT_LINKS_DISABLED")
    ),
    intentStatusAtReceipt: v.optional(v.string()),
    amountMinor: v.number(),
    currency: v.string(),
    providerAccountId: v.optional(v.string()),
    // Bounded: the 20 most recent distinct provider event ids.
    providerEventIds: v.array(v.string()),
    deliveryCount: v.number(),
    // A later delivery of the same capture carried a different amount/currency.
    amountConflict: v.boolean(),
    reviewStatus: v.union(v.literal("OPEN"), v.literal("RESOLVED")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    resolutionNote: v.optional(v.string()),
    firstReceivedAt: v.number(),
    lastReceivedAt: v.number(),
  })
    .index("by_provider_external", ["provider", "externalId"])
    .index("by_org_review", ["orgId", "reviewStatus"]),
};
