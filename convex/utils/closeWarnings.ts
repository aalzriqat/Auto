/**
 * Exact text of the two supplier-payables close warnings that
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
