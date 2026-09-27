import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { postAccountingEvent } from "./postingEngine";
import { isChartInitialized, ensureConsignmentAccounts } from "../chartOfAccounts";

/**
 * SCRUM-389 — the ledger side of supplier-borne vehicle costs.
 *
 * The expense's own EXPENSE_POSTED (Dr Receivable from Suppliers / Cr cash)
 * goes through `hookExpensePosted` like every other expense. What lives here
 * is what that hook cannot give: a way to READ where a posting stands, and a
 * receipt posting that never queues.
 */

/** The one spelling of a recovery receipt's posting key. */
export function supplierCostRecoveryReceiptKey(receiptId: Id<"supplierCostRecoveryReceipts">): string {
  return `supplier_cost_recovery_receipt_${receiptId}`;
}

/** The one spelling of a recovery receipt's REVERSAL key. */
export function supplierCostRecoveryReceiptReversalKey(receiptId: Id<"supplierCostRecoveryReceipts">): string {
  return `supplier_cost_recovery_receipt_reversed_${receiptId}`;
}

/**
 * Where a posting keyed `idempotencyKey` stands, read from BOTH surfaces it can
 * live on.
 *
 *   POSTED   — on the books
 *   REVERSED — posted, then reversed
 *   PENDING  — durably queued in the outbox, not yet on the books
 *   FAILED   — queued and dead-lettered
 *   NONE     — neither surface holds it (never posted, or a queued post that
 *              was cancelled)
 *
 * The engine keys `accountingEvents` uniquely by (org, idempotency key) and a
 * reversal is written under its OWN key, so the row found here is the forward
 * posting and nothing else — never `.first()` on `by_org_source`, which
 * reversals share (ACC-4). The ledger is read first: a drained outbox row is
 * patched POSTED, so the ledger is the authority whenever it holds the row.
 */
export type PostingState = "POSTED" | "REVERSED" | "PENDING" | "FAILED" | "NONE";

export async function postingStateForKey(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<{ state: PostingState; eventId: Id<"accountingEvents"> | null; accountingDate?: number }> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .unique();
  if (event?.status === "POSTED") return { state: "POSTED", eventId: event._id, accountingDate: event.accountingDate };
  if (event?.status === "REVERSED") return { state: "REVERSED", eventId: event._id };
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .first();
  if (queued?.status === "PENDING") return { state: "PENDING", eventId: null };
  if (queued?.status === "FAILED") return { state: "FAILED", eventId: null };
  return { state: "NONE", eventId: event?._id ?? null };
}

/**
 * Posts one supplier cost recovery receipt SYNCHRONOUSLY, or throws.
 *
 * Deliberately NOT `postDomainEvent`: that path can enqueue, and a queued
 * receipt would already be LIVE and reducing what the supplier owes while its
 * ledger credit did not exist — and could not be reversed, because a reversal
 * needs a POSTED original. `postAccountingEvent` checks the period, resolves
 * every account and writes the journal before it returns; anything it cannot
 * do throws, and the caller's whole transaction (receipt row included) rolls
 * back. The event is re-read after posting and refused unless POSTED, so the
 * caller never records a receipt the ledger does not carry.
 */
export async function postSupplierCostRecoveryReceipt(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receiptId: Id<"supplierCostRecoveryReceipts">;
    recoveryId: Id<"supplierCostRecoveries">;
    vehicleId: Id<"vehicles">;
    sourcedFromName: string;
    amountMinor: number;
    currency: string;
    paymentMethod: "CASH" | "BANK_TRANSFER";
    receivedDate: number;
    actorId: Id<"users">;
  }
): Promise<Id<"accountingEvents">> {
  if (!(await isChartInitialized(ctx, args.orgId))) {
    throw new ConvexError("Set up the chart of accounts before recording a supplier cost recovery.");
  }
  await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
  const result = await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_COST_RECOVERY_RECEIVED",
    sourceType: "supplierCostRecoveryReceipts",
    sourceId: args.receiptId.toString(),
    eventVersion: 1,
    accountingDate: args.receivedDate,
    occurredAt: args.receivedDate,
    currency: args.currency,
    idempotencyKey: supplierCostRecoveryReceiptKey(args.receiptId),
    actorId: args.actorId,
    payload: {
      receiptId: args.receiptId.toString(),
      recoveryId: args.recoveryId.toString(),
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      vehicleId: args.vehicleId.toString(),
    },
  });
  const posted = result.eventId ? await ctx.db.get(result.eventId) : null;
  if (!posted || posted.status !== "POSTED") {
    throw new ConvexError("The recovery receipt could not be posted to the ledger, so it was not recorded.");
  }
  return posted._id;
}
