/**
 * Which note explains a creation quotation AutoFlow did not calculate.
 *
 * An unconfirmed first-payment offset rule gets its own note (SCRUM-428): the
 * generic one gave the operator no way to know the fix is a company setting.
 * The quote froze the company's rules when it was created, so that note must
 * not promise that confirming the rule recalculates THIS quote.
 */
export function creationQuotationNoteKey(quotation: { available: boolean; reason?: string }) {
  if (quotation.available) return "CreationQuotationNotRecorded";
  if (quotation.reason === "NOT_CONFIGURED_COMPANY") return "CreationQuotationManualCompany";
  if (quotation.reason === "OFFSET_RULE_UNKNOWN") return "CreationQuotationOffsetRuleUnknown";
  return "CreationQuotationNotRecorded";
}
