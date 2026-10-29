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

/** Fixed text per family (the close mutation matches acknowledged warnings by exact string). */
export const OPENING_DIFFERENCE_WARNING_BY_FAMILY = {
  SUPPLIER_PAYABLES: `${UNEXPLAINED_OPENING_DIFFERENCE_LABEL.en}: supplier payables (current-state check). Nothing was posted to correct it; review the opening source.`,
  EMPLOYEE_ADVANCES: `${UNEXPLAINED_OPENING_DIFFERENCE_LABEL.en}: employee advances (current-state check). Nothing was posted to correct it; review the opening source.`,
  SUPPLIER_RECOVERABLES: `${UNEXPLAINED_OPENING_DIFFERENCE_LABEL.en}: supplier recoverables (current-state check). Nothing was posted to correct it; review the opening source.`,
  PARTNER_CAPITAL: `${UNEXPLAINED_OPENING_DIFFERENCE_LABEL.en}: partner capital (current-state check). Nothing was posted to correct it; review the opening source.`,
} as const;

export const OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY = {
  EMPLOYEE_ADVANCES: "Employee advances reconciliation could not be completed: accounting postings are still pending, the opening source is unavailable, or there are too many records to verify. Resolve them, then re-check.",
  SUPPLIER_RECOVERABLES: "Supplier recoverables reconciliation could not be completed: accounting postings are still pending, the opening source is unavailable, or there are too many records to verify. Resolve them, then re-check.",
  PARTNER_CAPITAL: "Partner capital reconciliation could not be completed: accounting postings are still pending, the opening source is unavailable, or there are too many records to verify. Resolve them, then re-check.",
} as const;
