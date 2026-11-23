import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { listCustodyBankOptionsHandler, listCustodyMovementsHandler } from "./utils/financeDealCosts/custodyReads";
import { listDealCostsHandler } from "./utils/financeDealCosts/dealCostOverview";
import { mutation } from "./functions";
import { adoptCompanyFeeTemplatesHandler } from "./utils/financeDealCosts/feeTemplates";
import {
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
} from "./utils/financingEconomics";
import { recordDealFeeHandler, recordTemplateFeeActualHandler } from "./utils/financeDealCosts/feeRecords";
import {
  bindExecutionFeeLineHandler,
  recordExecutionFeeActualHandler,
  unbindExecutionFeeLineHandler,
} from "./utils/financeDealCosts/executionFees";
import { reconcileDealFeeHandler, recordActualFeeAmountHandler } from "./utils/financeDealCosts/feeEvidence";
import { setFeeCustodyHandler, voidDealFeeHandler } from "./utils/financeDealCosts/feeCustody";
import {
  listDirectPaymentBankOptionsHandler,
  recordDirectFeePaymentHandler,
} from "./utils/financeDealCosts/directFeePayment";
import { directPaymentMethodValidator } from "./utils/handoverCostPayment";
import {
  listCustodyCandidatesHandler,
  openDealCustodyHandler,
  planDealCustody,
} from "./utils/financeDealCosts/custodyIssue";
import { recordCustodyMovementHandler } from "./utils/financeDealCosts/custodyMovement";
import {
  reconcileDealCustodyHandler,
  reopenDealCustodyHandler,
} from "./utils/financeDealCosts/custodyReconciliation";
import { migrateLegacyCustodyToLedgerHandler } from "./utils/financeDealCosts/custodyMigration";
import { recordLegalInvoiceHandler } from "./utils/financeDealCosts/dealLegalInvoice";
import {
  dealCustodyAccountingReadiness,
  ensureFinancedSettlementAccounts,
  isChartInitialized,
  isSystemAccountMapped,
} from "./chartOfAccounts";
import { recomputeEconomicsForApplication } from "./financingEconomics";

export { MAX_CUSTODY_ENTRIES, MAX_DEAL_CUSTODY_DECISION_RECORDS } from "./utils/dealCostLimits";
export { deriveFeeStatus, summarizeFees, unreadableFeeAmounts, type FeeAmountsUnreadableReason } from "./utils/feeSummary";
export { deriveExpectedFees, type ExpectedFeeRow } from "./utils/handoverFeeProjection";
export { dealEconomicsFrozen } from "./utils/financeDealCosts/dealCostGuards";
export { dealAcceptsNewCustodyCash } from "./utils/financeDealCosts/dealCostGuards";
export { deriveRecommendedCustody } from "./utils/financeDealCosts/dealCostOverview";
export { actualEvidenceRevisionOf } from "./utils/financeDealCosts/dealCostGuards";
export { MAX_DEAL_CUSTODY_RECORDS } from "./utils/financeDealCosts/custodyRecords";
export { type FeeTemplateAdoptionState } from "./utils/financeDealCosts/feeTemplates";
export { type FeeTemplateAdoption } from "./utils/financeDealCosts/feeTemplates";
export { deriveFeeTemplateAdoption } from "./utils/financeDealCosts/feeTemplates";
export { MAX_CUSTODY_CANDIDATES } from "./utils/financeDealCosts/custodyIssue";

const accounting = {
  dealCustodyAccountingReadiness,
  ensureFinancedSettlementAccounts,
  isChartInitialized,
  isSystemAccountMapped,
  recomputeEconomicsForApplication,
};

export const listCustodyMovements = query({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => listCustodyMovementsHandler(ctx, args),
});

export const listDealCosts = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => listDealCostsHandler(ctx, args, accounting),
});

export const adoptCompanyFeeTemplates = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => adoptCompanyFeeTemplatesHandler(ctx, args),
});

