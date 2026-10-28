/**
 * The commission mode an organization actually runs under.
 *
 * SCRUM-778, owner ruling c23812 #6 (2026-10-28): an unset mode means
 * MANUAL. Automatic commissions require an explicit stored AUTO opt-in.
 * Resolve at read time so old organizations need no settings migration and
 * existing commission amounts are left untouched.
 *
 * Scope: the SALE commission (`orgSettings.commissionMode`). Purchase and
 * execution commissions (SCRUM-783) are separate settings.
 */
export type CommissionMode = "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL";

export const DEFAULT_COMMISSION_MODE: CommissionMode = "MANUAL";

export function effectiveCommissionMode(
  settings: { commissionMode?: CommissionMode } | null | undefined
): CommissionMode {
  return settings?.commissionMode ?? DEFAULT_COMMISSION_MODE;
}

export function isAutoCommissionMode(mode: CommissionMode): boolean {
  return mode === "AUTO_MEMBER" || mode === "AUTO_TIERS";
}
