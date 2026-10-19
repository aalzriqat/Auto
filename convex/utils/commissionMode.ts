/**
 * The commission mode an organization actually runs under.
 *
 * SCRUM-778: an organization that never stored a mode keeps running
 * AUTO_MEMBER, exactly as before; deploying changes nothing for it. MANUAL is
 * an explicit owner choice made through `orgSettings.setCommissionMode`, which
 * is audited and is the only writer of the mode. Every reader, backend and
 * screen, resolves the mode here so the ledger and the page showing it cannot
 * disagree about an unset setting.
 *
 * Scope: the SALE commission (`orgSettings.commissionMode`). Purchase and
 * execution commissions (SCRUM-783) are separate settings.
 */
export type CommissionMode = "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL";

export const DEFAULT_COMMISSION_MODE: CommissionMode = "AUTO_MEMBER";

export function effectiveCommissionMode(
  settings: { commissionMode?: CommissionMode } | null | undefined
): CommissionMode {
  return settings?.commissionMode ?? DEFAULT_COMMISSION_MODE;
}

export function isAutoCommissionMode(mode: CommissionMode): boolean {
  return mode === "AUTO_MEMBER" || mode === "AUTO_TIERS";
}
