import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { outstandingFromReceivableDoc } from "../subledger";
import { allocatedDepositForVehicle } from "./depositAllocation";
import { selectOpeningDepositsForSale } from "./openingDepositSelection";
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
 * Trade-in settlement of a cash sale is a post-pilot activation gate. This constant is read only through
 * `cashSaleOutstandingForPayFirst` (the exact post-allocation gate). The read-only pre-write check
 * `assertCashSaleDepositsPayInvoiceBeforeWrites` never reads it: it counts deposits only, by construction. So flipping this
 * to `true` does NOT enable trade-in settlement; that needs a real rule change (the pre-write check as well), a new
 * certification round and the owner's approval. A test pins the constant at `false`.
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

/** What the completion's deposit resolution is told to do with the held deposit (mirrors `args.depositResolution`). */
export type PayFirstDepositTreatment =
  | "APPLY_TO_DEALER_AMOUNT"
  | "APPLY_TO_TRANSACTION_SETTLEMENT"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED"
  | "OTHER";

/**
 * The READ-ONLY, pre-write form of the pay-first rule (Codex Seat 2: the refusal must come before the first sale write on
 * every completion path, not be rolled back after the writes). It derives, WITHOUT writing, the amount
 * `resolveReservationDeposits` would apply to this car's customer invoice, and refuses on the exact unpaid balance:
 *
 *  - only the car's own held, allocated deposit can be applied (`allocatedDepositForVehicle`); a forfeited, refunded or
 *    already-applied deposit is not "held" and a trade-in never counts (`TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST` is not
 *    read here: this check counts deposits only, by construction);
 *  - the stated treatment decides whether that money reaches the invoice: no treatment, APPLY_TO_DEALER_AMOUNT and
 *    APPLY_TO_TRANSACTION_SETTLEMENT on the dealership-collects-gross route (or owned stock) are applied against the
 *    invoice; REFUND_TO_CUSTOMER, FORFEITED, OTHER and the supplier-settlement route apply nothing to it;
 *  - this holds for a deposit shared between cars as well: REFUND_TO_CUSTOMER, FORFEITED and OTHER never pay the invoice;
 *  - a case the completion refuses for its own reason and that could still pay (a deposit larger than the bill with no
 *    treatment stated, an unallocated multi-car deposit) is left to that refusal, which has always come first.
 *
 * Known limits, all failing closed: (a) for REFUND_TO_CUSTOMER / FORFEITED / OTHER the unpaid-balance refusal now comes
 * BEFORE the release path's own refusals ("Deposit creator cannot resolve their own deposit refund or forfeiture", the
 * shared-deposit refund/other refusals, the OTHER-needs-a-reason refusal); both are refusals and nothing is written. (b) `allocatedDepositForVehicle` reads a hold-less
 * deposit on a quote as the single-vehicle shape without checking `deposit.vehicleId`; `deposits.create` writes hold rows
 * for multi-vehicle quotes, so only a legacy hold-less deposit on a multi-vehicle quote can pass this check wrongly, and
 * the post-allocation backstop then refuses it and the transaction rolls it back.
 *
 * `assertCashSaleInvoiceFullyPaid` after the allocations stays as the backstop on the actual invoice balance.
 */
export async function assertCashSaleDepositsPayInvoiceBeforeWrites(
  ctx: QueryCtx | MutationCtx,
  args: {
    quoteId?: Id<"quotes">;
    vehicleId: Id<"vehicles">;
    currency: string;
    invoiceMinor: number;
    financingType?: "CASH" | "FINANCED" | "LEASE";
    financedSalePlan?: unknown;
    /** The treatment the caller states for the held deposit, if any. */
    treatment?: PayFirstDepositTreatment;
    /** Consigned/agent stock settled DIRECT_TO_SUPPLIER: the deposit goes to the supplier settlement, not the invoice. */
    settlesDirectToSupplierOnSourcedStock: boolean;
    /**
     * SCRUM-858 S1: the buyer, so a named opening reservation deposit (customer-keyed, no quote) counts toward the
     * invoice exactly as `resolveReservationDeposits` will apply it. Read through the same selection the writer uses.
     */
    opening: { orgId: Id<"organizations">; customerId: Id<"customers"> };
  }
): Promise<void> {
  if (!CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED || !isCashCompletion(args) || args.invoiceMinor <= 0) return;
  const openingCoversMinor = async (capMinor: number): Promise<number> =>
    (await selectOpeningDepositsForSale(ctx, {
      orgId: args.opening.orgId,
      customerId: args.opening.customerId,
      vehicleId: args.vehicleId,
      currency: args.currency,
      capMinor,
    })).reduce((sum, pick) => sum + pick.rowMinor, 0);
  if (!args.quoteId) {
    if ((await openingCoversMinor(args.invoiceMinor)) < args.invoiceMinor) refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
    return;
  }
  const allocation = await allocatedDepositForVehicle(ctx, {
    quoteId: args.quoteId,
    vehicleId: args.vehicleId,
    currency: args.currency,
  });
  if (allocation.kind === "NOT_ALLOCATED") return; // the completion's allocation-required refusal comes first
  const heldMinor = allocation.allocatedMinor;
  const fitsTheBill = heldMinor <= args.invoiceMinor;

  let appliedMinor: number | "LEFT_TO_COMPLETION";
  if (heldMinor === 0) {
    appliedMinor = 0; // no deposit, or a car carrying none of it
  } else {
    switch (args.treatment) {
      case undefined:
      case "APPLY_TO_DEALER_AMOUNT":
        appliedMinor = fitsTheBill ? heldMinor : "LEFT_TO_COMPLETION";
        break;
      case "APPLY_TO_TRANSACTION_SETTLEMENT":
        // Defensive: on the direct-to-supplier route of sourced stock the customer is billed nothing for the car, so a
        // cash invoice there is 0 and returns before this switch. Kept so the mirror of `resolveReservationDeposits`
        // stays complete if that ever changes.
        appliedMinor = args.settlesDirectToSupplierOnSourcedStock ? 0 : fitsTheBill ? heldMinor : "LEFT_TO_COMPLETION";
        break;
      case "REFUND_TO_CUSTOMER":
      case "FORFEITED":
      case "OTHER":
        // None of these pays the invoice, whether the deposit is shared with other cars or not and whether or not an
        // OTHER carries a reason: the unpaid balance is refused here, before the sale row, and the release path's own
        // refusals (shared deposit, missing reason, creator cannot resolve) are not reached.
        appliedMinor = 0;
        break;
    }
  }
  if (appliedMinor === "LEFT_TO_COMPLETION") return;
  // A named opening reservation deposit pays what the quote-keyed deposit did not (the writer caps it the same way).
  const stillDueMinor = args.invoiceMinor - appliedMinor;
  const openingMinor = stillDueMinor > 0 ? await openingCoversMinor(stillDueMinor) : 0;
  if (appliedMinor + openingMinor < args.invoiceMinor) refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
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
