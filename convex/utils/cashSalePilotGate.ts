import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { outstandingFromReceivableDoc } from "../subledger";
import { CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED, refuseSaleDebt } from "./saleDebtContainment";

/**
 * SCRUM-802: pilot cash-sale containment. See `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED`.
 *
 * Invariant: while no door can apply a customer's payment to a sale invoice, a
 * CASH sale is completed only with its invoice already paid in full by
 * deposits and trade-in, and money that cannot be tied to a sale is not
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
 * Refuses the completion when the cash sale's invoice still has an outstanding
 * balance AFTER deposit and trade-in allocation. Call it at the end of the
 * allocation block, inside the completing mutation, so the throw rolls back
 * the sale, the vehicle status change, the journal and the allocations.
 */
export async function assertCashSaleInvoiceFullyPaid(
  ctx: MutationCtx,
  args: {
    financingType?: "CASH" | "FINANCED" | "LEASE";
    financedSalePlan?: unknown;
    saleReceivableId: Id<"receivableDocuments">;
  }
): Promise<void> {
  if (!CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED || !isCashCompletion(args)) return;
  const doc = await ctx.db.get(args.saleReceivableId);
  if (!doc) return refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
  if ((await outstandingFromReceivableDoc(ctx, doc)) > 0) refuseSaleDebt("CASH_SALE_BALANCE_UNPAID_REFUSED");
}

/** True when `doc` is a customer's sale invoice that still has money outstanding. */
async function isOpenSaleInvoice(ctx: QueryCtx | MutationCtx, doc: Doc<"receivableDocuments">): Promise<boolean> {
  if (doc.sourceType !== "sales" || doc.payerType !== "CUSTOMER") return false;
  if (doc.status === "CANCELLED" || doc.status === "REVERSED" || doc.status === "WRITTEN_OFF" || doc.status === "PAID") return false;
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
  target: { receivableId?: Id<"receivables">; customerId?: Id<"customers"> }
): Promise<void> {
  if (!CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED) return;
  if (target.receivableId || !target.customerId) return;
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
