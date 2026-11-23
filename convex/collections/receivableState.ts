import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReceivableCreditKey } from "../accounting/postingRules";
import { openingReceivableBasis } from "../utils/openingReceivableBasis";
import { requireOwnedRow } from "../utils/tenancy";
import { roundMoney } from "./amounts";

/**
 * A manual receivable isn't automatically "other income" — it could just as
 * easily be an unearned customer deposit/reservation hold (a liability, not
 * revenue) or a reimbursement that offsets a cost already expensed. The two
 * sourceTypes that are unambiguous get derived automatically; everything else
 * (INTERNAL_INSTALLMENT, BANK_FINANCED_BALANCE, BANK_TRANSFER, PAYMENT_LINK,
 * CHEQUE, OTHER) requires the caller to pick explicitly rather than silently
 * defaulting to income.
 */
export function resolveReceivableCreditKey(
  sourceType: Doc<"receivables">["sourceType"],
  explicit: ReceivableCreditKey | undefined
): ReceivableCreditKey {
  if (explicit) return explicit;
  if (sourceType === "CUSTOMER_DEPOSIT" || sourceType === "RESERVATION_PAYMENT") {
    return "CUSTOMER_DEPOSITS_LIABILITY";
  }
  throw new ConvexError(
    "This receivable's credit account isn't obvious from its source type — specify creditSystemKey (Other Income, Customer Deposits Liability, or a cost reimbursement)."
  );
}

export async function assertOpeningReceivableChangeAllowed(ctx: MutationCtx, receivable: Doc<"receivables">): Promise<void> {
  const basis = await openingReceivableBasis(ctx, receivable.orgId, receivable._id);
  if (basis.kind !== "ORDINARY") {
    throw new ConvexError("Changes and refunds for opening-balance debts require a separate finance review. Nothing has changed.");
  }
}

export async function assertOpeningReceivableDate(ctx: MutationCtx, orgId: Id<"organizations">,
  receivableId: Id<"receivables"> | undefined, effectiveDate: number): Promise<void> {
  if (!receivableId) return;
  const receivable = await requireOwnedRow(ctx, orgId, "receivables", receivableId, "Receivable not found.");
  const basis = await openingReceivableBasis(ctx, orgId, receivable._id);
  if (basis.kind === "INVALID") throw new ConvexError(basis.reason);
  if (basis.kind === "OPENING" && !(effectiveDate >= basis.basisDate)) {
    throw new ConvexError("A collection cannot precede this receivable's posted opening date. Nothing has changed.");
  }
}

export type ReceivableStatus = Doc<"receivables">["status"];

type ReceivablePatch = Partial<Pick<Doc<"receivables">, "outstandingAmount" | "status" | "lastPaymentAt" | "updatedAt" | "dueDate" | "notes">>;

export function addMonths(timestamp: number, months: number) {
  const date = new Date(timestamp);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

export function nextStatus(outstandingAmount: number, dueDate: number, now = Date.now()): ReceivableStatus {
  if (outstandingAmount <= 0) return "PAID";
  if (dueDate < now) return "OVERDUE";
  return "PARTIALLY_PAID";
}

export async function applyPostedPayment(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  amount: number,
  paymentDate: number,
  currency: string
) {
  const outstandingAmount = roundMoney(Math.max(0, receivable.outstandingAmount - amount), currency);
  const patch: ReceivablePatch = {
    outstandingAmount,
    status: nextStatus(outstandingAmount, receivable.dueDate),
    lastPaymentAt: paymentDate,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(receivable._id, patch);
}
