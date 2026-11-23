import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { postDomainEvent } from "./posting";

// ─── GL Phase 15: cash-drawer bank deposit ────────────────────────────────────

/**
 * No scoped self-heal here: unlike the fixed-asset/partner-equity/claim
 * accounts, BANK_ACCOUNT and CASH_ON_HAND are foundational accounts already
 * ensured by chartOfAccounts.initialize for every org.
 */
export async function hookCashDrawerDeposited(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sessionId: Id<"cashDrawerSessions">;
    amountMinor: number;
    currency: string;
    /** SCRUM-54: the physical bank, already validated by the caller. */
    bankAccountId: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CASH_DRAWER_DEPOSITED",
    sourceType: "cashDrawerSessions",
    sourceId: args.sessionId.toString(),
    idempotencyKey: `cash_drawer_deposited_${args.sessionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      sessionId: args.sessionId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      bankAccountId: args.bankAccountId.toString(),
    },
  });
}
