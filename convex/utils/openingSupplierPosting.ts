import type { OpeningSettlementReader } from "./openingSettlementBasis";
import { toMinorUnits } from "./money";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { PostCommand } from "../accounting/postingEngine";
import {
  openingRecoveryBasis,
  openingPayableBasis,
} from "./openingSupplierBasis";
const fail = () =>
  new ConvexError(
    "The opening settlement source cannot be verified. Nothing was posted.",
  );
export async function assertOpeningSupplierPosting(
  ctx: MutationCtx,
  cmd: PostCommand,
  reader?: OpeningSettlementReader,
): Promise<void> {
  if (
    cmd.eventType !== "SUPPLIER_PAYMENT_SETTLED" &&
    cmd.eventType !== "SUPPLIER_COST_RECOVERY_RECEIVED"
  )
    return;
  const p = cmd.payload;
  if (cmd.eventType === "SUPPLIER_PAYMENT_SETTLED") {
    const id = ctx.db.normalizeId("vehicleSupplierPayables", cmd.sourceId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.orgId !== cmd.orgId) {
      if (p.openingSource || p.openingPaymentId) throw fail();
      return;
    }
    const basis = await openingPayableBasis(ctx, cmd.orgId, row, reader);
    if (!basis) {
      if (p.openingSource || p.openingPaymentId) throw fail();
      return;
    }
    const occurrenceId =
      typeof p.openingPaymentId === "string"
        ? ctx.db.normalizeId("openingPayablePayments", p.openingPaymentId)
        : null;
    const occurrence = occurrenceId ? await ctx.db.get(occurrenceId) : null;
    const payments = await ctx.db
      .query("openingPayablePayments")
      .withIndex("by_payable", (q) => q.eq("payableId", row._id))
      .take(101);
    if (
      payments.length > 100 ||
      new Set(payments.map((payment) => payment.seq)).size !==
        payments.length ||
      payments.some(
        (payment) =>
          payment.orgId !== cmd.orgId ||
          payment.currency !== row.currency ||
          payment.openingBalanceDraftId !== basis.draftId ||
          payment.openingRowKey !== basis.rowKey ||
          !Number.isSafeInteger(payment.amountMinor) ||
          payment.amountMinor <= 0,
      )
    )
      throw fail();
    const paidMinor = payments
      .filter((payment) => payment.status === "LIVE")
      .reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (
      !Number.isSafeInteger(paidMinor) ||
      paidMinor > basis.amountMinor ||
      toMinorUnits(row.amountPaid ?? 0, row.currency) !== paidMinor ||
      row.paymentSeq !== payments.length
    )
      throw fail();
    const ref = p.openingSource as
      | { draftId?: unknown; rowKey?: unknown }
      | undefined;
    if (
      !occurrence ||
      occurrence.orgId !== cmd.orgId ||
      occurrence.payableId !== row._id ||
      occurrence.status !== "LIVE" ||
      occurrence.openingBalanceDraftId !== basis.draftId ||
      occurrence.openingRowKey !== basis.rowKey ||
      ref?.draftId !== basis.draftId ||
      ref.rowKey !== basis.rowKey ||
      cmd.sourceType !== "vehicleSupplierPayables" ||
      p.payableId !== row._id ||
      p.sourcedFromName !== row.sourcedFromName ||
      occurrence.currency !== cmd.currency ||
      p.currency !== cmd.currency ||
      occurrence.amountMinor !== p.amountMinor ||
      !Number.isSafeInteger(occurrence.amountMinor) ||
      occurrence.amountMinor <= 0 ||
      occurrence.amountMinor > basis.amountMinor ||
      occurrence.method !== p.paymentMethod ||
      occurrence.bankAccountId !== p.bankAccountId ||
      occurrence.occurredAt !== cmd.occurredAt ||
      occurrence.occurredAt !== cmd.accountingDate ||
      occurrence.occurredAt < basis.asOfDate ||
      occurrence.actorId !== cmd.actorId ||
      cmd.eventVersion !== occurrence.seq ||
      cmd.idempotencyKey !==
        `supplier_payment_settled_${row._id}_${occurrence.seq}` ||
      p.taxMinor ||
      (row.paymentSeq ?? 0) < occurrence.seq
    )
      throw fail();
  } else {
    const id = ctx.db.normalizeId("supplierCostRecoveryReceipts", cmd.sourceId);
    const receipt = id ? await ctx.db.get(id) : null;
    if (!receipt || receipt.orgId !== cmd.orgId) {
      if (p.openingSource) throw fail();
      return;
    }
    const row = await ctx.db.get(receipt.recoveryId);
    if (!row || row.orgId !== cmd.orgId) throw fail();
    const basis = await openingRecoveryBasis(ctx, cmd.orgId, row, reader);
    if (!basis) {
      if (p.openingSource || receipt.origin === "OPENING") throw fail();
      return;
    }
    const receipts = await ctx.db
      .query("supplierCostRecoveryReceipts")
      .withIndex("by_org_recovery", (q) =>
        q.eq("orgId", cmd.orgId).eq("recoveryId", row._id),
      )
      .take(101);
    if (
      receipts.length > 100 ||
      new Set(receipts.map((receipt) => receipt.seq)).size !==
        receipts.length ||
      receipts.some(
        (receipt) =>
          receipt.currency !== row.currency ||
          receipt.origin !== "OPENING" ||
          receipt.openingBalanceDraftId !== basis.draftId ||
          receipt.openingRowKey !== basis.rowKey ||
          !Number.isSafeInteger(receipt.amountMinor) ||
          receipt.amountMinor <= 0,
      )
    )
      throw fail();
    const recovered = receipts
      .filter((receipt) => receipt.status !== "REVERSED")
      .reduce((sum, receipt) => sum + receipt.amountMinor, 0);
    if (
      !Number.isSafeInteger(recovered) ||
      recovered > basis.amountMinor ||
      recovered !==
        row.amountRecoveredMinor +
          (receipt.status === "POSTING" ? receipt.amountMinor : 0)
    )
      throw fail();
    const ref = p.openingSource as
      | { draftId?: unknown; rowKey?: unknown }
      | undefined;
    if (
      receipt.origin !== "OPENING" ||
      receipt.openingBalanceDraftId !== basis.draftId ||
      receipt.openingRowKey !== basis.rowKey ||
      ref?.draftId !== basis.draftId ||
      ref.rowKey !== basis.rowKey ||
      (receipt.status !== "POSTING" && receipt.status !== "LIVE") ||
      cmd.sourceType !== "supplierCostRecoveryReceipts" ||
      p.receiptId !== receipt._id ||
      p.recoveryId !== row._id ||
      p.sourcedFromName !== row.sourcedFromName ||
      p.vehicleId !== undefined ||
      receipt.currency !== cmd.currency ||
      p.currency !== cmd.currency ||
      receipt.amountMinor !== p.amountMinor ||
      !Number.isSafeInteger(receipt.amountMinor) ||
      receipt.amountMinor <= 0 ||
      receipt.amountMinor > basis.amountMinor ||
      receipt.method !== p.paymentMethod ||
      receipt.bankAccountId !== p.bankAccountId ||
      receipt.receivedDate !== cmd.occurredAt ||
      receipt.receivedDate !== cmd.accountingDate ||
      receipt.receivedDate < basis.asOfDate ||
      receipt.createdBy !== cmd.actorId ||
      cmd.eventVersion !== 1 ||
      cmd.idempotencyKey !== `supplier_cost_recovery_receipt_${receipt._id}`
    )
      throw fail();
  }
}
