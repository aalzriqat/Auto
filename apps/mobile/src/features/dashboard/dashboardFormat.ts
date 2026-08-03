/**
 * Number formatting shared by the dealer home panels.
 *
 * `Intl` is available in Hermes, but a bad locale tag or a non-finite value
 * would throw inside a render; every helper here degrades to a plain number
 * rather than taking the screen down.
 */

function toSafe(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Abbreviated ("45K") — for headline figures that must not wrap. */
export function compactNumber(value: number, locale: "en" | "ar"): string {
  const safeValue = toSafe(value);

  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(safeValue);
  } catch {
    // NOT `toLocaleString()` — that routes through the same Intl machinery the
    // try block just failed in, so the fallback would throw inside a render.
    return Math.round(safeValue).toString();
  }
}

/** Grouped but not abbreviated ("45,250") — for counts. */
export function plainNumber(value: number, locale: "en" | "ar"): string {
  const safeValue = toSafe(value);

  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
    }).format(safeValue);
  } catch {
    return Math.round(safeValue).toString();
  }
}
