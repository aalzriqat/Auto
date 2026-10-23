import { scaleForCurrency } from "@/convex/utils/money";

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Exact user-input parser. No floating-point conversion or rounding occurs. */
export function parseOpeningMoneyMinor(input: string, currency: string): number | null {
  const scale = scaleForCurrency(currency);
  const normalized = input.trim().replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = ARABIC_DIGITS.indexOf(digit);
    return String(arabic >= 0 ? arabic : EASTERN_ARABIC_DIGITS.indexOf(digit));
  }).replaceAll("٫", ".");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match || (match[2]?.length ?? 0) > scale) return null;
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(scale, "0") || "0");
  const minor = whole * 10n ** BigInt(scale) + fractional;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
