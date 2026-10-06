/**
 * The sales wizard's money display policy (SCRUM-684, ruling c22074).
 *
 *  - Western digits (0-9) in both languages, with the numbering system set
 *    explicitly so the browser's Arabic locale cannot switch to ٠-٩.
 *  - A whole amount shows no decimals (car prices are whole dinars); anything
 *    else shows the currency's full minor-unit scale, so JOD fils are never
 *    rounded away (316.854, not 316.85).
 *  - Every figure carries its currency as a suffix: the ISO code in English,
 *    the short symbol in Arabic where one is known (د.أ for JOD).
 *
 * Deliberately separate from lib/currencyFormat.ts: that formatter's defaults
 * are shared with accounting screens, which this ruling does not change.
 * Dependency-free so it is directly unit-testable.
 */
import { supportedCurrencyScale } from "@/convex/utils/money";

export type MoneyLocale = "ar" | "en";

const ARABIC_SYMBOLS: Record<string, string> = {
  JOD: "د.أ",
};

/** The currency's minor-unit scale: AutoFlow's own table first, then Intl, then 2. */
export function moneyDisplayScale(currency: string): number {
  const known = supportedCurrencyScale(currency);
  if (known !== null) return known;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** The suffix shown beside a figure: "JOD" in English, "د.أ" in Arabic. */
export function moneyDisplayLabel(currency: string, locale: MoneyLocale): string {
  const code = currency.trim().toUpperCase();
  return (locale === "ar" && ARABIC_SYMBOLS[code]) || code;
}

/** The number alone, under the same digit and decimal rules (for inputs' hints and inline arithmetic). */
export function formatMoneyAmount(amount: number, currency: string, scale = moneyDisplayScale(currency)): string {
  if (!Number.isFinite(amount)) return "—";
  // Rounded once, by Intl's decimal rounding. Multiplying by 10^scale first is
  // a second, binary rounding: 128.0005 * 1000 is 128000.4999…, which showed a
  // whole "128" one fils below the real figure (Codex MD-2 on #458).
  const full = new Intl.NumberFormat("en-US", {
    numberingSystem: "latn",
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
    signDisplay: "negative",
  }).format(amount);
  // A figure that is whole at the currency's scale drops its zero decimals.
  return scale > 0 && /\.0+$/.test(full) ? full.replace(/\.0+$/, "") : full;
}

/**
 * A minor-unit figure (fils, cents) as a number under the display policy. The
 * scale comes from the factor the caller already derived from the currency, so
 * 316_500 fils reads "316.500" and 25_000_000 reads "25,000".
 */
/**
 * A typed major amount as an exact minor-unit integer, or null when it carries
 * more decimals than the currency holds (SCRUM-606). `Math.round` would
 * silently turn 12.3456 JOD into 12.346 and record a figure nobody typed.
 */
export function exactMinorFromMajor(major: number, scale: number): number | null {
  if (!Number.isFinite(major)) return null;
  const scaled = major * Math.pow(10, scale);
  const minor = Math.round(scaled);
  // Tolerance absorbs binary noise only (1.005 * 1000 = 1004.9999999999999).
  if (Math.abs(scaled - minor) > 1e-6 + Math.abs(scaled) * 1e-12) return null;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * A minor-unit figure (fils, cents) as a number under the display policy; the
 * scale comes from the factor the caller derived from the currency, so 316_500
 * fils reads "316.500" and 25_000_000 reads "25,000".
 */
export function formatMinorAmount(minor: number, factor: number): string {
  const scale = Math.max(0, Math.round(Math.log10(factor)));
  return formatMoneyAmount(minor / factor, "", scale);
}

/** "11,100 JOD" / "316.854 د.أ". `scale` overrides the currency's own when the server supplies it. */
export function formatMoneyDisplay(amount: number, currency: string, locale: MoneyLocale, scale?: number): string {
  if (!Number.isFinite(amount)) return "—";
  return `${formatMoneyAmount(amount, currency, scale)} ${moneyDisplayLabel(currency, locale)}`;
}
