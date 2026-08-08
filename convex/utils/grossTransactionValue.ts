import { Doc } from "../_generated/dataModel";

/**
 * Gross Transaction Value: the full ticket the customer transacted for.
 *
 * One definition, shared by the P&L, the sales-and-profit report and the
 * dashboard, because three screens reporting three different numbers under one
 * name is worse than not reporting it at all.
 *
 * ## What it is
 *
 * The size of the deal the dealership arranged, at face value:
 *
 *  - On dealer-owned stock it equals the sale price, which also equals revenue.
 *  - On a consigned (agent) sale it is still the whole sale price, even though
 *    only the margin is revenue and the rest is the supplier's. That is the
 *    point of reporting it: 12,500 handled, 3,000 earned, 9,500 owed onward are
 *    three separate facts, and each belongs in its own column.
 *
 * ## What it is not
 *
 *  - **Not revenue.** It never enters turnover, gross profit or net profit.
 *  - **Not affected by deposits.** A deposit is a payment against a deal, not a
 *    deal. Two customers buying identical 12,500 cars transacted for the same
 *    amount whether one of them paid 3,000 up front or not.
 *
 * That second rule is where the three screens disagreed. The `transactions`
 * VEHICLE_SALE row carries `amount` NET of anything already collected — so a
 * 12,500 sale with a 3,000 deposit lands as 9,500, and the P&L reported 9,500
 * of gross transaction value where the dashboard and the sales report, both
 * reading `sales.salePrice`, reported 12,500. Deposits therefore reduced
 * "gross" transaction value, which is precisely backwards.
 */

/** From the sale itself — the authoritative form. */
export function grossTransactionValueForSale(
  sale: Pick<Doc<"sales">, "salePrice">
): number {
  return sale.salePrice;
}

/**
 * From the legacy cashflow row, for the reports that read `transactions`.
 *
 * `grossTransactionValueAmount` is written at completion and is exact. Rows
 * written before it existed fall back to `amount`, which is net of whatever was
 * collected in advance and therefore UNDERSTATES the figure on any deal that
 * took a deposit. That is a bounded, enumerable gap on historical rows, not an
 * equivalent answer — do not treat the fallback as exact.
 */
export function grossTransactionValueForTransaction(
  tx: Pick<Doc<"transactions">, "amount" | "grossTransactionValueAmount">
): number {
  return tx.grossTransactionValueAmount ?? tx.amount;
}
