/**
 * SCRUM-808: the readable deal number, shared by the backend and the UI.
 *
 * The stored value is a positive integer, unique per organization. The Convex
 * document id stays the deal's identity everywhere (routes, references,
 * relationships); this number is only how people say and find a deal.
 * Decision record: docs/adr/2026-11-04-per-organization-deal-number.md.
 *
 * Pure module: no server imports, so client components can use it.
 */

import { foldDigits } from "./supplierNames";

const DEAL_NUMBER_PREFIX = "D-";
/** Zero-pad to six digits. A seventh digit is added past 999999; the number never wraps. */
const DEAL_NUMBER_MIN_DIGITS = 6;

export function isValidDealNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** `123` → `"D-000123"`. Returns null for a deal that has no number yet (before the backfill reaches it). */
export function formatDealNumber(value: number | null | undefined): string | null {
  if (!isValidDealNumber(value)) return null;
  return `${DEAL_NUMBER_PREFIX}${String(value).padStart(DEAL_NUMBER_MIN_DIGITS, "0")}`;
}

/**
 * Reads what a person typed as a deal number: `D-000123`, `d-123`, `D123`, `#123`, `123`, or the same in Arabic-Indic
 * or fullwidth digits (NFKC, then the shared digit fold). Returns null when the text is not a deal number, so a search
 * box can fall back to its other matching.
 */
export function parseDealNumberQuery(input: string): number | null {
  const match = /^(?:d-?|#)?\s*(\d{1,15})$/i.exec(foldDigits(input.normalize("NFKC")).trim());
  if (!match) return null;
  const value = Number(match[1]);
  return isValidDealNumber(value) ? value : null;
}
