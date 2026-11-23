import { defineTable } from "convex/server";
import { v } from "convex/values";

export const generalLedgerTables = {
  // ─── Phase 1 + 2: Accounting foundation and ledger ────────────────────────

  chartOfAccounts: defineTable({
    orgId: v.id("organizations"),
    code: v.string(),
    name: v.string(),
    nameAr: v.optional(v.string()),
    type: v.union(
      v.literal("ASSET"),
      v.literal("LIABILITY"),
      v.literal("EQUITY"),
      v.literal("REVENUE"),
      v.literal("COGS"),
      v.literal("EXPENSE"),
      v.literal("OTHER_INCOME"),
      v.literal("OTHER_EXPENSE"),
    ),
    subtype: v.optional(v.string()),
    normalBalance: v.union(v.literal("DEBIT"), v.literal("CREDIT")),
    parentAccountId: v.optional(v.id("chartOfAccounts")),
    isControlAccount: v.boolean(),
    allowManualPosting: v.boolean(),
    currencyRestriction: v.optional(v.string()),
    active: v.boolean(),
    systemKey: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_code", ["orgId", "code"])
    .index("by_org_systemKey", ["orgId", "systemKey"])
    .index("by_org_type", ["orgId", "type"]),

  accountingPeriods: defineTable({
    orgId: v.id("organizations"),
    // Set only when this period was created with synchronous snapshot writers.
    // Older retained periods have no certificate and use journal lines for
    // containing-period reports until their snapshots are reconciled.
    snapshotFastPathEligible: v.optional(v.boolean()),
    startDate: v.number(),
    endDate: v.number(),
    fiscalYear: v.number(),
    periodNumber: v.number(),
    status: v.union(
      v.literal("FUTURE"),
      v.literal("OPEN"),
      v.literal("CLOSING"),
      v.literal("CLOSED"),
      v.literal("LOCKED"),
    ),
    closedBy: v.optional(v.id("users")),
    closedAt: v.optional(v.number()),
    reopenedBy: v.optional(v.id("users")),
    reopenedAt: v.optional(v.number()),
    reopenReason: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_year_period", ["orgId", "fiscalYear", "periodNumber"])
    .index("by_org_startDate", ["orgId", "startDate"]),

  accountingEvents: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    eventType: v.string(),
    sourceType: v.string(),
    sourceId: v.string(),
    eventVersion: v.number(),
    idempotencyKey: v.string(),
    occurredAt: v.number(),
    accountingDate: v.number(),
    currency: v.string(),
    payload: v.any(),
    payloadHash: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("POSTED"),
      v.literal("FAILED"),
      v.literal("REVERSED"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    reversedByEventId: v.optional(v.id("accountingEvents")),
    reversalOfEventId: v.optional(v.id("accountingEvents")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_eventType", ["orgId", "eventType"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    .index("by_org_event_source_version", ["orgId", "eventType", "sourceType", "sourceId", "eventVersion"])
    // Lets a report load one event type for just its own window instead of the
    // org's whole history — the reversals the operational P&L needs are only
    // ever the ones dated inside the window being reported.
    .index("by_org_eventType_date", ["orgId", "eventType", "accountingDate"])
    // SCRUM-555 lane-B: status-aware window read (POSTED / REVERSED) without a
    // query-level filter — used by computeRecognizedCommissionAsOf.
    .index("by_org_eventType_status_date", ["orgId", "eventType", "status", "accountingDate"]),

  journalEntries: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    journalNumber: v.string(),
    accountingDate: v.number(),
    periodId: v.optional(v.id("accountingPeriods")),
    sourceType: v.string(),
    sourceId: v.string(),
    category: v.union(
      v.literal("SYSTEM"),
      v.literal("MANUAL"),
      v.literal("REVERSAL"),
      v.literal("ADJUSTMENT"),
      v.literal("OPENING_BALANCE"),
    ),
    memo: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("VALIDATED"),
      v.literal("POSTED"),
      v.literal("REVERSED"),
    ),
    currency: v.optional(v.string()),
    reversalOfJournalEntryId: v.optional(v.id("journalEntries")),
    reversedByJournalEntryId: v.optional(v.id("journalEntries")),
    postedBy: v.id("users"),
    postedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "accountingDate"])
    .index("by_org_period", ["orgId", "periodId"])
    .index("by_org_period_date", ["orgId", "periodId", "accountingDate"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_accounting_event", ["accountingEventId"])
    // SCRUM-555 lane-B: getPostedLines reads POSTED and REVERSED entries.
    .index("by_org_status", ["orgId", "status"]),

  journalLines: defineTable({
    orgId: v.id("organizations"),
    journalEntryId: v.id("journalEntries"),
    reportPosted: v.optional(v.boolean()),
    lineNumber: v.number(),
    accountId: v.id("chartOfAccounts"),
    debitMinor: v.number(),
    creditMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    accountingDate: v.number(),
    exchangeRate: v.optional(v.number()),
    reportingDebitMinor: v.optional(v.number()),
    reportingCreditMinor: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    /** SCRUM-27: the name of a MANUAL finance company (no party row), exactly as on its approval letter. */
    payerNameSnapshot: v.optional(v.string()),
    salespersonId: v.optional(v.id("users")),
    cashierId: v.optional(v.id("users")),
    /**
     * SCRUM-54: the physical bank account a BANK_ACCOUNT control line moved
     * money through, captured by the money-moving producer. Absent on legacy
     * lines — those are unmatched and never inferred by amount/date.
     */
    bankAccountId: v.optional(v.id("bankAccounts")),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_journal_entry", ["journalEntryId"])
    .index("by_org_account", ["orgId", "accountId"])
    .index("by_org_account_date", ["orgId", "accountId", "accountingDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    // SCRUM-555 lane-B: getPostedLines date-range read without a query filter.
    .index("by_org_date", ["orgId", "accountingDate"])
    .index("by_org_reportPosted_date", ["orgId", "reportPosted", "accountingDate"]),

  journalReportEligibility: defineTable({
    orgId: v.id("organizations"),
    phase: v.union(v.literal("BUILDING"), v.literal("READY"), v.literal("BLOCKED")),
    cursor: v.union(v.string(), v.null()),
  }).index("by_org", ["orgId"]),

  // ─── Phase 7: Financial audit log ─────────────────────────────────────────

  financialAuditLog: defineTable({
    orgId: v.id("organizations"),
    actorId: v.id("users"),
    actionType: v.union(
      v.literal("EDIT_OPENING_DRAFT"),
      v.literal("REQUEST_OPENING_VOID"),
      v.literal("APPROVE_OPENING_VOID"),
      v.literal("REQUEST_OPENING_SUSPENSE_CLASSIFICATION"),
      v.literal("APPROVE_OPENING_SUSPENSE_CLASSIFICATION"),
      v.literal("DISMISS_OPENING_SUSPENSE_CLASSIFICATION"),
      v.literal("CREATE_PERIOD"),
      v.literal("POST_EVENT"),
      v.literal("POST_MANUAL_JOURNAL"),
      v.literal("CREATE_MANUAL_JOURNAL_DRAFT"),
      v.literal("REJECT_MANUAL_JOURNAL"),
      v.literal("REVERSE_EVENT"),
      v.literal("OPEN_PERIOD"),
      v.literal("CLOSE_PERIOD"),
      v.literal("LOCK_PERIOD"),
      v.literal("REOPEN_PERIOD"),
      v.literal("INIT_CHART"),
      v.literal("UPDATE_ACCOUNT"),
      v.literal("MIGRATE_TRANSACTION"),
      v.literal("ALLOCATE_PAYMENT"),
      // SCRUM-869 S1: opening or lifting a dispute on a supplier payable or commission claim.
      v.literal("SET_SUPPLIER_DISPUTE"),
      v.literal("REVERSE_ALLOCATION"),
      v.literal("IGNORE_BANK_STATEMENT_LINE"),
      v.literal("CORRECT_PREPAID_SCHEDULE"),
      v.literal("REQUEST_PREPAID_CORRECTION"),
      v.literal("APPROVE_PREPAID_CORRECTION"),
      v.literal("REJECT_PREPAID_CORRECTION"),
      v.literal("RESOLVE_SYSTEM_ACCOUNT_ADOPTION"),
      v.literal("REPAIR_MISSING_SYSTEM_ACCOUNTS"),
      v.literal("ACKNOWLEDGE_CLOSE_WARNINGS"),
      v.literal("SET_COMMISSION_AMOUNT"),
      // Multi-vehicle reservation-deposit allocation — see depositAllocation.ts.
      v.literal("ALLOCATE_DEPOSIT"),
      v.literal("RESOLVE_DEPOSIT_ALLOCATION"),
      v.literal("SET_SUPPLIER_SETTLEMENT_ROUTE"),
      // SCRUM-447: retiring a registered expected payment, and attesting the
      // face of a legacy finance-company cheque.
      v.literal("CORRECT_EXPECTED_PAYMENT"),
      v.literal("ATTEST_CHEQUE_FACE"),
      v.literal("CONFIRM_SUPPLIER_DISBURSEMENT"),
      // Correcting a mistyped settlement advice. Distinct from recording one so
      // the audit trail shows an amendment as an amendment — a second
      // CONFIRM would read as a second payment.
      v.literal("AMEND_SUPPLIER_DISBURSEMENT_ADVICE"),
      // The vehicle commitment authority's result after a cancellation —
      // restored, rival, blocked, nothing to restore, or withheld because the
      // organization is not on the canonical authority yet. See
      // utils/saleCancellation.ts.
      v.literal("SETTLE_COMMITMENT_AUTHORITY"),
      // SCRUM-239: a cleared finance-company disbursement cheque came back.
      v.literal("RETURN_FINANCE_DISBURSEMENT_CHEQUE"),
      // SCRUM-693: the steps of unwinding a paid finance deal.
      v.literal("DEAL_UNWIND_STARTED"),
      v.literal("DEAL_UNWIND_FORWARD_RETURNED"),
      v.literal("DEAL_UNWIND_REMITTANCE_REFUNDED"),
      v.literal("DEAL_UNWIND_COMPLETED"),
      v.literal("DEAL_UNWIND_ABANDONED"),
      // Registered employee commission lines on a deal (sale / purchase / execution).
      v.literal("ADD_DEAL_COMMISSION_LINE"),
      v.literal("REMOVE_DEAL_COMMISSION_LINE"),
    ),
    resourceType: v.string(),
    resourceId: v.string(),
    description: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_actor", ["orgId", "actorId"])
    .index("by_org_action", ["orgId", "actionType"])
    .index("by_org_action_idempotency", ["orgId", "actionType", "idempotencyKey"])
    .index("by_org_time", ["orgId", "occurredAt"]),

  // ─── Phase 10: True two-person manual-journal approval ────────────────────

  manualJournalDrafts: defineTable({
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("PENDING_APPROVAL"),
      v.literal("POSTED"),
      v.literal("REJECTED"),
    ),
    memo: v.string(),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    // SCRUM-50: the accounting date the preparer declared for the economic
    // event. OPTIONAL only so drafts written before SCRUM-50 remain readable —
    // `approveManualJournal` REFUSES a draft without one rather than inferring
    // a date. Every new draft is required to carry it.
    accountingDate: v.optional(v.number()),
    idempotencyKey: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    reviewedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_time", ["orgId", "createdAt"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  // GL Phase 18: running per-(account, currency, period) totals, incremented
  // synchronously by postAccountingEvent/reverseAccountingEvent every time a
  // journal line posts. Lets trial balance / balance sheet sum O(periods)
  // snapshot rows for closed periods instead of collecting every journal
  // line ever posted; only the still-open containing period needs a bounded
  // scan of its own lines. Currency is part of the key (not in the phase
  // spec's original field list) because GL Phase 14 made a single account
  // able to carry lines in more than one currency — a snapshot without a
  // currency dimension would silently re-introduce that exact bug.
  accountBalanceSnapshots: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
    currency: v.string(),
    periodId: v.id("accountingPeriods"),
    // Sharded counter: each account/currency/period is split across
    // SHARD_COUNT independent documents so concurrent postings to the same
    // hot account only ever OCC-conflict within a shard, not across the
    // whole account. The read path sums across shards, so this is
    // transparent to every caller of getCumulativeBalancesAsOf. Optional,
    // not required: rows written before sharding was added have no shard
    // field, and that's fine as-is — incrementAccountSnapshot's write
    // lookup always queries a concrete shard number, so it can never match
    // one of these old rows again; a fresh shard-tagged row just takes
    // over accumulating from here. The read path never filters on shard,
    // so the old row's already-accumulated total keeps counting correctly.
    shard: v.optional(v.number()),
    runningDebitMinor: v.number(),
    runningCreditMinor: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_account_currency_period_shard", ["orgId", "accountId", "currency", "periodId", "shard"])
    .index("by_org_period", ["orgId", "periodId"]),

  // GL Phase 17: a one-time accountant attestation that the legacy-to-GL
  // cutover for this org has been reviewed and is correct, carrying a
  // point-in-time snapshot of the numbers that were reviewed (not a live
  // computation) so the sign-off remains meaningful even as later activity
  // changes current totals.
  accountingCutoverSignOffs: defineTable({
    orgId: v.id("organizations"),
    snapshot: v.object({
      legacyTransactionCount: v.number(),
      migratedTransactionCount: v.number(),
      unmigratedTransactionCount: v.number(),
      // Per-currency breakdown, not a single mixed-currency total: an org's
      // currency can change over time (GL Phase 14), leaving historical
      // journal lines in more than one currency.
      trialBalanceByCurrency: v.array(v.object({
        currency: v.string(),
        totalDebitsMinor: v.number(),
        totalCreditsMinor: v.number(),
        isBalanced: v.boolean(),
      })),
      isBalanced: v.boolean(),
    }),
    notes: v.optional(v.string()),
    signedOffBy: v.id("users"),
    signedOffAt: v.number(),
  })
    .index("by_org", ["orgId"]),

  // GL Phase 14: org-defined exchange rates for optional reporting-currency
  // translation. Books always stay per-currency; these rates only produce
  // display-level translated figures in reports, never postings.
  exchangeRates: defineTable({
    orgId: v.id("organizations"),
    fromCurrency: v.string(),
    toCurrency: v.string(),
    rate: v.number(),
    asOfDate: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_pair", ["orgId", "fromCurrency", "toCurrency", "asOfDate"]),
};
