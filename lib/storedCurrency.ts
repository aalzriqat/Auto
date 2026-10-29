/**
 * The organization's stored ISO currency code, for a screen that only renders
 * once `RequireOrgCurrency` has confirmed one is stored. Throws when there is
 * none, so an absent currency can never reach a money calculation as a guessed
 * code (SCRUM-85, owner ruling SCRUM-760 c23812 ruling 9).
 */
export function requireStoredCurrencyCode(code: string | null | undefined): string {
  if (!code) {
    throw new Error("The organization has no stored currency: this screen must render under RequireOrgCurrency.");
  }
  return code;
}
