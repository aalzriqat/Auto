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
 * Owner ruling (2026-10-19): multi-line commissions are ON for the pilot. The
 * lines accrue to the ledger, reverse on removal or cancellation, and are paid
 * through payroll (dealCommissionLinesLedger.test.ts). The switch stays as a
 * compile-time kill switch: set it back to `true` to refuse every writer again.
 * Never an env var.
 */
export const DEAL_COMMISSION_LINES_PILOT_DISABLED = false as const;

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

/** A single commission above this (major units) is refused as a typo. */
export const MAX_DEAL_COMMISSION_MAJOR = 1_000_000_000;

export type CommissionAmountResult =
  | { ok: true; minor: number }
  | { ok: false; reason: "invalid" | "nonpositive" | "decimals" | "range" };

/**
 * Exact minor units for a typed commission amount, or why it is refused.
 *
 * Works on the decimal text of the number (JavaScript prints the shortest text
 * that round-trips), not on `amount * 10^scale`, so the recorded figure is
 * exactly the typed one: no value is rounded into a different amount, and a
 * float that is only close to a valid amount (0.1 + 0.2, 50.0000000001) is
 * refused rather than snapped. Amounts above MAX_DEAL_COMMISSION_MAJOR are
 * refused so every accepted value is far inside the range where a double holds
 * its digits exactly.
 */
export function parseCommissionAmountMinor(amount: number, scale: number): CommissionAmountResult {
  if (!Number.isFinite(amount)) return { ok: false, reason: "invalid" };
  if (amount <= 0) return { ok: false, reason: "nonpositive" };
  if (amount > MAX_DEAL_COMMISSION_MAJOR) return { ok: false, reason: "range" };
  const text = String(amount);
  // Exponent form (1e-7) is more precision than any currency here holds.
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "decimals" };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale) return { ok: false, reason: "decimals" };
  const minor = Number(whole) * Math.pow(10, scale) + Number(fraction.padEnd(scale, "0") || "0");
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: "range" };
  return { ok: true, minor };
}
