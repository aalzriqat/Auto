import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { type ReceivableCreditKey } from "../postingRules";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureMiscIncomeAccount } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { makeReversalHook } from "./reversal";

// ─── Manual receivables ────────────────────────────────────────────────────────
export async function hookReceivableCreated(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"receivables">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    creditSystemKey: ReceivableCreditKey;
  }
) {
  if (args.creditSystemKey === "MISCELLANEOUS_INCOME" && (await isChartInitialized(ctx, args.orgId))) {
    await ensureMiscIncomeAccount(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "RECEIVABLE_CREATED",
    sourceType: "receivables",
    sourceId: args.receivableId.toString(),
    idempotencyKey: `receivable_created_${args.receivableId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      receivableId: args.receivableId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      creditSystemKey: args.creditSystemKey,
    },
  });
}

/**
 * Reverses the RECEIVABLE_CREATED entry when a manual receivable is
 * cancelled before any payment is collected. Safe to call for sale-linked
 * receivables too — those never had a RECEIVABLE_CREATED event posted (their
 * AR is recognized by SALE_COMPLETED instead), so this is a no-op for them.
 */
export const hookReceivableCancelled = makeReversalHook<{ receivableId: Id<"receivables"> }>({
  eventType: "RECEIVABLE_CREATED",
  sourceType: "receivables",
  sourceId: (a) => a.receivableId.toString(),
  reversalKey: (a) => `receivable_cancelled_${a.receivableId}`,
  pendingPostKey: (a) => `receivable_created_${a.receivableId}`,
});
