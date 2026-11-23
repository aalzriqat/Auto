import { type MutationCtx } from "../../_generated/server";
import { type Id, type Doc } from "../../_generated/dataModel";
import { type SystemKey } from "../../utils/defaultChart";
import { assertStoredVersion } from "../../utils/custodySourceLedger";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureFinancedSettlementAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { handoverDirectPostKey, handoverDirectReversalKey } from "../../utils/handoverCostPayment";
import { type ReversalOutcome, reverseEventIfPosted } from "./reversal";

/**
 * A handover cost the DEALERSHIP paid directly (SCRUM-443), at version
 * `version` of the line's direct-payment posting: DR the treatment's expense /
 * CR the outbound cash or bank account. Dated when it was paid; a date in a
 * closed period queues to the outbox like every other event dated there.
 *
 * Both accounts are REQUIRED system keys, so an unmapped one queues the event
 * instead of throwing inside the caller's transaction — and the command
 * refuses before this is reached when the chart cannot take the posting.
 * A replacement version is never posted while the version it replaces is
 * still on the books: the command refuses that case, so no queueBehind
 * chain is needed here.
 */
export async function hookHandoverCostPaidDirect(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    fee: Doc<"financeDealFees">;
    vehicleId: Id<"vehicles"> | undefined;
    version: number;
    amountMinor: number;
    paymentMethod: string;
    /** SCRUM-54: the physical bank, set exactly when `cashKey` is the bank control account. */
    bankAccountId?: Id<"bankAccounts">;
    expenseKey: SystemKey;
    cashKey: SystemKey;
    actorId: Id<"users">;
    occurredAt: number;
  }
): Promise<void> {
  assertStoredVersion(args.version, "This cost line's direct payment", "posting this direct payment");
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureFinancedSettlementAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "HANDOVER_COST_PAID_DIRECT",
    sourceType: "financeDealFees",
    sourceId: args.fee._id.toString(),
    eventVersion: args.version,
    idempotencyKey: handoverDirectPostKey(args.fee._id, args.version),
    currency: args.fee.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [args.expenseKey, args.cashKey],
    payload: {
      feeId: args.fee._id.toString(),
      applicationId: args.fee.applicationId.toString(),
      vehicleId: args.vehicleId?.toString(),
      feeType: args.fee.feeType,
      accountingTreatment: args.fee.accountingTreatment,
      amountMinor: args.amountMinor,
      currency: args.fee.currency,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  });
}

/**
 * Reverses version `version` of a line's direct payment — pinned by version,
 * never `.first()`. Returns what became of it: REVERSED, DEFERRED (no period
 * open — the payment stays POSTED until the outbox drains) or NOT_POSTED (a
 * queued forward post was cancelled).
 */
export async function hookHandoverCostPaidDirectReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    version: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  assertStoredVersion(args.version, "This cost line's direct payment", "reversing this direct payment");
  return reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeDealFees",
    sourceId: args.feeId.toString(),
    eventType: "HANDOVER_COST_PAID_DIRECT",
    eventVersion: args.version,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: handoverDirectReversalKey(args.feeId, args.version),
    pendingPostIdempotencyKey: handoverDirectPostKey(args.feeId, args.version),
  });
}
