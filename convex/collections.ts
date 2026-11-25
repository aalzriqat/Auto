import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { listApprovalsHandler, requestApprovalHandler, respondToApprovalHandler } from "./collections/approvals";
import { assertAllocationsInactive } from "./collections/canonicalReceivables";
import {
  getReconciliationDraftHandler,
  listReconciliationsHandler,
  reviewCashierReconciliationHandler,
  submitCashierReconciliationHandler,
} from "./collections/cashierReconciliation";
import { returnClearedChequeHandler } from "./collections/chequeClearedReturns";
import { clearChequeHandler } from "./collections/chequeClearing";
import { replaceChequeHandler } from "./collections/chequeReplacement";
import {
  depositChequeHandler,
  markChequeClearedInTransaction,
  registerChequeHandler,
  registerChequeInTransaction,
  returnChequeHandler,
} from "./collections/chequeLifecycle";
import {
  agingReportHandler,
  dailyCollectionListHandler,
  listChequesHandler,
  listPaymentsHandler,
  listReceivablesDueBetweenHandler,
  listReceivablesHandler,
  summaryHandler,
  upcomingChequeReportHandler,
} from "./collections/collectionReads";
import {
  activateSaleInvoiceReceiptHandler,
  listSaleCustomerChequesHandler,
  registerSaleInvoiceChequeHandler,
  releaseSaleInvoiceReceiptHandler,
  reserveSaleInvoiceReceiptHandler,
  saleInvoiceReceiptStatusHandler,
} from "./collections/invoiceReceipts";
import { createInstallmentPlanHandler, createReceivableHandler } from "./collections/receivableCreation";
import { listReceiptBankOptionsHandler, recordPaymentHandler } from "./collections/paymentRecording";
import { getReminderPayloadHandler, markReminderResultHandler, processDailyCollectionRemindersHandler, processReminderRangeHandler } from "./collections/reminders";
import { applyRetainedCreditHandler, listRetainedCreditsHandler } from "./collections/retainedCredit";
import {
  approvalRequestTypeValidator,
  chequeStatusValidator,
  disbursementMethodValidator,
  paymentMethodValidator,
  receivableCreditKeyValidator,
  receivableSourceValidator,
  receivableStatusValidator,
} from "./collections/validators";
import { internalMutation, mutation } from "./functions";

export { COLLECTIONS_REPORT_ROW_CAP, COLLECTIONS_UPCOMING_CHEQUE_CAP } from "./collections/collectionReads";
export { ALLOCATION_HISTORY_PROBE_LIMIT } from "./collections/canonicalReceivables";

export async function assertNoActiveAllocations(...args: Parameters<typeof assertAllocationsInactive>) {
  return assertAllocationsInactive(...args);
}

export async function registerChequeCore(...args: Parameters<typeof registerChequeInTransaction>) {
  return registerChequeInTransaction(...args);
}

export async function markChequeClearedCore(...args: Parameters<typeof markChequeClearedInTransaction>) {
  return markChequeClearedInTransaction(...args);
}

export const summary = query({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => summaryHandler(ctx, args),
});

export const listReceivables = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(receivableStatusValidator),
  },
  handler: (ctx, args) => listReceivablesHandler(ctx, args),
});

/**
 * Phase 41 — Installment Collections Calendar. Unlike listReceivables (load-
 * more pagination for a list view), this pulls every open receivable due
 * within a bounded date range (a visible calendar month) so the UI can group
 * them by day. Excludes settled statuses so cleared installments don't
 * clutter the calendar.
 */
export const listReceivablesDueBetween = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: (ctx, args) => listReceivablesDueBetweenHandler(ctx, args),
});

export const listCheques = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(chequeStatusValidator),
  },
  handler: (ctx, args) => listChequesHandler(ctx, args),
});

export const listPayments = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => listPaymentsHandler(ctx, args),
});

