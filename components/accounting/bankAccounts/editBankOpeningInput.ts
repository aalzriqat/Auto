import { supportedCurrencyScale } from "../../../convex/utils/money";
import { parseOpeningMoneyMinor } from "../setup/openingMoneyInput";

/**
 * SCRUM-945: exact parse of a stated opening amount, which may be negative (an overdrawn bank).
 * A thin wrapper: the digits are read by `parseOpeningMoneyMinor` (BigInt, no floating point, at the
 * currency's own scale); only one optional leading minus is handled here. Null for anything invalid.
 */
export function parseSignedOpeningMoneyMinor(input: string, currency: string): number | null {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-");
  try {
    const magnitude = parseOpeningMoneyMinor(negative ? trimmed.slice(1) : trimmed, currency);
    if (magnitude === null) return null;
    return negative && magnitude !== 0 ? -magnitude : magnitude;
  } catch {
    // An unsupported currency has no known scale; never guess one.
    return null;
  }
}

/** A stored minor amount as an exact decimal string at the currency's own scale (no floats). Null if the scale is unknown. */
export function minorToAmountInput(minor: number, currency: string): string | null {
  const scale = supportedCurrencyScale(currency);
  if (scale === null || !Number.isSafeInteger(minor)) return null;
  const digits = BigInt(Math.abs(minor)).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${minor < 0 ? "-" : ""}${whole}${scale > 0 ? `.${fraction}` : ""}`;
}
