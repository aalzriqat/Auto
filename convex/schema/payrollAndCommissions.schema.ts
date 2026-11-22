import { defineTable } from "convex/server";
import { v } from "convex/values";

export const payrollAndCommissionsTables = {
  /**
   * Employee commission lines REGISTERED against a deal (owner SCRUM-783 types:
   * sale = who sold, purchase = who brought the car in, execution = who executed
   * the finance transaction). One deal can carry several lines, each its own
   * type and employee.
   *
   * LEDGER AND PAYROLL (owner approval 2026-10-19, SCRUM-783, PR #633):
   * - Adding a line (convex/dealCommissions.ts addLine, hookDealCommissionLineAccrued
   *   call) accrues one COMMISSION_ACCRUED event keyed on the line, dated at the
   *   sale (Dr Commission Expense / Cr Commission Payable, convex/accounting/
   *   workflowHooks.ts hookDealCommissionLineAccrued). With no chart of accounts
   *   or open period yet, the accrual is queued in `pendingAccountingEvents`
   *   and posts under its idempotency key once the chart or period is ready.
   * - Removing an unpaid line, or cancelling its sale, reverses that accrual and
   *   sets `removedAt` (hookDealCommissionLineReversed). A paid line refuses both.
   * - A paid line (`paidAt` set, not removed) also blocks deal unwind: start and
   *   finish refuse with DEAL_UNWIND_COMMISSION_PAID (convex/dealUnwind.ts
   *   assertDealUnwindable).
   * - Payroll pays an unpaid line on the employee's payslip (`payrollItems.
   *   commissionLineIds`, convex/payroll.ts isDealLineOwed), then sets `paidAt`.
   * The salesperson's own commission stays on `sales.commissionAmount` with its
   * own accrual key; it is added to these lines by the readers, never copied
   * into a row here. The deal screen shows the total and net profit after it.
   *
   * Amounts are integer minor units of `currency`, the organization's currency
   * when the line was written. A removed line is kept (`removedAt`) so the
   * history survives; readers skip it.
   */
  dealCommissionLines: defineTable({
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    kind: v.union(v.literal("SALE"), v.literal("PURCHASE"), v.literal("EXECUTION")),
    employeeId: v.id("users"),
    amountMinor: v.number(),
    currency: v.string(),
    note: v.optional(v.string()),
    createdBy: v.id("users"),
    removedAt: v.optional(v.number()),
    removedBy: v.optional(v.id("users")),
    /** Set when payroll pays the line. A paid line can no longer be removed. */
    paidAt: v.optional(v.number()),
    paidBy: v.optional(v.id("users")),
    payrollItemId: v.optional(v.id("payrollItems")),
  })
    .index("by_org_sale", ["orgId", "saleId"])
    .index("by_org_employee", ["orgId", "employeeId"]),

  // ─── Payroll ──────────────────────────────────────────────────────────────
  // Fixed monthly salary per team member. History is kept by superseding rows
  // (active:false on the old one) rather than editing in place.
  employeeCompensation: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    monthlySalaryMinor: v.number(),
    currency: v.string(),
    effectiveFrom: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_user_active", ["orgId", "userId", "active"]),

  // Salary advances (سلفة) — a recoverable ASSET (Employee Advances), NOT an
  // expense, until offset against a payslip or repaid.
  employeeAdvances: defineTable({
    orgId: v.id("organizations"),
    openingBalanceDraftId: v.optional(v.id("openingBalanceDrafts")),
    userId: v.id("users"),
    amountMinor: v.number(),
    recoveredMinor: v.number(),
    currency: v.string(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    date: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD"),
      ),
    ),
    status: v.union(
      v.literal("OUTSTANDING"),
      v.literal("RECOVERED"),
      v.literal("WRITTEN_OFF"),
    ),
    note: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_status", ["orgId", "status"]),

  // One immutable row per advance recovery event (direct repayment or payroll
  // deduction). Each carries its own GL identity so partial repayments post
  // distinct EMPLOYEE_ADVANCE_RECOVERED entries and the Employee Advances asset
  // is credited exactly once per repayment.
  employeeAdvanceRecoveries: defineTable({
    orgId: v.id("organizations"),
    advanceId: v.id("employeeAdvances"),
    userId: v.id("users"),
    amountMinor: v.number(),
    currency: v.string(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD"),
      ),
    ),
    // "DIRECT" = repaid outside payroll; "PAYROLL" = deducted on a payslip.
    source: v.union(v.literal("DIRECT"), v.literal("PAYROLL")),
    payrollItemId: v.optional(v.id("payrollItems")),
    recoveredAt: v.number(),
    recoveredBy: v.id("users"),
    // AUDIT PROVENANCE ONLY - this field is NOT the replay authority.
    // It records which command identity produced this row. Replay for
    // payroll.recoverAdvance is resolved solely by `commandIdempotency` via
    // runWithIdempotency (SCRUM-291). A `(orgId, idempotencyKey)` lookup on
    // THIS table used to short-circuit ahead of that boundary, and because it
    // matched on the key alone it returned unrelated recoveries as success.
    // Do not reintroduce a reader that resolves replay from this field.
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_advance", ["advanceId"])
    // Lets the outbox find every advance a payslip recovered, so a queued
    // PAYROLL_PAID can be held until each advance issuance has posted.
    .index("by_payroll_item", ["payrollItemId"])
    // Retained for provenance lookups only; it has NO reader that resolves
    // replay. See the warning on idempotencyKey above.
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  payrollRuns: defineTable({
    orgId: v.id("organizations"),
    periodYear: v.number(),
    periodMonth: v.number(), // 1-12
    currency: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("APPROVED"),
      // Was APPROVED, but a pay-time recompute found the payable now differs
      // materially from what was approved (a new advance, a directly-paid or
      // cancelled commission, a directly-repaid advance). Payment is blocked
      // until it is re-approved — the run re-derives and re-freezes its totals.
      v.literal("NEEDS_REAPPROVAL"),
      v.literal("PAID"),
      v.literal("CANCELLED"),
    ),
    totalGrossMinor: v.number(),
    totalNetMinor: v.number(),
    // Why the run fell back to NEEDS_REAPPROVAL (shown to the approver).
    reapprovalReason: v.optional(v.string()),
    // Accounting date the salary/commission accrual is recognized on: the last
    // moment of the payroll period (UTC), so a retroactive run books its expense
    // in the month worked, not the month it was approved.
    accountingDate: v.optional(v.number()),
    // Immutable snapshot of gross/net at approval, so a pay-time recompute (a
    // commission paid directly, an advance repaid, a sale cancelled since
    // approval) leaves an audit trail instead of silently overwriting.
    approvedGrossMinor: v.optional(v.number()),
    approvedNetMinor: v.optional(v.number()),
    // The method the whole run was paid with (per-employee split not supported).
    paidMethod: v.optional(v.string()),
    paidBankAccountId: v.optional(v.id("bankAccounts")),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    paidBy: v.optional(v.id("users")),
    paidAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_period", ["orgId", "periodYear", "periodMonth"])
    .index("by_org_status", ["orgId", "status"]),

  payrollItems: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("payrollRuns"),
    userId: v.id("users"),
    baseSalaryMinor: v.number(),
    commissionMinor: v.number(),
    otherEarningsMinor: v.number(),
    advanceDeductionMinor: v.number(),
    otherDeductionMinor: v.number(),
    grossMinor: v.number(),
    netMinor: v.number(),
    // Immutable snapshot of gross/net frozen at (re)approval. grossMinor/netMinor
    // above are overwritten with the actually-paid figures at payment; these are
    // what the approver authorized and are what a pay-time drift check compares
    // against to decide whether the run needs re-approval.
    approvedGrossMinor: v.optional(v.number()),
    approvedNetMinor: v.optional(v.number()),
    currency: v.string(),
    // Unpaid commission sales this payslip settles (Option A: commissions are
    // paid through payroll). Marked paid when the run is paid.
    commissionSaleIds: v.array(v.id("sales")),
    openingCommissionLiabilityIds: v.optional(v.array(v.id("openingCommissionLiabilities"))),
    openingCommissionMinor: v.optional(v.number()),
    /** Extra deal commission lines paid on this payslip (see dealCommissionLines). */
    commissionLineIds: v.optional(v.array(v.id("dealCommissionLines"))),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_run", ["runId"])
    .index("by_org_user", ["orgId", "userId"]),
};
