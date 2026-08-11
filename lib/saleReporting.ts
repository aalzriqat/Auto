/**
 * Client-side totals for the sales report.
 *
 * The reports page re-sums its rows locally so the figures respond to the
 * salesperson filter without a round trip. That means it decides, on its own,
 * which field is "revenue" — and it used to answer `salePrice`, which on a
 * consigned sale is the supplier's car, not the dealership's turnover. The
 * backend already excludes it (see `saleEconomics` in
 * convex/utils/vehicleOwnership.ts); this is the same rule on the other side of
 * the wire, so the filtered card cannot disagree with the unfiltered one.
 */

export interface ReportedSaleRow {
  /** What the customer transacted for. Not turnover on a consigned sale. */
  salePrice?: number | null;
  /** What the dealership may recognize: its margin on an agent sale, the price on an owned one. */
  recognizedRevenue?: number | null;
  totalCost?: number | null;
  netProfit?: number | null;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * An explicit `null` is the backend saying it could not establish what this
 * deal earned — a financed sale settled directly with the supplier whose
 * recorded margin is missing. It is NOT the same as the field being absent.
 *
 * The distinction decides real money on screen. `recognizedRevenueOf` falls
 * back to `salePrice` for an absent field, which is right for a client running
 * ahead of a backend deploy; applying that same fallback to a withheld value
 * would answer 20,000 for a deal that earned 3,000 — turning a deliberate
 * refusal into the largest wrong number available.
 */
export function marginIsUnknown(sale: ReportedSaleRow): boolean {
  return sale?.netProfit === null || sale?.recognizedRevenue === null;
}

/** How many of these rows contribute nothing to the totals because their earning is unknown. */
export function countUnknownMargin(sales: ReportedSaleRow[] | undefined | null): number {
  return (sales ?? []).filter((sale) => marginIsUnknown(sale)).length;
}

/** A salesperson row from the performance report. Both fields are new. */
export interface ReportedPerformanceRow {
  marginComplete?: boolean;
  unknownMarginSaleCount?: number;
}

/**
 * The absent-versus-withheld rule above, applied to the salesperson table.
 *
 * `main` auto-deploys the frontend while the Convex backend deploy is manual,
 * so this page will run for a while against a server that has never heard of
 * either field. Read as a plain falsy boolean, that marks EVERY salesperson
 * incomplete and prints `String(undefined)` as the count — while the notice
 * above the table, which already defaults with `?? 0`, says none. Absent is a
 * server that has not deployed yet; only an explicit `false` is the server
 * saying it could not count something.
 */
export function performanceMarginIsIncomplete(perf: ReportedPerformanceRow | undefined | null): boolean {
  return perf?.marginComplete === false;
}

/** Never `undefined`, so the count can never reach the screen as text. */
export function unknownMarginCountOf(perf: ReportedPerformanceRow | undefined | null): number {
  return perf?.unknownMarginSaleCount ?? 0;
}

/**
 * Falls back to `salePrice` only when the row predates `recognizedRevenue` —
 * a client running ahead of a backend deploy. Showing the old number beats
 * showing nothing, and for owned stock the two are identical anyway.
 *
 * A withheld (`null`) value never takes that path: see `marginIsUnknown`.
 */
export function recognizedRevenueOf(sale: ReportedSaleRow): number {
  if (marginIsUnknown(sale)) return 0;
  if (typeof sale?.recognizedRevenue === "number" && Number.isFinite(sale.recognizedRevenue)) {
    return sale.recognizedRevenue;
  }
  return finiteOrZero(sale?.salePrice);
}

export function sumRecognizedRevenue(sales: ReportedSaleRow[] | undefined | null): number {
  return (sales ?? []).reduce((sum, sale) => sum + recognizedRevenueOf(sale), 0);
}

export function sumReportedCost(sales: ReportedSaleRow[] | undefined | null): number {
  return (sales ?? []).reduce((sum, sale) => sum + finiteOrZero(sale?.totalCost), 0);
}

export function sumReportedProfit(sales: ReportedSaleRow[] | undefined | null): number {
  return (sales ?? []).reduce((sum, sale) => sum + finiteOrZero(sale?.netProfit), 0);
}
