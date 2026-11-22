import { defineTable } from "convex/server";
import { v } from "convex/values";
import { openingAllocationResultValidator, openingAllocationValidator } from "../utils/openingAllocationValidators";
import { paymentMethodValidator } from "../utils/paymentMethods";

export const accountingOpeningTables = {
  // GL Phase 17 hardening: opening balances get the same two-person
  // segregation of duties as manual journals — a direct-lines posting to
  // system-controlled accounts is exactly the highest-risk control point
  // manualJournalDrafts already exists to protect, and a one-time seed entry
  // is no less risky for being one-time. See accountingCutover.ts.
  // Management-only economics; never a journal, cash, prepaid or capital source.
  openingManagementSettlementPlans: defineTable({
    orgId: v.id("organizations"),
    openingDraftId: v.id("openingBalanceDrafts"),
    status: v.union(v.literal("PENDING_APPROVAL"), v.literal("APPROVED"), v.literal("REJECTED")),
    currency: v.string(),
    totalMinor: v.number(),
    classificationAttestation: v.literal("CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL"),
    supportingReference: v.string(),
    installments: v.array(v.object({
      sequence: v.number(), effectiveMonth: v.number(), amountMinor: v.number(),
      recognitionMonth: v.optional(v.number()),
    })),
    createdBy: v.id("users"),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    rejectedBy: v.optional(v.id("users")),
    rejectedAt: v.optional(v.number()),
    resetGeneration: v.number(),
  }).index("by_org", ["orgId"])
    .index("by_org_opening_status", ["orgId", "openingDraftId", "status"]),

  openingBalanceDrafts: defineTable({
    orgId: v.id("organizations"),
    suspenseClassification: v.optional(v.object({
      version: v.number(),
      sourceAccountId: v.id("chartOfAccounts"),
      targetAccountId: v.id("chartOfAccounts"),
      originalJournalId: v.id("journalEntries"),
      signedBalanceMinor: v.number(),
      reason: v.string(),
      requestedBy: v.id("users"),
      requestedAt: v.number(),
      dismissal: v.optional(v.object({ by: v.id("users"), at: v.number() })),
      approval: v.optional(v.object({
        by: v.id("users"),
        at: v.number(),
        journalId: v.id("journalEntries"),
      })),
    })),
    // Absent on legacy drafts means version zero; edits advance this atomically.
    version: v.optional(v.number()),
    status: v.union(
      v.literal("PENDING_APPROVAL"),
      v.literal("POSTED"),
      v.literal("REJECTED"),
      v.literal("VOIDED"),
    ),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
      // SCRUM-54: the physical bank a BANK_ACCOUNT-control line seeds. Required
      // by the mutations for that account, absent on every other line and on
      // drafts saved before this field existed (which approval refuses).
      bankAccountId: v.optional(v.id("bankAccounts")),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    // The currency these minor-unit line amounts were ENTERED in, snapshotted
    // at draft time. Not derivable from the org later: orgSettings only locks
    // the org currency once a row exists in one of six financial tables, and
    // openingBalanceDrafts is not one of them — so a fresh org (exactly the
    // onboarding case) could draft in JOD, switch to USD, and approve. Scale is
    // per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise), so that re-denominates
    // 1,000.000 JOD into 10,000.00 USD with no conversion. Optional because
    // rows drafted before this field existed cannot have it.
    currency: v.optional(v.string()),
    // Display identity of the preparer, snapshotted for the same reason: user
    // rows are hard-deleted on offboarding (memberships.ts), which would leave
    // the approver reviewing a draft prepared by "Unknown" — and the whole
    // point of the two-person control is knowing who the other person was.
    preparedByName: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    journalEntryId: v.optional(v.id("journalEntries")),
    // True when an owner posted this without a second approver, via
    // accountingCutover.postOpeningBalanceDirect. Absent on rows that went
    // through the two-person review, and on every row predating that route —
    // so read it as "known to have skipped review", never as "reviewed".
    autoApproved: v.optional(v.boolean()),
    // Posted drafts own immutable opening provenance and native materialization.
    // Older rows have neither field; approval revalidates any required detail.
    allocations: v.optional(v.array(openingAllocationValidator)),
    allocationResults: v.optional(v.array(openingAllocationResultValidator)),
    // SCRUM-850: the request never changes the posted economics. Approval and
    // the complete unwind commit together; retained results remain audit proof.
    voidRequest: v.optional(v.object({
      requestedBy: v.id("users"),
      requestedAt: v.number(),
      reason: v.string(),
      approvedBy: v.optional(v.id("users")),
      approvedAt: v.optional(v.number()),
      reversalJournalEntryId: v.optional(v.id("journalEntries")),
    })),
  })
    .index("by_org", ["orgId"])
    .index("by_orgId_and_journalEntryId", ["orgId", "journalEntryId"])
    .index("by_org_status", ["orgId", "status"]),

  // A monthly payroll run and its per-employee payslip items.
  openingCommissionLiabilities: defineTable({orgId:v.id("organizations"),userId:v.id("users"),openingDraftId:v.id("openingBalanceDrafts"),openingRowKey:v.string(),sourceKey:v.string(),version:v.literal(1),amountMinor:v.number(),paidMinor:v.number(),currency:v.string(),createdAt:v.number(),paidAt:v.optional(v.number()),paidBy:v.optional(v.id("users")),paidPayrollItemId:v.optional(v.id("payrollItems"))}).index("by_org",["orgId"]).index("by_org_user",["orgId","userId"]).index("by_org_source",["orgId","sourceKey"]).index("by_org_payroll_item",["orgId","paidPayrollItemId"]),

  openingPayablePayments: defineTable({orgId:v.id("organizations"),payableId:v.id("vehicleSupplierPayables"),seq:v.number(),openingBalanceDraftId:v.id("openingBalanceDrafts"),openingRowKey:v.string(),amountMinor:v.number(),currency:v.string(),method:paymentMethodValidator,bankAccountId:v.optional(v.id("bankAccounts")),occurredAt:v.number(),actorId:v.id("users"),commandKey:v.string(),operation:v.union(v.literal("markPaid"),v.literal("recordPartialPayment")),status:v.union(v.literal("LIVE"),v.literal("REVERSED")),reversedAt:v.optional(v.number()),reversedBy:v.optional(v.id("users")),reversalReason:v.optional(v.string())}).index("by_org",["orgId"]).index("by_payable",["payableId"]).index("by_org_payable_seq",["orgId","payableId","seq"]).index("by_org_command",["orgId","commandKey"]),
};
