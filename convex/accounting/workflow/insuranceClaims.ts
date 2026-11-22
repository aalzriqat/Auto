import { type Id } from "../../_generated/dataModel";
import { type MutationCtx } from "../../_generated/server";
import { type EventType } from "../postingRules";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureClaimAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";

// ─── GL Phase 13: claim receivables ───────────────────────────────────────────
export interface ClaimHookArgs {
  orgId: Id<"organizations">;
  claimId: Id<"claims">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postClaimEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CLAIM_SETTLED" | "CLAIM_WRITTEN_OFF">,
  args: ClaimHookArgs
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureClaimAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "claims",
    sourceId: args.claimId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.claimId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      claimId: args.claimId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookClaimSettled(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_SETTLED", args);
}

export async function hookClaimWrittenOff(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_WRITTEN_OFF", args);
}