/**
 * SCRUM-218-C — the retained customer credit an organization still owes back.
 *
 * ⚠️ THIS EXISTS BECAUSE THE LIABILITY WAS OTHERWISE UNREACHABLE (Codex R04).
 * `recordPayment` returns only the collection payment id and `listPayments`
 * exposes neither the movement nor the position, so `applyRetainedCredit` — which
 * needs a `receiptMovementId` — had no supported way for an operator to obtain
 * its own argument. A retained liability with no discoverable discharge path is
 * functionally the "ship A without C" outcome the owner refused, reached by a
 * different route. My own tests hid the gap by reading the movement id straight
 * out of the database, which is exactly why it stayed invisible.
 *
 * Reads positions rather than movements: a position exists only where credit was
 * actually retained, so "no row" and "drawn down to zero" stay distinguishable.
 * `VIEW_FINANCE` rather than `MANAGE_FINANCE` — seeing what the dealership owes
 * a customer is a reporting act; only applying it moves money.
 */
export const listRetainedCredits = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.optional(v.id("customers")),
    /**
     * Omit or pass false to include positions already drawn to zero.
     *
     * ⚠️ THIS FILTERS THE PAGE, NOT THE QUERY, so a page can come back shorter
     * than `numItems` — even empty — while `isDone` is still false. A caller
     * must loop on `continueCursor` / `isDone` and never treat
     * `page.length < numItems` as the end of the results. Filtering inside the
     * paginated range is the alternative and it is worse: it would make the
     * cursor's meaning depend on a boolean argument.
     */
    onlyRemaining: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => listRetainedCreditsHandler(ctx, args),
});

/** Completed-sale customer invoice and its parked receipt applications. */
export const saleInvoiceReceiptStatus = query({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => saleInvoiceReceiptStatusHandler(ctx, args),
});

/** Unassigned customer cheques that can become retained credit after clearing. */
export const listSaleCustomerCheques = query({
  args: { orgId: v.id("organizations"), saleId: v.id("sales"),
    paginationOpts: paginationOptsValidator },
  handler: (ctx, args) => listSaleCustomerChequesHandler(ctx, args),
});

/** Register a customer cheque for the currently uncovered invoice amount. */
export const registerSaleInvoiceCheque = mutation({
  args: { orgId: v.id("organizations"), saleId: v.id("sales"),
    bank: v.string(), chequeNumber: v.string(), chequeDate: v.number(),
    amountMinor: v.number() },
  handler: (ctx, args) => registerSaleInvoiceChequeHandler(ctx, args),
});

/** Park existing retained 2110 credit for a completed sale's exact invoice. */
export const reserveSaleInvoiceReceipt = mutation({
  args: {
    orgId: v.id("organizations"), saleId: v.id("sales"),
    receiptMovementId: v.id("receiptMovements"), amountMinor: v.number(),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => reserveSaleInvoiceReceiptHandler(ctx, args),
});

/** Activate only after the exact receipt and sale journals are POSTED. */
export const activateSaleInvoiceReceipt = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("invoiceReceiptApplications"),
    amountMinor: v.number(), idempotencyKey: v.string(),
  },
  handler: (ctx, args) => activateSaleInvoiceReceiptHandler(ctx, args),
});

/** Release an unactivated invoice claim while keeping the customer credit. */
export const releaseSaleInvoiceReceipt = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    applicationId: v.id("invoiceReceiptApplications"),
  },
  returns: v.null(),
  handler: (ctx, args) => releaseSaleInvoiceReceiptHandler(ctx, args),
});

export const createReceivable = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    sourceType: receivableSourceValidator,
    title: v.string(),
    amount: v.number(),
    dueDate: v.number(),
    notes: v.optional(v.string()),
    creditSystemKey: v.optional(receivableCreditKeyValidator),
    // SCRUM-57, classified during RC integration (SCRUM-313) after this command
    // was first disclosed as "writes only a receivable row, no GL". THAT WAS
    // WRONG, and the mistake was reading `ctx.db.insert` calls instead of
    // reading the helper below: `hookReceivableCreated` emits a real
    // RECEIVABLE_CREATED event through the posting pipeline, whose accounting
    // idempotency key is `receivable_created_${receivableId}`.
    //
    // The receivable id is minted per call, so a lost-response retry mints a
    // NEW id, a NEW accounting key and a SECOND journal — the downstream dedupe
    // is structurally blind to it. Only an identity minted at the INTENT
    // boundary can tell a retry from a genuine second debt.
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => createReceivableHandler(ctx, args),
});

