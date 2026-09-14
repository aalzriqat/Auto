import { CURRENCY } from "./content";

/**
 * Latin digits in both locales — dealership staff read plate, VIN and price
 * digits in Latin form, and the app's own screens do the same.
 */
export function fmt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `JOD 50,500` in English, `50,500 د.أ` in Arabic. */
export function money(locale: string, n: number): string {
  const v = fmt(n);
  return locale === "ar" ? `${v} ${CURRENCY.ar}` : `${CURRENCY.en} ${v}`;
}

export type Amortized = Readonly<{
  principal: number;
  monthly: number;
  total: number;
  interest: number;
}>;

/** Standard amortisation. `apr` is a percentage (5.5 = 5.5%). */
export function amortize(value: number, downPct: number, apr: number, months: number): Amortized {
  const principal = value * (1 - downPct / 100);
  const r = apr / 100 / 12;
  const monthly = months <= 0 ? 0 : r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months));
  const total = monthly * months;
  return { principal, monthly, total, interest: total - principal };
}
