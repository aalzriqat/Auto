/**
 * Employee commission lines registered against a deal.
 *
 * LEAF MODULE: imports nothing from the rest of the backend, so the pure
 * arithmetic here is testable and importable from anywhere.
 *
 * Pilot containment (SCRUM-760 narrow gate): registering a line is a new money
 * write that no review seat has certified, so the writers refuse server-side
 * while this switch is on. Hiding the button is not a block. The read side
 * (the deal screen's commissions row and the net profit after commissions)
 * works regardless, and shows the salesperson's existing commission.
 *
 * To enable: a reviewed code change that sets this to `false`, after the lines
 * are certified and the owner approves. Never an env var.
 */
export const DEAL_COMMISSION_LINES_PILOT_DISABLED = true as const;

export const DEAL_COMMISSION_KINDS = ["SALE", "PURCHASE", "EXECUTION"] as const;
export type DealCommissionKind = (typeof DEAL_COMMISSION_KINDS)[number];

/** A deal rarely has more than a handful; the cap keeps every read bounded. */
export const MAX_DEAL_COMMISSION_LINES = 20;
export const MAX_DEAL_COMMISSION_NOTE_LENGTH = 200;

export interface CommissionLineAmount {
  amountMinor: number;
}

/**
 * Sum of line amounts in minor units. Returns null when any amount is not a
 * safe non-negative integer or the sum would overflow: an unreadable amount
 * makes the total UNKNOWN, never a smaller number.
 */
export function sumCommissionMinor(
  lines: ReadonlyArray<CommissionLineAmount>
): number | null {
  let total = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0) return null;
    total += line.amountMinor;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * The deal's profit after its employee commissions, in minor units.
 *
 * `profitMinor` is the screen's existing net profit and is signed. Returns null
 * when either operand is unknown, so a missing figure is never shown as a
 * profit.
 */
export function netProfitAfterCommissionsMinor(
  profitMinor: number | null,
  commissionsMinor: number | null
): number | null {
  if (profitMinor === null || commissionsMinor === null) return null;
  if (!Number.isSafeInteger(profitMinor) || !Number.isSafeInteger(commissionsMinor)) return null;
  const net = profitMinor - commissionsMinor;
  return Number.isSafeInteger(net) ? net : null;
}