export const createInstallmentPlan = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    title: v.string(),
    totalAmount: v.number(),
    installmentCount: v.number(),
    firstDueDate: v.number(),
    intervalMonths: v.optional(v.number()),
    sourceType: v.optional(receivableSourceValidator),
    notes: v.optional(v.string()),
    creditSystemKey: v.optional(receivableCreditKeyValidator),
    // SCRUM-57 / SCRUM-313. This command emits ONE `RECEIVABLE_CREATED` event
    // PER GENERATED INSTALLMENT, each keyed on its own freshly minted
    // receivable id, so a retry duplicates the ENTIRE PLAN — N debts and N
    // journals — with nothing downstream able to recognise it.
    //
    // ⚠️ The identity therefore represents the WHOLE PLAN INTENT, never an
    // individual installment. A per-row identity would let a retry mint
    // installments 13..24 under the first plan's name: a second plan wearing
    // the first one's identity, which is worse than no protection at all.
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => createInstallmentPlanHandler(ctx, args),
});

/**
 * SCRUM-54: the banks a bank-bound receipt may name - active banks in the organization
 * currency, id/name/currency only. Same permission as `recordPayment`.
 */
export const listReceiptBankOptions = query({
  args: { orgId: v.id("organizations"), currency: v.optional(v.string()) },
  handler: (ctx, args) => listReceiptBankOptionsHandler(ctx, args),
});

export const recordPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.optional(v.id("customers")),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    /** SCRUM-724: bounds a generic retained receipt to a sale invoice without attributing it as legacy sale AR. */
    invoiceSaleId: v.optional(v.id("sales")),
    amount: v.number(),
    method: paymentMethodValidator,
    /**
     * SCRUM-54: the physical bank a BANK_TRANSFER / CARD receipt reached. Required for
     * those methods (never defaulted or inferred), refused for the others.
     */
    bankAccountId: v.optional(v.id("bankAccounts")),
    paymentDate: v.number(),
    reference: v.optional(v.string()),
    notes: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => recordPaymentHandler(ctx, args),
});

/**
 * SCRUM-218-C part C — apply retained customer credit to a receivable.
 *
 * DR 2110 Unapplied Customer Receipts / CR Customer AR. No cash moves: the money
 * arrived when the receipt posted. Without this operation the 2110 liability
 * created by a no-receivable receipt could never be discharged, which is why
 * owner-proxy `c17653` refused to ship the receipt-side split on its own.
 *
 * ## Exact retry vs. a genuine second application
 *
 * These are different events and the distinction is the caller's to state.
 * Applications #1, #2 and #3 against one receipt are three legitimate economic
 * occurrences, each with its own sequence, identity and journal. An exact RETRY
 * of #1 must produce one effect, and the way a client says "this is a retry" is
 * by replaying the same `idempotencyKey`. The `fingerprint` then makes that
 * claim checkable: the same key with materially different inputs is rejected
 * rather than silently returning the first result.
 *
 * Omitting the key means "this is a new application", which is the correct
 * default for an operator clicking Apply a second time on purpose.
 */
export const applyRetainedCredit = mutation({
  args: {
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    receivableId: v.id("receivables"),
    requestedAmount: v.number(),
    appliedAt: v.optional(v.number()),
    // SCRUM-57, classified during RC integration (SCRUM-313). This command did
    // not exist when SCRUM-57's artifact was authored — SCRUM-218-C added it
    // afterwards — so nothing in that artifact protects it. It relieves a
    // receivable against a retained receipt and posts to the GL, which is an
    // at-most-once effect on money, so the identity is MANDATORY here exactly
    // as it is for every other economic command, not a caller courtesy.
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => applyRetainedCreditHandler(ctx, args),
});

export const registerCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: (ctx, args) => registerChequeHandler(ctx, args),
});