export const recordDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    feeType: financeFeeTypeValidator,
    description: v.optional(v.string()),
    estimatedAmountMinor: v.optional(v.number()),
    actualAmountMinor: v.optional(v.number()),
    paidBy: feePartyValidator,
    paidTo: feePartyValidator,
    /** Required on purpose — see the schema note. Never inferred from paidBy. */
    accountingTreatment: feeAccountingTreatmentValidator,
    includedInQuotation: v.optional(v.boolean()),
    deductedFromSettlement: v.optional(v.boolean()),
    refundable: v.optional(v.boolean()),
    custodyId: v.optional(v.id("financeDealCustody")),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    source: v.optional(v.union(v.literal("COMPANY_TEMPLATE"), v.literal("MANUAL"))),
    /**
     * REQUIRED. The currency the caller entered the minor-unit amounts in
     * (SCRUM-319). The server never trusts it as the denomination — it proves
     * the deal's own and refuses when the two differ — but without it a form
     * rendered in USD could submit cents onto a deal whose lines are fils and
     * nothing would notice until settlement.
     */
    expectedCurrency: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => recordDealFeeHandler(ctx, args, accounting),
});

export const recordTemplateFeeActual = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** Position of the template in the application's frozen snapshot. */
    templateIndex: v.number(),
    /** The fee type the caller saw at that position — a cross-check, never a source of policy. */
    feeType: financeFeeTypeValidator,
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in (SCRUM-319). */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => recordTemplateFeeActualHandler(ctx, args, accounting),
});

export const recordExecutionFeeActual = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in (SCRUM-319). */
    expectedCurrency: v.string(),
    paidBy: v.union(v.literal("DEALER"), v.literal("EMPLOYEE")),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    custodyId: v.optional(v.id("financeDealCustody")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => recordExecutionFeeActualHandler(ctx, args, accounting),
});

export const bindExecutionFeeLine = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
  },
  handler: async (ctx, args) => bindExecutionFeeLineHandler(ctx, args, accounting),
});

export const unbindExecutionFeeLine = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    reason: v.string(),
  },
  handler: async (ctx, args) => unbindExecutionFeeLineHandler(ctx, args, accounting),
});

export const recordActualFeeAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in. */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => recordActualFeeAmountHandler(ctx, args, accounting),
});

export const reconcileDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    notes: v.string(),
    /**
     * ROLLOUT BRIDGE (SCRUM-834) — optional here, required once the bridge is
     * removed. The actual amount the checker was looking at when they wrote
     * their notes. The reconciliation certifies THAT figure: if the row has
     * been re-recorded since, the notes describe a number that is no longer
     * there and the call is refused. Compared with `!==`, so a NaN (which the
     * number validator admits) matches nothing.
     *
     * Why they are optional: the pins ship with a frontend. A merge to main
     * automatically creates a Vercel build, but autoflowdealer.com is promoted
     * by hand, after the protected Convex deployment. So the backend that
     * carries these arguments goes live while the old UI (which sends no pins)
     * is still what users load, and the pinned UI only becomes live at
     * promotion; the old call therefore has to keep working until then. In the
     * other direction, a validator without these arguments rejects a pinned call
     * as extra arguments, so the backend deployment comes before the pinned UI
     * is promoted (or previewed against it).
     * The two pins are accepted together or not at all: neither is the legacy
     * call, both are the pinned contract, exactly one is refused.
     */
    expectedActualAmountMinor: v.optional(v.number()),
    /**
     * ROLLOUT BRIDGE (SCRUM-834) — optional here, required once the bridge is
     * removed. The line's `actualEvidenceRevision` when the checker opened it
     * (absent reads as 0). Pins the EVIDENCE the notes describe — receipt
     * reference, paid date, attachments — which a same-amount re-record replaces
     * without moving the amount. Compared with `!==`, so a NaN matches nothing.
     */
    expectedActualEvidenceRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => reconcileDealFeeHandler(ctx, args),
});

