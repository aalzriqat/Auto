import { defineTable } from "convex/server";
import { v } from "convex/values";
import { costBearerValidator } from "../utils/costBearer";

export const treasuryTables = {
  transactions: defineTable({
    /**
     * Accounting turnover for this row, when it differs from `amount`.
     *
     * `amount` is the cash side of the row — the sale price less anything
     * already collected against the deal. On a consigned sale the deal is a car
     * the dealership never owned, so its value is NOT its revenue. All three
     * numbers are real and none substitutes for another: the dealership
     * genuinely handled a 12,500 transaction, genuinely earned 3,000 on it, and
     * genuinely banked 9,500 at completion after a 3,000 deposit.
     *
     * Absent means the two are the same, which is every owned sale and every
     * row written before consigned accounting existed — so a reader that falls
     * back to `amount` gets the right answer for all of them.
     */
    recognizedRevenueAmount: v.optional(v.number()),
    /**
     * Cash received that is NOT revenue — a عربون against a liability.
     *
     * Written only on rows created after revenue recognition was separated
     * from cash movement, and it is what makes that separation deployable
     * without rewriting the back-book. `getProfitAndLoss` counted DEPOSIT as
     * revenue and compensated by writing the sale net of what was already
     * collected, which only reconciles when deposit and sale fall in one
     * period: a عربون in January and its sale in February reported revenue in
     * January for a car that had not been sold, and understated February by
     * the same amount.
     *
     * Simply dropping DEPOSIT from the revenue set would have understated every
     * historical period instead, because those sale rows are still net. So the
     * P&L excludes only the rows carrying this flag; anything without it keeps
     * the arithmetic it was written under and reads exactly as it does today.
     * Correcting the back-book is a separate, reviewed migration — see
     * `depositRevenueImpact`.
     */
    excludedFromRevenue: v.optional(v.boolean()),
    /**
     * The full ticket the deal was transacted at, before anything already
     * collected was netted off `amount`.
     *
     * `amount` is net of deposits, so reading it as gross transaction value
     * made a deposit REDUCE the reported size of a deal. See
     * utils/grossTransactionValue for the one definition all three reports use.
     */
    grossTransactionValueAmount: v.optional(v.number()),
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(), // Timestamp
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(), // "البيان"
    idempotencyKey: v.optional(v.string()),
    // Optional links to operational entities
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
    /**
     * The sale this row was written for — exact provenance, SCRUM-212.
     *
     * `voidSaleCashflowTransaction` used to find a sale's cashflow row by
     * (orgId, vehicleId, category, customerId). That tuple does not identify a
     * sale: the same customer buying the same car twice produces two rows each
     * matching the other's criteria, so tearing down the first voided the
     * second's live revenue — dropping it out of the P&L while its journal,
     * receivable and sale row all stayed live.
     *
     * Written by `createSaleTransaction` only. A row without it is not
     * sale-owned and is never voided by a sale cancellation.
     */
    saleId: v.optional(v.id("sales")),
    depositId: v.optional(v.id("deposits")),
    userId: v.optional(v.id("users")), // For partner draws/salaries
    expenseId: v.optional(v.id("expenses")),
    /**
     * SCRUM-389 — copied from the expense at the same write. The P&L reads
     * this table, not `expenses`, so without it a supplier-borne cost would be
     * counted as COGS. Absent means SHOWROOM (every row written before it).
     */
    costBearer: v.optional(costBearerValidator),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "date"])
    // Dashboard sale-ledger fallback: live VEHICLE_SALE inflows in date order,
    // so the read never scans the org's other transactions (or deleted ones).
    .index("by_org_category_type_deleted_date", ["orgId", "category", "type", "isDeleted", "date"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_customer", ["orgId", "customerId"])
    // Cancellation finds a sale's own cashflow rows by the sale itself.
    // Searching the vehicle range and filtering on category meant an edit to
    // either field moved a row out of reach while it kept its `saleId`, so a
    // cancelled deal could leave live revenue behind — SCRUM-212-R2.
    .index("by_org_sale", ["orgId", "saleId"]),

  // A bank-control aggregate is usable only after the organization, chart
  // mapping and reset generation behind it have been fully validated.
  bankBalanceAggregateStates: defineTable({
    orgId: v.id("organizations"),
    controlAccountId: v.id("chartOfAccounts"),
    mappingGeneration: v.number(),
    resetGeneration: v.number(),
    status: v.union(v.literal("READY"), v.literal("BACKFILL_REQUIRED"), v.literal("BACKFILLING")),
    cursor: v.optional(v.string()),
    // Tree layout the state certifies; absent means the original single-tree layout.
    layout: v.optional(v.number()),
    // Legacy; written as 0 on rebuild. Gross flow lives in bankBalanceGrossShards.
    grossAbsMinor: v.number(),
    updatedAt: v.number(),
  }).index("by_org", ["orgId"]),

  // Sharded gross absolute bank flow per aggregate namespace, so concurrent
  // postings in one org write different documents. Each shard is capped at its
  // share of the safe-integer range (see bankAggregateTriggers.ts).
  bankBalanceGrossShards: defineTable({
    orgId: v.id("organizations"),
    namespace: v.string(),
    shard: v.number(),
    grossAbsMinor: v.number(),
  })
    .index("by_namespace_shard", ["namespace", "shard"])
    .index("by_org", ["orgId"]),

  // Transactional membership record for each line projected into the two
  // component trees. The backfill and live trigger share this exact-once key.
  bankBalanceAggregateItems: defineTable({
    orgId: v.id("organizations"),
    journalLineId: v.id("journalLines"),
    namespace: v.string(),
    accountId: v.id("chartOfAccounts"),
    currency: v.string(),
    accountingDate: v.number(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    netMinor: v.number(),
    absMinor: v.number(),
  })
    .index("by_line", ["journalLineId"])
    .index("by_org", ["orgId"]),

  // GL Phase 15: full cash-drawer lifecycle. Distinct from the simpler,
  // pre-existing cashierReconciliations (open-float-free count-vs-expected
  // snapshot with no movement ledger) — this is the fuller open→count→
  // close→approve lifecycle with its own movement log, per the phase spec.
  cashDrawerSessions: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    openingFloatMinor: v.number(),
    currency: v.string(),
    openedBy: v.id("users"),
    openedAt: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("COUNTING"),
      v.literal("CLOSED"),
      v.literal("APPROVED"),
    ),
    closingCountMinor: v.optional(v.number()),
    varianceMinor: v.optional(v.number()),
    closedBy: v.optional(v.id("users")),
    closedAt: v.optional(v.number()),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_branch_status", ["orgId", "branchId", "status"]),

  // Append-only activity log behind a session's expected-cash computation.
  cashMovements: defineTable({
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
    type: v.union(
      v.literal("SALE"),
      v.literal("PAYOUT"),
      v.literal("HANDOVER"),
      v.literal("BANK_DEPOSIT"),
    ),
    amountMinor: v.number(),
    occurredAt: v.number(),
    notes: v.optional(v.string()),
    accountingEventId: v.optional(v.id("accountingEvents")),
    /** SCRUM-54: the physical bank a BANK_DEPOSIT movement went into. */
    bankAccountId: v.optional(v.id("bankAccounts")),
    actorId: v.id("users"),
    createdAt: v.number(),
    idempotencyKey: v.string(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_session", ["orgId", "sessionId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  // Phase 41: Accounting Depth — bank accounts are reference/reconciliation
  // records, not new GL control accounts (there is still exactly one
  // SYSTEM_KEYS.BANK_ACCOUNT control account). Opening balance is a reporting-
  // layer number (not a posted journal entry) added to a dated ledger scan of
  // that control account — see convex/bankAccounts.ts. Only one account per
  // org may have isReconciliationTarget = true.
  bankAccounts: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    currency: v.string(),
    openingBalanceMinor: v.number(),
    openingBalanceDate: v.number(),
    isActive: v.boolean(),
    isReconciliationTarget: v.boolean(),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_deleted", ["orgId", "isDeleted"])
    // SCRUM-54: the receipt / deposit bank pickers read only the banks in the one currency a
    // bank must match, so a long list in other currencies cannot crowd out an eligible bank.
    .index("by_org_active_currency", ["orgId", "isActive", "currency"]),

  // Uploaded bank-statement rows for the reconciliation-target bank account,
  // matched against posted journalLines on SYSTEM_KEYS.BANK_ACCOUNT.
  bankStatementLines: defineTable({
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    importBatchId: v.string(),
    statementDate: v.number(),
    description: v.string(),
    amountMinor: v.number(),
    status: v.union(v.literal("UNMATCHED"), v.literal("MATCHED"), v.literal("IGNORED")),
    matchedJournalLineId: v.optional(v.id("journalLines")),
    openingDepositRefundReturnEventId: v.optional(v.id("accountingEvents")),
    matchedAt: v.optional(v.number()),
    matchedBy: v.optional(v.id("users")),
    // Set when status flips to IGNORED — a discrepancy removed from the
    // close-blocking unmatched count must carry a documented reason and
    // who/when, not disappear from the control silently.
    ignoredAt: v.optional(v.number()),
    ignoredBy: v.optional(v.id("users")),
    ignoreReason: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_org_bankAccount", ["orgId", "bankAccountId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_matched_journal_line", ["matchedJournalLineId"]),
};
