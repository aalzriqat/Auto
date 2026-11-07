/** SCRUM-565: shared runtime admission and schema-coverage registry. */
export const KNOWN_SURVIVING_REFERENCES: Record<string, string> = {
  "claims.vehicleId->vehicles": "Refuse all claims before deleting their optional vehicle basis.",
  "dealUnwinds.forwardReturn.forwardId->financeCompanyForwards": "Refuse unwind state before deleting its forward evidence.",
  "marketplaceWhatsAppFlows.vehicleEditId->vehicleEdits": "Refuse pending inventory flow state before deleting its edit.",
  "openingBalanceDrafts.allocationResults[].payableId->vehicleSupplierPayables": "Refuse opening drafts on fresh admission; existing continuations clear results before deleting payables.",
  "openingBalanceDrafts.allocationResults[].vehicleId->vehicles": "Refuse opening drafts carrying opening vehicle result references.",
  "openingBalanceDrafts.allocations[].vehicleId->vehicles": "Refuse opening drafts carrying allocated vehicle references.",
  "applicationDocuments.applicationId->financeApplications":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "bankStatementLines.matchedJournalLineId->journalLines":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "cashMovements.accountingEventId->accountingEvents":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.receivableDocumentId->receivableDocuments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.saleId->sales":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionReminders.chequeId->postDatedCheques":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionReminders.receivableId->receivables":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "dealerProductDeferrals.saleId->sales":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  // SCRUM-693: an unwind is an audit record of a deal's reversal, like its
  // sibling `financeCompanyForwards`; same SCRUM-546 document-only treatment.
  "dealUnwinds.applicationId->financeApplications":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "dealUnwinds.completion.customerReceiptSettlement.refundEventIds[]->accountingEvents":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "dealUnwinds.completion.customerReceiptSettlement.refundPaymentIds[]->canonicalPayments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "dealUnwinds.remittanceRefund.paymentId->canonicalPayments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "dealUnwinds.remittanceRefund.reversedAllocationIds[]->paymentAllocations":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "dealUnwinds.saleId->sales":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "customerFinanceCompanyPayments.applicationId->financeApplications":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row. Same shape and decision as financeCompanyForwards.applicationId; nothing reads the evidence except through its application.",
  "employeeAdvanceRecoveries.payrollItemId->payrollItems":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  // SCRUM-411 P2-02: the per-deposit provenance of a forward; same treatment as its parent forward row.
  "fixedAssetEvents.accountingEventId->accountingEvents":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "manualJournalDrafts.journalEntryId->journalEntries":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "manualJournalDrafts.lines[].accountId->chartOfAccounts":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.journalEntryId->journalEntries":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.lines[].accountId->chartOfAccounts":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  // SCRUM-546 c21566 leaves the opening draft outside the reset. The new
  // allocation references therefore survive with the same documented risk as
  // its older line/journal references. This is not a cleanup or release pass:
  // source-basis readers must report UNAVAILABLE after their target is deleted.
  "openingBalanceDrafts.allocations[].accountId->chartOfAccounts":
    "Fresh-start refusal: opening drafts survive reset while their allocated chart account is deleted; posted basis cannot be reused without the actual journal/account.",
  "openingBalanceDrafts.allocationResults[].receivableId->receivables":
    "Fresh-start refusal: opening drafts survive reset while their materialized receivable is deleted; collections and readback must refuse unavailable basis.",
  "openingBalanceDrafts.allocationResults[].canonicalReceivableDocumentId->receivableDocuments":
    "Fresh-start refusal: opening drafts survive reset while their canonical document is deleted; collections and readback must refuse unavailable basis.",
  // SCRUM-858 S1: a named opening deposit is recorded in its row's result. The draft survives the
  // reset while the deposit is deleted with the rest of the deposits. Posted readback treats a
  // missing, deleted or mismatched deposit as record-unavailable (`accountingCutover.ts`,
  // CUSTOMER_DEPOSIT branch), so the survivor is reported UNAVAILABLE, never read as a balance.
  "openingBalanceDrafts.allocationResults[].depositId->deposits":
    "Fresh-start refusal: opening drafts survive reset while their materialized named deposit is deleted; posted readback must report the record unavailable.",
  "partnerEquityTransactions.accountingEventId->accountingEvents":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.canonicalPaymentId->canonicalPayments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.collectionPaymentId->collectionPayments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.paymentAllocationId->paymentAllocations":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableDocumentId->receivableDocuments":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableId->receivables":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.saleId->sales":
    "Fresh-start refusal: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "prepaidExpenseSchedules.expenseId->expenses":
    "Fresh-start refusal: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
};
