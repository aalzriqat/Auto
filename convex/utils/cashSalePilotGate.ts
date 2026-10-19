import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { outstandingFromReceivableDoc } from "../subledger";
import { CASH_SALE_EXTRAS_PILOT_REFUSED, CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED, refuseSaleDebt } from "./saleDebtContainment";

/**
 * SCRUM-802: pilot cash-sale containment. See `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED`.
 *
 * Invariant: while no door can apply a customer's payment to a sale invoice, a
 * CASH sale is completed only with its invoice already paid in full by
 * deposits alone (a trade-in does not count, see TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST), and money that cannot be tied to a sale is not
 * accepted from a customer who owes one (it would park as unapplied while the
 * invoice stays open).
 */

/** Documents read per customer; a customer never legitimately has more than a handful of sale invoices. */
const CUSTOMER_DOC_READ_LIMIT = 200;

/** A sale whose customer debt is a cash invoice: not financed, not leased, and no financed plan governs it. */
export function isCashCompletion(args: {
  financingType?: "CASH" | "FINANCED" | "LEASE";
  financedSalePlan?: unknown;
}): boolean {
  return args.financingType !== "FINANCED" && args.financingType !== "LEASE" && !args.financedSalePlan;
}

/**
 * Owner ruling (2026-10-19, "deposit only"): does a trade-in allocation count toward "pay in full first"?
 * No. Only deposits do, so a cash sale settled by a trade-in alone, or by a part deposit plus a trade-in, is refused.
 * Trade-in settlement of a cash sale is a post-pilot activation gate: flipping this to `true` is the one-line change,
 * and it needs a new certification round and the owner's approval. It is read only through
 * `cashSaleOutstandingForPayFirst`.
 */
export const TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST = false as const;

/**
 * The balance the pay-first rule judges: what is outstanding on the invoice, plus the trade-in allocation when the
 * rule says a trade-in does not count (it reduced the invoice, but it is not a deposit). `tradeInCounts` is for tests
 * of the pure rule only.
 */
export function cashSaleOutstandingForPayFirst(
  amounts: { outstandingMinor: number; tradeInAppliedMinor: number },
  tradeInCounts: boolean = TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST
): number {
  return tradeInCounts ? amounts.outstandingMinor : amounts.outstandingMinor + amounts.tradeInAppliedMinor;
}

/**
 * Refuses the completion when the cash sale's invoice is not fully paid BY DEPOSIT. Call it at the end of the
 * allocation block, inside the completing mutation, so the throw rolls back the sale, the vehicle status change, the
 * journal and the allocations. `tradeInAppliedMinor` is what this completion allocated from a trade-in (0 if none).
 */
export async function assertCashSaleInvoiceFullyPaid(
  ctx: MutationCtx,
  args: {
    financingType?: "CASH" | "FINANCED" | "LEASE";
    financedSalePlan?: unknown;
    saleReceivableId: Id<"receivableDocuments">;
    tradeInAppliedMinor?: number;
  }
): Promise<void> {
  if (!CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED || !isCashCompletion(args)) return;
  const doc = await ctx.db.get(args.saleReceivableId);
  if (!doc) return refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
  const outstandingMinor = await outstandingFromReceivableDoc(ctx, doc);
  if (cashSaleOutstandingForPayFirst({ outstandingMinor, tradeInAppliedMinor: args.tradeInAppliedMinor ?? 0 }) > 0) {
    refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
  }
}

const positive = (n: number | null | undefined): boolean => typeof n === "number" && n > 0;

/** True when the sale carries tax, dealer fees, a warranty or GAP: anything that makes the invoice larger than the price. */
export function carriesTaxFeesWarrantyOrGap(args: {
  taxAmount?: number | null;
  taxRate?: number | null;
  dealerFees?: number | null;
  warrantySold?: number | null;
  warrantyCost?: number | null;
  gapSold?: number | null;
  gapCost?: number | null;
}): boolean {
  return (
    positive(args.taxAmount) || positive(args.taxRate) || positive(args.dealerFees) ||
    positive(args.warrantySold) || positive(args.warrantyCost) || positive(args.gapSold) || positive(args.gapCost)
  );
}

/**
 * SCRUM-802 (owner ruling 2026-10-19): a CASH sale that carries tax, dealer fees, a warranty or GAP is not offered in
 * the pilot (see `CASH_SALE_EXTRAS_PILOT_REFUSED`). Pure and read-free, so every completion door calls it right after
 * tenant auth, before any write and before `runWithIdempotency`. Financed, leased and plan-governed sales are exempt
 * (they are completed by `applications.finalizeDeal`, which supplies none of these terms). `refused` is for tests of
 * the pure guard only.
 */
