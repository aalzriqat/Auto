import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { type SystemKey, SYSTEM_KEYS } from "../../utils/defaultChart";
import { assertStoredVersion } from "../../utils/custodySourceLedger";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureFinancedSettlementAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { forwardPostKey, forwardReversalKey } from "../../utils/financeCompanyForward";
import { type ReversalOutcome, reverseEventIfPosted } from "./reversal";

/**
 * The dealership paid the finance company the deposit + contribution it owes
 * onward (SCRUM-435), at forward version `version`: DR AP-Finance / CR the
 * outbound cash or bank account. Dated when it was really paid. Both accounts
 * are REQUIRED system keys, so an unmapped one queues the event (visible as
 * POSTING_PENDING to `deriveForwardState`) instead of throwing inside the
 * caller's transaction.
 */
export async function hookFinanceCompanyForwardPaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    forwardId: Id<"financeCompanyForwards">;
    financeCompanyId?: Id<"financeCompanies">;
    payerNameSnapshot?: string;
    version: number;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    cashKey: SystemKey;
    /** SCRUM-54: the physical bank a BANK_ACCOUNT payment left; absent for cash. */
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
): Promise<void> {
  assertStoredVersion(args.version, "This deal's forward to the finance company", "posting this forward");
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureFinancedSettlementAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_COMPANY_FORWARD_PAID",
    sourceType: "financeCompanyForwards",
    sourceId: args.forwardId.toString(),
    eventVersion: args.version,
    idempotencyKey: forwardPostKey(args.applicationId, args.version),
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [SYSTEM_KEYS.ACCOUNTS_PAYABLE_FINANCE_COMPANIES, args.cashKey],
    payload: {
      forwardId: args.forwardId.toString(),
      applicationId: args.applicationId.toString(),
      financeCompanyId: args.financeCompanyId?.toString(),
      ...(args.payerNameSnapshot !== undefined ? { payerNameSnapshot: args.payerNameSnapshot } : {}),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  });
}

/**
 * Reverses forward version `version` - pinned by version, never `.first()`.
 * REVERSED / DEFERRED (no period open, the payment stays POSTED until the
 * outbox drains) / NOT_POSTED (a queued forward post was cancelled).
 */
export async function hookFinanceCompanyForwardReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    forwardId: Id<"financeCompanyForwards">;
    version: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  assertStoredVersion(args.version, "This deal's forward to the finance company", "reversing this forward");
  return reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeCompanyForwards",
    sourceId: args.forwardId.toString(),
    eventType: "FINANCE_COMPANY_FORWARD_PAID",
    eventVersion: args.version,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: forwardReversalKey(args.applicationId, args.version),
    pendingPostIdempotencyKey: forwardPostKey(args.applicationId, args.version),
  });
}