export const depositCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    depositedDate: v.optional(v.number()),
  },
  handler: (ctx, args) => depositChequeHandler(ctx, args),
});

export const clearCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    clearedAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => clearChequeHandler(ctx, args),
});

export const returnCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
  },
  handler: (ctx, args) => returnChequeHandler(ctx, args),
});

export const replaceCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    /** Customer cheques only. A finance-company cheque takes `faceAmount`. */
    amount: v.optional(v.number()),
    /** SCRUM-447 D1: a finance-company cheque's face, as a decimal string. */
    faceAmount: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: (ctx, args) => replaceChequeHandler(ctx, args),
});

/**
 * Returns a cheque that has already been CLEARED by the bank.
 * Reverses the original clearing accounting event, reopens the receivable
 * balance, and optionally records a bank return fee.
 */
export const returnClearedCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnReason: v.optional(v.string()),
    bankFeeMinor: v.optional(v.number()),
    bankFeeBankAccountId: v.optional(v.id("bankAccounts")),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => returnClearedChequeHandler(ctx, args),
});

export const requestApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.id("receivables"),
    requestType: approvalRequestTypeValidator,
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    disbursementMethod: v.optional(disbursementMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    reason: v.string(),
  },
  handler: (ctx, args) => requestApprovalHandler(ctx, args),
});

export const listApprovals = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED"))),
  },
  handler: (ctx, args) => listApprovalsHandler(ctx, args),
});

export const respondToApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("collectionApprovalRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    decisionNotes: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => respondToApprovalHandler(ctx, args),
});

export const getReconciliationDraft = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: (ctx, args) => getReconciliationDraftHandler(ctx, args),
});

export const submitCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
    countedCash: v.number(),
    notes: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: (ctx, args) => submitCashierReconciliationHandler(ctx, args),
});

export const listReconciliations = query({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => listReconciliationsHandler(ctx, args),
});

export const reviewCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    reconciliationId: v.id("cashierReconciliations"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
  },
  handler: (ctx, args) => reviewCashierReconciliationHandler(ctx, args),
});

export const dailyCollectionList = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: (ctx, args) => dailyCollectionListHandler(ctx, args),
});

export const upcomingChequeReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: (ctx, args) => upcomingChequeReportHandler(ctx, args),
});

export const agingReport = query({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => agingReportHandler(ctx, args),
});

const reminderResumeValidator = v.object({
  orgId: v.id("organizations"),
  step: v.number(),
});

export const processReminderRange = internalMutation({
  args: {
    orgId: v.id("organizations"),
    step: v.number(),
    cursor: v.union(v.string(), v.null()),
    now: v.number(),
    indexVersion: v.optional(v.literal("active-v1")),
  },
  handler: (ctx, args) => processReminderRangeHandler(ctx, args),
});

export const processDailyCollectionReminders = internalMutation({
  // `cursor`, `now` and `resume` are supplied by this mutation's own scheduled
  // continuations; the cron itself invokes it with no arguments. `now` pins every
  // continuation of one sweep to the same windows. `resume` finishes ONE
  // organization's remaining rows and does not walk the organization list.
  args: {
    cursor: v.optional(v.string()),
    now: v.optional(v.number()),
    resume: v.optional(reminderResumeValidator),
  },
  handler: (ctx, args) => processDailyCollectionRemindersHandler(ctx, args),
});

export const getReminderPayload = internalQuery({
  args: { reminderId: v.id("collectionReminders") },
  handler: (ctx, args) => getReminderPayloadHandler(ctx, args),
});

export const markReminderResult = internalMutation({
  args: {
    reminderId: v.id("collectionReminders"),
    status: v.union(v.literal("SENT"), v.literal("FAILED"), v.literal("SKIPPED")),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) => markReminderResultHandler(ctx, args),
});
