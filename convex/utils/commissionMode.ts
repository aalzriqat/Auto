/**
 * The commission mode an organization actually runs under.
 *
 * SCRUM-778 (owner ruling c22406): a dealership that never chose a mode is
 * MANUAL — commission is a manager's decision per deal, and nothing accrues
 * until one is entered. The automatic modes stay available, but only as an
 * explicit opt-in. Every reader, backend and screen, resolves the mode here so
 * the ledger and the page showing it cannot disagree about an unset setting.
 *
 * Scope: the SALE commission (`orgSettings.commissionMode`). Purchase and
 * execution commissions (SCRUM-783) are separate settings with the same
 * MANUAL-by-default rule; they get their own resolvers beside this one.
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
