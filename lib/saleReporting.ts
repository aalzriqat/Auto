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
 * Falls back to `salePrice` only when the row predates `recognizedRevenue` —
 * a client running ahead of a backend deploy. Showing the old number beats
 * showing nothing, and for owned stock the two are identical anyway.
 */
export function recognizedRevenueOf(sale: ReportedSaleRow): number {
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