export const voidDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    reason: v.string(),
  },
  handler: async (ctx, args) => voidDealFeeHandler(ctx, args, accounting),
});

export const setFeeCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    /** The custody record to charge; omitted releases the line from its current one. */
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => setFeeCustodyHandler(ctx, args, accounting),
});

export const listDirectPaymentBankOptions = query({
  args: { orgId: v.id("organizations"), currency: v.string() },
  handler: async (ctx, args) => listDirectPaymentBankOptionsHandler(ctx, args),
});

export const recordDirectFeePayment = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    /** REQUIRED, no default — it decides which account the money left. */
    method: directPaymentMethodValidator,
    /**
     * SCRUM-54: the physical bank the money left from. Required for every method that
     * credits the bank control account (bank transfer, card, issued cheque); never
     * defaulted or inferred, and refused for cash.
     */
    bankAccountId: v.optional(v.id("bankAccounts")),
    /** When the dealership paid it. Dates the posting. */
    paidAt: v.number(),
    /**
     * REQUIRED: the amount, in minor units, the approver SAW and PINNED when
     * they opened the payment form (the screen holds it fixed; a later edit
     * raises a notice and needs an explicit re-approval). The payment posts the
     * line's actual only when it is still exactly this — an edit at any point
     * after the form opened is refused, never paid at a figure nobody approved.
     */
    expectedAmountMinor: v.number(),
    reference: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => recordDirectFeePaymentHandler(ctx, args, accounting),
});

export const listCustodyBankOptions = query({
  args: { orgId: v.id("organizations"), currency: v.string() },
  handler: async (ctx, args) => listCustodyBankOptionsHandler(ctx, args),
});

export const openDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    userId: v.id("users"),
    issuedMinor: v.number(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => openDealCustodyHandler(ctx, args, accounting),
});

export const recordCustodyMovement = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    kind: v.union(
      v.literal("ISSUED"),
      v.literal("RETURNED"),
      v.literal("REIMBURSED"),
      v.literal("REVERSAL")
    ),
    /** Required on a REVERSAL, rejected otherwise. */
    reversesEntryId: v.optional(v.id("financeDealCustodyEntries")),
    amountMinor: v.number(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => recordCustodyMovementHandler(ctx, args, accounting),
});

export const reconcileDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    notes: v.string(),
    /** Closes a genuinely unaccountable difference, recorded as a write-off. */
    writeOffReason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => reconcileDealCustodyHandler(ctx, args, accounting),
});

export const migrateLegacyCustodyToLedger = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => migrateLegacyCustodyToLedgerHandler(ctx, args, accounting),
});

export const reopenDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    reason: v.string(),
  },
  handler: async (ctx, args) => reopenDealCustodyHandler(ctx, args),
});

export const listCustodyCandidates = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => listCustodyCandidatesHandler(ctx, args),
});

export const planCustodyHandler = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** Omitted clears the plan. */
    userId: v.optional(v.id("users")),
    amountMinor: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => planDealCustody(ctx, args),
});

export const recordLegalInvoice = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    legalInvoiceAmountMinor: v.number(),
    legalInvoiceNumber: v.string(),
    legalInvoiceDate: v.number(),
    issuedTo: v.union(
      v.literal("CUSTOMER"),
      v.literal("FINANCE_COMPANY"),
      v.literal("OTHER")
    ),
    issuedToOther: v.optional(v.string()),
    /** Who issued the document. Omitted = the dealership, which a consigned car then refuses. */
    issuedBy: v.optional(v.union(v.literal("DEALERSHIP"), v.literal("THIRD_PARTY"))),
    /** The importer's or supplier's name; required when `issuedBy` is THIRD_PARTY. */
    issuerName: v.optional(v.string()),
    expectedEconomicsStamp: v.optional(v.string()),
    expectedInvoiceRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => recordLegalInvoiceHandler(ctx, args),
});
