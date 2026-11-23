import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensurePartnerEquityAccounts } from "../chartAccountsProvision";
import { type EventType } from "../postingRules";
import { postDomainEvent } from "./posting";

// ─── GL Phase 12: partner equity movements ────────────────────────────────────

/** Same scoped-self-heal reasoning as ensureFixedAssetAccountsIfChartReady: only these three hooks ever resolve the partner-equity accounts. */
async function ensurePartnerEquityAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePartnerEquityAccounts(ctx, orgId, actorId);
  }
}

export interface PartnerEquityHookArgs {
  orgId: Id<"organizations">;
  transactionId: Id<"partnerEquityTransactions">;
  partnerId: Id<"partnerEquity">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  bankAccountId?: Id<"bankAccounts">;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postPartnerEquityEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CAPITAL_CONTRIBUTED" | "PARTNER_DREW" | "PROFIT_DISTRIBUTED">,
  args: PartnerEquityHookArgs
) {
  await ensurePartnerEquityAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "partnerEquityTransactions",
    sourceId: args.transactionId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.transactionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      partnerId: args.partnerId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
    },
  });
}

export async function hookCapitalContributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "CAPITAL_CONTRIBUTED", args);
}

export async function hookPartnerDrew(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PARTNER_DREW", args);
}

export async function hookProfitDistributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PROFIT_DISTRIBUTED", args);
}
