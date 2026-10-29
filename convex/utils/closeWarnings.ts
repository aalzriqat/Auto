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
 * SCRUM-858 — owner ruling 2026-10-28: a subledger-to-GL difference in an
 * organization that has an opening balance is REPORTED under this label. No
 * journal, plug, clearing line or equity entry is ever posted to force the two
 * sides together; the difference stays visible until finance resolves its source.
 */
export const UNEXPLAINED_OPENING_DIFFERENCE_LABEL = {
  en: "Unexplained opening-balance reconciliation difference",
  ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة",
} as const;
