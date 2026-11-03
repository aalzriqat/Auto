/**
 * Exact text of the supplier-payables close warnings that
 * accountingPeriods.closeChecklist emits when the reconciliation is UNAVAILABLE.
 *
 * The close mutation matches acknowledged warnings by exact string, so the
 * server text must never be localized or reworded in place. The close dialog
 * imports these same constants to translate them at display time only — one
 * definition, so the two sides cannot drift apart.
 */
export const SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING =
  "Supplier payables reconciliation could not be completed: accounting postings or drafts that affect supplier payables are still pending. Resolve them, then re-check.";

export const SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING =
  "Supplier payables reconciliation could not be completed: there are too many records to verify in one pass. Review supplier payables manually.";

/**
 * SCRUM-876: emitted when the supplier-payables comparison cannot be made as of the period end because a
 * supplier payable moved, or an AP posting is dated, after it (or the date is unusable). The subledger
 * is the payables' current state and cannot be restated to the period end. Server text is the
 * acknowledgement key; the close dialog translates it at display time only.
 */
export const SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING =
  "Supplier payables reconciliation could not be completed as of the period end: supplier payable or accounts payable activity is dated after that date (or the date is not usable), and the payables cannot be restated to it. Review supplier payables manually.";

/**
 * SCRUM-889: emitted when a journal line on the supplier-payables account is not consistent with the organization's
 * own records (its parent entry is missing or belongs to another organization, or the line carries another
 * organization's id), so the ledger side cannot be trusted. Server text is the acknowledgement key; the close dialog
 * translates it at display time only.
 */
export const SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING =
  "Supplier payables reconciliation could not be completed: a journal line on the supplier payables account is not consistent with this organization's records (its journal entry is missing or belongs to another organization, or the line carries another organization's id). Review the ledger manually.";

/**
 * SCRUM-889: emitted when the opening-balance source records behind an opening supplier payable cannot be read or do
 * not agree with the payable. Server text is the acknowledgement key; the close dialog translates it at display time only.
 */
export const SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING =
  "Supplier payables reconciliation could not be completed: the opening-balance source records of a supplier payable could not be verified. Review the opening balances manually.";

/**
 * The warning for an UNAVAILABLE supplier-payables reconciliation, chosen by its reason. A reason this function does not
 * name (OVER_LIMIT, or anything added later) keeps the over-limit text, as it did before the reasons were split, so a
 * new reason must be named here or it will be reported as "too many records".
 */
export function supplierPayablesUnavailableWarning(reason: string | undefined): string {
  if (reason === "PENDING_POSTINGS") return SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING;
  if (reason === "POST_CUTOFF_ACTIVITY" || reason === "INVALID_DATE") return SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING;
  if (reason === "INCONSISTENT_REFERENCE") return SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING;
  if (reason === "OPENING_SOURCE_UNAVAILABLE") return SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING;
  return SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING;
}

/**
 * SCRUM-858 (round-1 review F2): emitted when the customer-deposits comparison cannot be made as of
 * the period end because deposit activity is dated after it. Server text is the acknowledgement key,
 * like the two above; the close dialog translates it at display time only.
 */
export const CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING =
  "Customer deposits reconciliation could not be completed as of the period end: deposit activity was recorded after that date, and the deposit side cannot be restated to it. Review customer deposits manually.";

/**
 * SCRUM-858 — owner ruling 2026-10-28: a subledger-to-GL difference in an
 * organization that has an opening balance is REPORTED under this label. No
 * journal, plug, clearing line or equity entry is ever posted to force the two
 * sides together; the difference stays visible until finance resolves its source.
 */
export const UNEXPLAINED_OPENING_DIFFERENCE_LABEL = {
  en: "Unexplained opening-balance reconciliation difference",
  ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة",
} as const;
