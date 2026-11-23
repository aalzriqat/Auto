import { makeReversalHook, type ReversalOutcome, reverseEventIfPosted } from "./reversal";
import { type Id } from "../../_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { postDomainEvent } from "./posting";
import { type FinanceReceiptMethod, financeReceiptAccountKey } from "../postingRules";
import { financeDisbursementKeys } from "../../utils/financeDisbursementKeys";

/** Reverses the FINANCE_DISBURSED entry created at finalizeDeal, when voiding a closed application that was never actually disbursed. */
export const hookFinanceDisbursementCancelled = makeReversalHook<{ applicationId: Id<"financeApplications"> }>({
  eventType: "FINANCE_DISBURSED",
  sourceType: "financeApplications",
  sourceId: (a) => a.applicationId.toString(),
  reversalKey: (a) => `finance_disbursement_cancelled_${a.applicationId}`,
  pendingPostKey: (a) => `finance_disbursed_${a.applicationId}`,
});

export async function hookFinanceDisbursed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    saleId: Id<"sales">;
    financeCompanyId: Id<"financeCompanies">;
    customerId: Id<"customers">;
    loanAmountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_DISBURSED",
    sourceType: "financeApplications",
    sourceId: args.applicationId.toString(),
    idempotencyKey: `finance_disbursed_${args.applicationId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      saleId: args.saleId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.loanAmountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
  });
}

export async function hookFinanceCashReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    /** Exactly one of this / `payerNameSnapshot` (SCRUM-27: a manual company has no id). */
    financeCompanyId?: Id<"financeCompanies">;
    payerNameSnapshot?: string;
    customerId?: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    /**
     * SCRUM-239: which disbursement of the application this receipt belongs to.
     * Absent means 1, whose keys are byte-identical to the historical ones.
     */
    disbursementVersion?: number;
    /**
     * SCRUM-599: the receipt's method of record — the value written to its
     * canonical payment in the same transaction. Picks the debited account.
     */
    paymentMethod: FinanceReceiptMethod;
    /** SCRUM-54: the physical bank, already validated by the caller. Bank receipts only. */
    bankAccountId?: Id<"bankAccounts">;
  }
) {
  const keys = financeDisbursementKeys(args.applicationId, args.disbursementVersion);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_CASH_RECEIVED",
    // An org whose chart cannot resolve the account the money landed in queues
    // the receipt (with its method) instead of rolling back the confirmation.
    requiredSystemKeys: [financeReceiptAccountKey(args.paymentMethod)],
    sourceType: "financeApplications",
    sourceId: keys.sourceId,
    eventVersion: keys.eventVersion,
    idempotencyKey: keys.cashReceivedPostKey,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      financeCompanyId: args.financeCompanyId?.toString(),
      ...(args.payerNameSnapshot !== undefined ? { payerNameSnapshot: args.payerNameSnapshot } : {}),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId?.toString(),
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  });
}

/**
 * SCRUM-239: undo ONE disbursement's FINANCE_CASH_RECEIVED occurrence because
 * its cheque came back from the bank.
 *
 * Pinned to the disbursement's own `sourceId` and `eventVersion`, and using its
 * own versioned reversal key. The reversal key is what makes this safe across
 * disbursements: `reverseAccountingEvent` answers "already reversed" for a key
 * it has seen and `reverseEventIfPosted` then reports REVERSED regardless, so a
 * key shared with an earlier disbursement would leave this one's receipt POSTED
 * behind a success string. The caller must still prove the outcome with
 * `isFinanceCashReceivedUndone` - the returned string is not the evidence.
 */
export async function hookFinanceCashReceivedReturned(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    disbursementVersion: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  const keys = financeDisbursementKeys(args.applicationId, args.disbursementVersion);
  return await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeApplications",
    sourceId: keys.sourceId,
    eventType: "FINANCE_CASH_RECEIVED",
    eventVersion: keys.eventVersion,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: keys.reversalKey,
    pendingPostIdempotencyKey: keys.pendingPostKey,
  });
}

/**
 * Reads the LEDGER (not a hook's return value) to decide whether one
 * disbursement's FINANCE_CASH_RECEIVED occurrence has stopped existing:
 *
 *  - every event at its exact tuple is non-POSTED and no forward POST is still
 *    queued for it (reversed, or cancelled before it posted), or
 *  - a POSTED event remains but its reversal is durably queued (PENDING
 *    REVERSE under the version's reversal key, not FAILED).
 */
export async function isFinanceCashReceivedUndone(
  ctx: QueryCtx | MutationCtx,
  args: { orgId: Id<"organizations">; applicationId: Id<"financeApplications">; disbursementVersion: number }
): Promise<boolean> {
  const keys = financeDisbursementKeys(args.applicationId, args.disbursementVersion);
  const events = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("eventType", "FINANCE_CASH_RECEIVED")
        .eq("sourceType", "financeApplications")
        .eq("sourceId", keys.sourceId)
        .eq("eventVersion", keys.eventVersion)
    )
    .collect();
  const pendingRow = async (key: string) =>
    await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", key))
      .unique();

  if (events.some((event) => event.status === "POSTED")) {
    const reversal = await pendingRow(keys.reversalKey);
    return reversal !== null && reversal.kind === "REVERSE" && reversal.status === "PENDING";
  }
  const forward = await pendingRow(keys.pendingPostKey);
  return forward === null || forward.kind !== "POST" || forward.status === "POSTED";
}
