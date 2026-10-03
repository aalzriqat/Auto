import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-571 slice 1 (D-18 / D-20): competing-debt containment.
 *
 * Invariant: a sale's customer debt exists only as its canonical sale invoice
 * (receivableDocuments source `sales/<saleId>`). Until the invoice receipt
 * resolver exists, every door that would create, extend, collect against or
 * complete over a legacy `receivables` row carrying a saleId refuses.
 *
 * LEAF MODULE (SCRUM-302): imports only types and `./errors`, so any convex
 * module may import it without creating a cycle.
 */

/**
 * The single switch for the payment-link pilot shutdown (D-20). `create`,
 * staff `markSettled` and the webhook capture path all read this one constant;
 * flipping it to `false` is a code change reviewed on its own, never an env var.
 */
export const PAYMENT_LINKS_PILOT_DISABLED = true as const;

// English text equals `ServerError_<code>` in lib/i18n/domains/common.ts.
export const SALE_DEBT_CONTAINMENT_REFUSALS = {
  SALE_DEBT_COMPETING_RECEIVABLE_REFUSED:
    "A sale's customer debt is its sale invoice. A separate receivable cannot be created for a sale. Nothing has been changed.",
  SALE_HAS_LEGACY_RECEIVABLE:
    "This sale still has a separate receivable record that must be resolved before the sale can be completed or cancelled. Contact support. Nothing has been changed.",
  SALE_DEBT_RECEIPT_REFUSED:
    "Payments, credits and cheques for a sale cannot be recorded against a separate receivable. Nothing has been changed.",
  PAYMENT_LINKS_DISABLED: "Payment links are not available yet. Nothing has been changed.",
} as const satisfies Record<string, string>;

export function refuseSaleDebt(code: keyof typeof SALE_DEBT_CONTAINMENT_REFUSALS): never {
  return throwAppError(AppErrorCode[code], SALE_DEBT_CONTAINMENT_REFUSALS[code]);
}

/** Rows read per sale; a sale never legitimately has more than a handful. */
const LEGACY_ROW_READ_LIMIT = 100;

/**
 * T1/T2: every legacy `receivables` row for the sale, in any status. `by_sale`
 * has no org prefix, so every row is org-checked here. A read that hits the
 * limit cannot prove absence and is treated as present.
 */
export async function saleHasLegacyReceivable(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  const rows = await ctx.db
    .query("receivables")
    .withIndex("by_sale", (q) => q.eq("saleId", saleId))
    .take(LEGACY_ROW_READ_LIMIT + 1);
  return rows.length > LEGACY_ROW_READ_LIMIT || rows.some((row) => row.orgId === orgId);
}

/** T1/T2: refuse while any legacy receivable row exists for the sale. */
export async function assertNoSaleLinkedLegacyReceivable(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<void> {
  if (await saleHasLegacyReceivable(ctx, orgId, saleId)) refuseSaleDebt("SALE_HAS_LEGACY_RECEIVABLE");
}

/** W1: a caller may not attach a saleId to a new legacy receivable. */
export function assertNoSaleIdOnNewReceivable(saleId: Id<"sales"> | undefined): void {
  if (saleId) refuseSaleDebt("SALE_DEBT_COMPETING_RECEIVABLE_REFUSED");
}

/**
 * R1-R5: refuse a receipt, credit, cheque or allocation that targets a legacy
 * receivable carrying a saleId, or a caller that supplies a saleId of its own.
 * Finance-company instruments carry no saleId and are unaffected.
 */
export function assertReceivableNotSaleLinked(
  receivable: Pick<Doc<"receivables">, "saleId"> | null | undefined,
  callerSaleId?: Id<"sales">
): void {
  if (receivable?.saleId || callerSaleId) refuseSaleDebt("SALE_DEBT_RECEIPT_REFUSED");
}

/**
 * S1: refuse a subledger document that IS (or mirrors) a sale's customer debt:
 * source `sales` (the canonical sale invoice) or `legacy_receivable` whose
 * legacy row carries a saleId (same org). Any other source is unaffected.
 */
export async function assertSourceIsNotSaleDebt(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  source: { sourceType: string; sourceId: string }
): Promise<void> {
  if (source.sourceType === "sales") refuseSaleDebt("SALE_DEBT_RECEIPT_REFUSED");
  if (source.sourceType !== "legacy_receivable") return;
  const receivableId = ctx.db.normalizeId("receivables", source.sourceId);
  if (!receivableId) return;
  const receivable = await ctx.db.get(receivableId);
  if (receivable && receivable.orgId === orgId) assertReceivableNotSaleLinked(receivable);
}

/**
 * R1/R2: the pre-wrapper form for a receipt door. Refuses a caller-supplied
 * saleId outright and a receivable (same org) that carries one. A receivable
 * that does not exist, or belongs to another org, is left to the door's own
 * existing "not found" refusal so no cross-org fact is revealed.
 */
export async function assertReceiptTargetNotSaleLinked(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  target: { receivableId?: Id<"receivables">; saleId?: Id<"sales"> }
): Promise<void> {
  if (target.saleId) refuseSaleDebt("SALE_DEBT_RECEIPT_REFUSED");
  if (!target.receivableId) return;
  const receivable = await ctx.db.get(target.receivableId);
  if (receivable && receivable.orgId === orgId) assertReceivableNotSaleLinked(receivable);
}
