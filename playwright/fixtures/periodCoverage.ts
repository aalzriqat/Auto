/**
 * What the Accounting Periods table shows, read back as data.
 *
 * `range` is the date cell, "MMM d, yyyy - MMM d, yyyy" (formatAccountingDate in
 * components/accounting/setup/types.ts). It is formatted in the browser's time
 * zone, so it only equals the stored UTC day bounds when that zone is UTC; the
 * caller refuses to interpret it otherwise.
 */
export type DisplayedPeriodRow = { label: string; status: string; range: string };

const DAY_MS = 86_400_000;

export function parseDisplayedRange(range: string): { startMs: number; endMs: number } | null {
  const parts = range.split(" - ");
  if (parts.length !== 2) return null;
  const [startMs, endDayMs] = parts.map((day) => Date.parse(`${day.trim()} UTC`));
  if (Number.isNaN(startMs) || Number.isNaN(endDayMs)) return null;
  return { startMs, endMs: endDayMs + DAY_MS - 1 };
}

/**
 * The OPEN row whose dates contain `instantMs`, by its dates and not its label:
 * a full-year period labelled 2026-01 covers September. A row whose dates cannot
 * be read never counts as covering.
 */
export function openPeriodCovering(rows: readonly DisplayedPeriodRow[], instantMs: number): DisplayedPeriodRow | null {
  return (
    rows.find((row) => {
      if (row.status !== "Open") return false;
      const bounds = parseDisplayedRange(row.range);
      return bounds !== null && bounds.startMs <= instantMs && instantMs <= bounds.endMs;
    }) ?? null
  );
}
