import { defineTable } from "convex/server";
import { v } from "convex/values";
import { expenseCategoryValidator } from "../utils/expenseCategories";
import { paymentMethodValidator } from "../utils/paymentMethods";
import { costBearerValidator } from "../utils/costBearer";

export const expensesTables = {
  // Legacy expense-backed schedules keep their exact shape. A posted opening
  // allocation is a second native source family, with no invented expense.
  // The union refuses rows with both provenance families or neither one.
  prepaidExpenseSchedules: defineTable(v.union(v.object({
    orgId: v.id("organizations"),
    expenseId: v.id("expenses"),
    kind: v.optional(v.literal("EXPENSE")),
    currency: v.string(),
    totalMinor: v.number(),
    termMonths: v.number(),
    expenseSystemKey: v.string(),
    startYearMonth: v.string(),
    recognizedMinor: v.number(),
    monthsRecognized: v.optional(v.number()),
    lastRecognizedYearMonth: v.optional(v.string()),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("FULLY_AMORTIZED"),
      v.literal("CANCELLED"),
    ),
    createdAt: v.number(),
  }), v.object({
    kind: v.literal("OPENING"),
    orgId: v.id("organizations"),
    openingBalanceDraftId: v.id("openingBalanceDrafts"),
    openingRowKey: v.string(),
    title: v.string(),
    attestedUnexpiredBenefit: v.literal(true),
    openingBalanceDate: v.number(),
    currency: v.string(),
    totalMinor: v.number(),
    termMonths: v.number(),
    expenseSystemKey: v.string(),
    startYearMonth: v.string(),
    recognizedMinor: v.number(),
    monthsRecognized: v.optional(v.number()),
    lastRecognizedYearMonth: v.optional(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("FULLY_AMORTIZED"), v.literal("CANCELLED")),
    createdAt: v.number(),
  })))
    .index("by_org", ["orgId"])
    .index("by_status", ["status"])
    .index("by_expense", ["expenseId"])
    .index("by_opening_row", ["orgId", "openingBalanceDraftId", "openingRowKey"])
    // SCRUM-555 lane-B: ACTIVE-schedule read without a query filter.
    .index("by_org_status", ["orgId", "status"]),

  // One row per failed cron catch-up attempt on a schedule — the cron's
  // aggregate stats.failed counter used to discard which schedule/org/error
  // caused a failure, leaving nothing an accountant or support engineer could
  // act on. Kept until resolvedAt is set (by a successful manual retry).
  prepaidAmortizationFailures: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    yearMonth: v.string(), // the run's target month when the failure occurred
    errorMessage: v.string(),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_schedule", ["scheduleId"]),

  // Audit trail for a schedule correction (partial refund, non-refundable
  // write-off, or term change) — the only way to adjust a schedule short of
  // the full reversal path. One row per correction event; scheduleView reads
  // the schedule's own totalMinor/termMonths for current state, this table is
  // the "what happened and why" history for the accountant-facing UI.
  prepaidScheduleCorrections: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.number(), // cash/bank refund received for the unused portion, 0 if none
    refundTaxMinor: v.optional(v.number()), // VAT portion of the refund, 0/undefined if none
    refundPaymentMethod: v.optional(paymentMethodValidator),
    refundBankAccountId: v.optional(v.id("bankAccounts")),
    writeOffMinor: v.number(), // non-refundable unused portion expensed immediately, 0 if none
    previousTermMonths: v.number(),
    newTermMonths: v.number(),
    reason: v.string(),
    reference: v.optional(v.string()), // vendor credit-note / reference number, refund corrections only
    // The date the correction's GL entries book at, when the accountant chose
    // one rather than taking "now" — a credit note received 30 June and entered
    // 3 July belongs in June. Absent on term-only corrections (they post
    // nothing) and on every row written before this was offered, which booked
    // at their own createdAt.
    accountingDate: v.optional(v.number()),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_schedule", ["scheduleId"]),

  // Maker-checker gate for a non-owner's write-off correction (an asset ->
  // P&L accelerated expense — the highest-risk correction shape). Refund-only
  // and term-only corrections, and any correction submitted by the owner,
  // apply immediately via prepaidExpenseSchedules.correctSchedule and never
  // create a row here. Same pending -> approved/rejected idiom as
  // profitApprovalRequests / vehicleStatusRequests.
  prepaidCorrectionRequests: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.number(),
    refundTaxMinor: v.optional(v.number()),
    refundPaymentMethod: v.optional(paymentMethodValidator),
    refundBankAccountId: v.optional(v.id("bankAccounts")),
    writeOffMinor: v.number(),
    newTermMonths: v.number(),
    reason: v.string(),
    reference: v.optional(v.string()),
    // Carried from request to approval so the approver books the date the maker
    // meant, not the date they happened to click. Re-validated on approval —
    // its period can close in between.
    accountingDate: v.optional(v.number()),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    requestedBy: v.id("users"),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_schedule", ["scheduleId"]),

  expenses: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")), // Optional because there might be general expenses
    title: v.string(), // e.g., "Brake replacement", "Detailing", "Office supplies"
    amount: v.number(),
    date: v.number(),
    category: expenseCategoryValidator,
    isPrepaid: v.optional(v.boolean()),
    amortizationMonths: v.optional(v.number()),
    // When the prepaid coverage/service actually begins, if later than `date`
    // (e.g. insurance paid in June covering July onward). Optional — defaults
    // to `date` when absent, preserving old behavior for every existing row.
    amortizationStartDate: v.optional(v.number()),
    // Portion of amount that is input VAT paid (tax-inclusive, not additive) —
    // feeds the VAT return's input side. Optional/backward compatible.
    taxAmount: v.optional(v.number()),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    idempotencyKey: v.optional(v.string()),
    paymentMethod: v.optional(paymentMethodValidator),
    /** Physical bank used by a paid transfer, issued cheque or card expense. */
    bankAccountId: v.optional(v.id("bankAccounts")),
    vendor: v.optional(v.string()),
    vendorSupplierId: v.optional(v.id("suppliers")),
    costBearerSupplierId: v.optional(v.id("suppliers")),
    payerId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    // Set once, at posting time (recordPaidExpenseSideEffects), from the same
    // capitalizeToInventory decision that drove the GL posting — never
    // re-derived from category/vehicle-status later, so a vehicle sold after
    // this expense was capitalized can't retroactively change history, and a
    // post-sale repair correctly expensed to GL can't retroactively get pulled
    // into a vehicle's cost basis. capitalizedAmount is the exact net-of-VAT
    // amount actually debited to Vehicle Inventory (see computeVehicleCapitalizedCost).
    accountingTreatment: v.optional(
      v.union(v.literal("CAPITALIZED_INVENTORY"), v.literal("PERIOD_EXPENSE"))
    ),
    capitalizedAmount: v.optional(v.number()),
    // Accounting date of the offsetting reversal entry, set by
    // expenses.reverseExpense to the same instant it hands reverseAccountingEvent
    // as reversalDate. reverseExpense also soft-deletes the row, so this is what
    // lets the operational P&L tell "reversed" (really posted, really expensed in
    // its own month, credited back in a later one) apart from "deleted before it
    // ever posted" (no GL footprint, correctly invisible) — without it, filtering
    // isDeleted silently erased posted history from the report while the ledger
    // kept it. Absent on rows reversed before this field existed until
    // backfillExpenseReversedAt runs.
    reversedAt: v.optional(v.number()),
    /**
     * SCRUM-389 — who bears this cost. Absent means SHOWROOM, which is what
     * every row written before this field meant. SUPPLIER is allowed only on
     * an owned SOURCED vehicle, non-prepaid, with no tax, and is immutable once
     * PAID: a paid SUPPLIER cost posts Dr Receivable from Suppliers (never an
     * expense account) and opens one `supplierCostRecoveries` row. Enforced by
     * `assertCostBearerAllowed` in expenses.ts, never by a reader.
     */
    costBearer: v.optional(costBearerValidator),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_date", ["orgId", "date"])
    // Dashboard ranges: live (isDeleted undefined or false - two ranges, as the
    // optional field holds either) and unreversed, in date order. Both
    // exclusions are in the index so a read never scans deleted or reversed rows.
    .index("by_org_deleted_reversedAt_date", ["orgId", "isDeleted", "reversedAt", "date"])
    // Finds expenses whose *reversal* lands in a reporting window even though
    // the expense itself is dated long before it — a date-range scan over
    // `by_org_date` would never reach them.
    .index("by_org_reversedAt", ["orgId", "reversedAt"]),

  // SCRUM-807: dashboard expense figures per (org, generation, UTC month). Each
  // array holds one integer per UTC day 1..31, in thousandths of the org
  // currency (showroomCount is a row count). Maintained by the expenses trigger;
  // see convex/utils/dashboardExpenseSummary.ts. Rows are never deleted.
  dashboardExpenseMonths: defineTable({
    orgId: v.id("organizations"),
    generation: v.number(),
    month: v.number(),
    cashOut: v.array(v.number()),
    showroom: v.array(v.number()),
    general: v.array(v.number()),
    showroomCount: v.array(v.number()),
    unrepresentable: v.number(),
    absTotal: v.number(),
    overflowed: v.boolean(),
  }).index("by_org_generation_month", ["orgId", "generation", "month"]),

  // SCRUM-807: one row per summary generation. The newest generation controls
  // reads; only READY is ever read. Older generations are kept, not maintained.
  dashboardExpenseSummaryState: defineTable({
    orgId: v.id("organizations"),
    generation: v.number(),
    phase: v.union(v.literal("BUILDING"), v.literal("READY"), v.literal("BLOCKED")),
    countedThrough: v.optional(v.number()),
  }).index("by_org_generation", ["orgId", "generation"]),
};
