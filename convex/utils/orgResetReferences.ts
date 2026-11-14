/** SCRUM-565: shared runtime admission and schema-coverage registry. */
type SurvivingReferenceDisposition = { required: boolean; detail?: string } | { reason: string };

const SURVIVING_REFERENCE_DISPOSITIONS = {
  "claims.vehicleId->vehicles": { reason: "Refuse all claims before deleting their optional vehicle basis." },
  "dealUnwinds.forwardReturn.forwardId->financeCompanyForwards": { reason: "Refuse unwind state before deleting its forward evidence." },
  "marketplaceWhatsAppFlows.vehicleEditId->vehicleEdits": { reason: "Refuse pending inventory flow state before deleting its edit." },
  "openingBalanceDrafts.allocationResults[].payableId->vehicleSupplierPayables": { reason: "Refuse opening drafts on fresh admission; existing continuations clear results before deleting payables." },
  "openingBalanceDrafts.allocationResults[].vehicleId->vehicles": { reason: "Refuse opening drafts carrying opening vehicle result references." },
  "openingBalanceDrafts.allocations[].vehicleId->vehicles": { reason: "Refuse opening drafts carrying allocated vehicle references." },
  "applicationDocuments.applicationId->financeApplications": { required: true },
  "bankStatementLines.matchedJournalLineId->journalLines": { required: false },
  "cashMovements.accountingEventId->accountingEvents": { required: false },
  "claims.receivableDocumentId->receivableDocuments": { required: false },
  "claims.saleId->sales": { required: false },
  "collectionReminders.chequeId->postDatedCheques": { required: false },
  "collectionReminders.receivableId->receivables": { required: false },
  "dealerProductDeferrals.saleId->sales": { required: true },
  // SCRUM-693: an unwind is an audit record of a deal's reversal, like its
  // sibling `financeCompanyForwards`; same SCRUM-546 document-only treatment.
  "dealUnwinds.applicationId->financeApplications": { required: true },
  "dealUnwinds.completion.customerReceiptSettlement.refundEventIds[]->accountingEvents": { required: false },
  "dealUnwinds.completion.customerReceiptSettlement.refundPaymentIds[]->canonicalPayments": { required: false },
  "dealUnwinds.remittanceRefund.paymentId->canonicalPayments": { required: false },
  "dealUnwinds.remittanceRefund.reversedAllocationIds[]->paymentAllocations": { required: false },
  "dealUnwinds.saleId->sales": { required: true },
  "customerFinanceCompanyPayments.applicationId->financeApplications": { required: true, detail: " Same shape and decision as financeCompanyForwards.applicationId; nothing reads the evidence except through its application." },
  "employeeAdvanceRecoveries.payrollItemId->payrollItems": { required: false },
  // SCRUM-411 P2-02: the per-deposit provenance of a forward; same treatment as its parent forward row.
  "fixedAssetEvents.accountingEventId->accountingEvents": { required: false },
  "manualJournalDrafts.journalEntryId->journalEntries": { required: false },
  "manualJournalDrafts.lines[].accountId->chartOfAccounts": { required: true },
  "openingBalanceDrafts.journalEntryId->journalEntries": { required: false },
  "openingBalanceDrafts.voidRequest.reversalJournalEntryId->journalEntries": { required: false },
  "openingBalanceDrafts.lines[].accountId->chartOfAccounts": { required: true },
  // SCRUM-546 c21566 leaves the opening draft outside the reset. The new
  // allocation references therefore survive with the same documented risk as
  // its older line/journal references. This is not a cleanup or release pass:
  // source-basis readers must report UNAVAILABLE after their target is deleted.
  "openingBalanceDrafts.allocations[].accountId->chartOfAccounts": { reason: "Fresh-start refusal: opening drafts survive reset while their allocated chart account is deleted; posted basis cannot be reused without the actual journal/account." },
  "openingBalanceDrafts.allocationResults[].receivableId->receivables": { reason: "Fresh-start refusal: opening drafts survive reset while their materialized receivable is deleted; collections and readback must refuse unavailable basis." },
  "openingBalanceDrafts.allocationResults[].canonicalReceivableDocumentId->receivableDocuments": { reason: "Fresh-start refusal: opening drafts survive reset while their canonical document is deleted; collections and readback must refuse unavailable basis." },
  // SCRUM-858 S1: a named opening deposit is recorded in its row's result. The draft survives the
  // reset while the deposit is deleted with the rest of the deposits. Posted readback treats a
  // missing, deleted or mismatched deposit as record-unavailable (`accountingCutover.ts`,
  // CUSTOMER_DEPOSIT branch), so the survivor is reported UNAVAILABLE, never read as a balance.
  "openingBalanceDrafts.allocationResults[].depositId->deposits": { reason: "Fresh-start refusal: opening drafts survive reset while their materialized named deposit is deleted; posted readback must report the record unavailable." },
  "partnerEquityTransactions.accountingEventId->accountingEvents": { required: false },
  "paymentIntents.canonicalPaymentId->canonicalPayments": { required: false },
  "paymentIntents.collectionPaymentId->collectionPayments": { required: false },
  "paymentIntents.paymentAllocationId->paymentAllocations": { required: false },
  "paymentIntents.receivableDocumentId->receivableDocuments": { required: false },
  "paymentIntents.receivableId->receivables": { required: false },
  "paymentIntents.saleId->sales": { required: false },
  "prepaidExpenseSchedules.expenseId->expenses": { required: true },
} satisfies Record<string, SurvivingReferenceDisposition>;

function survivingReferenceReason(disposition: SurvivingReferenceDisposition): string {
  if ("reason" in disposition) return disposition.reason;
  const requirement = disposition.required ? "REQUIRED" : "optional";
  return `Fresh-start refusal: table is NOT cleared by the reset; ${requirement} reference survives pointing at a reset-deleted row.${disposition.detail ?? ""}`;
}

export const KNOWN_SURVIVING_REFERENCES: Record<string, string> = Object.fromEntries(
  Object.entries(SURVIVING_REFERENCE_DISPOSITIONS).map(([key, disposition]) => [key, survivingReferenceReason(disposition)])
);