export function assertCashSaleCarriesNoExtras(
  args: Parameters<typeof carriesTaxFeesWarrantyOrGap>[0] & { financingType?: "CASH" | "FINANCED" | "LEASE"; financedSalePlan?: unknown },
  refused: boolean = CASH_SALE_EXTRAS_PILOT_REFUSED && CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED
): void {
  if (!refused || !isCashCompletion(args)) return;
  if (carriesTaxFeesWarrantyOrGap(args)) refuseSaleDebt("CASH_SALE_TAX_FEES_WARRANTY_REFUSED");
}

/** True when `sale` is a cash completion by the same predicate the completion guard uses (the plan marker lives on its application). */
async function saleIsCashCompletion(ctx: QueryCtx | MutationCtx, sale: Doc<"sales">): Promise<boolean> {
  const app = sale.applicationId ? await ctx.db.get(sale.applicationId) : null;
  return isCashCompletion({ financingType: sale.financingType, financedSalePlan: app?.financedSalePlanVersion });
}

/**
 * The door-level form for `sales.completeDraft`: the draft carries the money terms, so it is read (tenant-checked, no
 * write) and judged before `runWithIdempotency`. A draft that is missing, foreign or no longer PENDING falls through to
 * the completion's own refusals and replay handling.
 */
export async function assertCashDraftCarriesNoExtras(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<void> {
  if (!(CASH_SALE_EXTRAS_PILOT_REFUSED && CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED)) return;
  const sale = await ctx.db.get(saleId);
  if (!sale || sale.orgId !== orgId || sale.isDeleted || sale.status !== "PENDING") return;
  if (!(await saleIsCashCompletion(ctx, sale))) return;
  if (carriesTaxFeesWarrantyOrGap(sale)) refuseSaleDebt("CASH_SALE_TAX_FEES_WARRANTY_REFUSED");
}

/** True when `doc` is a customer's sale invoice that still has money outstanding. */
async function isOpenSaleInvoice(ctx: QueryCtx | MutationCtx, doc: Doc<"receivableDocuments">): Promise<boolean> {
  if (doc.sourceType !== "sales" || doc.payerType !== "CUSTOMER") return false;
  if (doc.status === "CANCELLED" || doc.status === "REVERSED" || doc.status === "WRITTEN_OFF" || doc.status === "PAID") return false;
  // A FINANCED/LEASE sale's invoice is the customer's gap to the dealer, which still stays open after finalize and
  // is paid in cash with no sale-linked door yet. Refusing there would leave handed-over cash unrecordable, so only
  // CASH sale invoices block (a sale that cannot be resolved is treated as cash: fail closed).
  const saleId = doc.sourceId ? ctx.db.normalizeId("sales", doc.sourceId) : null;
  const sale = saleId ? await ctx.db.get(saleId) : null;
  // The same predicate as the completion guard. The plan marker is not stored on the sale row; it lives on the
  // sale's finance application (`financedSalePlanVersion`), so it is read from there (`saleIsCashCompletion`).
  // The two markers can differ in form without differing in outcome: completion sees the in-flight plan object
  // (`args.financedSalePlan`), this reader sees the stored version, which is written only for forward plans. Any plan
  // is built for a named financier, so the sale it completes is stored as FINANCED and is excluded by `financingType`
  // alone; the stored marker is a second, independent exclusion. Pinned by "a sale governed by a financed plan..." in
  // scrum802CashSaleContainment.test.ts, which asserts the FINANCED label on a plan-governed sale.
  if (sale && !(await saleIsCashCompletion(ctx, sale))) return false;
  return (await outstandingFromReceivableDoc(ctx, doc)) > 0;
}

/**
 * Refuses an UNLINKED customer receipt (no receivable, no sale) while the
 * customer has any sale invoice with outstanding > 0. A customer with no open
 * sale invoice is unaffected, and a receipt aimed at a specific non-sale
 * receivable never reaches this check. A read that hits the limit cannot prove
 * absence and refuses.
 */
export async function assertNoOpenSaleInvoiceForUnlinkedReceipt(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  target: { receivableId?: Id<"receivables">; invoiceSaleId?: Id<"sales">; customerId?: Id<"customers"> }
): Promise<void> {
  if (!CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED) return;
  // A receipt or cheque that names a receivable or a sale invoice is LINKED, not unlinked: the invoice-targeted door
  // has its own containment (SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED) and must not be double-counted here.
  if (target.receivableId || target.invoiceSaleId || !target.customerId) return;
  const customerId = target.customerId;
  const docs = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
    .take(CUSTOMER_DOC_READ_LIMIT + 1);
  if (docs.length > CUSTOMER_DOC_READ_LIMIT) refuseSaleDebt("UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED");
  for (const doc of docs) {
    if (await isOpenSaleInvoice(ctx, doc)) refuseSaleDebt("UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED");
  }
}
