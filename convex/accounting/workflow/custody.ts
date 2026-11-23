import { type EventType } from "../postingRules";
import { type MutationCtx } from "../../_generated/server";
import { type Id, type Doc } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureDealCustodyAccounts, ensureFinancedSettlementAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import {
  custodyEntryPostKey,
  earlierVersionStillPosted,
  assertStoredVersion,
  custodyFeePostKey,
  type CustodyLedgerDependency,
  custodyDependencyBlockedReason,
  custodyWriteOffPostKey,
  custodyDependenciesPayload,
  custodyPayableReclassPosted,
  custodyPayableReclassKey,
} from "../../utils/custodySourceLedger";
import { SYSTEM_KEYS } from "../../utils/defaultChart";
import { type ReversalOutcome, reverseEventIfPosted } from "./reversal";

// ─── Employee deal custody (financeDealCustody) ──────────────────────────────
//
// One event per CASH ENTRY (issued / returned / reimbursed), keyed on the
// entry's own id, so a reversal entry that names it reverses exactly that
// journal and nothing else. A REVERSAL entry itself posts nothing forward: its
// whole accounting effect is the JOURNAL_REVERSAL of its target.
//
// One event per custody-paid FEE line, versioned on the fee row: correcting
// the amount, re-charging another custody, unlinking or voiding the line
// reverses the version on the books and (where a live charge remains) posts
// the next version. Never a second forward entry beside the first — the fee
// is on the books exactly once at its current actual, or not at all.
//
// One event per WRITE-OFF, versioned on the custody row, reversed by reopen.
//
// Every forward hook names DEAL_CUSTODY_CLEARING as a required account: an
// org whose chart cannot resolve it queues the event to the outbox instead
// of throwing inside the operator's transaction. The mutations additionally
// refuse the movement outright before reaching here when the chart is not
// initialised (`dealCustodyAccountingReadiness`), so a queued row here only
// ever means "no open period yet", never "no ledger at all".
export type CustodyCashKind = "ISSUED" | "RETURNED" | "REIMBURSED";

const CUSTODY_CASH_EVENT: Record<CustodyCashKind, EventType> = {
  ISSUED: "CUSTODY_CASH_ISSUED",
  RETURNED: "CUSTODY_CASH_RETURNED",
  REIMBURSED: "CUSTODY_REIMBURSED",
};

async function ensureDealCustodyAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureDealCustodyAccounts(ctx, orgId, actorId);
  }
}

/** A cash leg on a custody record, dated when the cash moved. */
export async function hookCustodyCashMoved(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    entry: Doc<"financeDealCustodyEntries">;
    custody: Doc<"financeDealCustody">;
    kind: CustodyCashKind;
    actorId: Id<"users">;
  }
): Promise<void> {
  await ensureDealCustodyAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: CUSTODY_CASH_EVENT[args.kind],
    sourceType: "financeDealCustodyEntries",
    sourceId: args.entry._id.toString(),
    idempotencyKey: custodyEntryPostKey(args.entry._id),
    currency: args.custody.currency,
    occurredAt: args.entry.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [SYSTEM_KEYS.DEAL_CUSTODY_CLEARING],
    payload: {
      custodyId: args.custody._id.toString(),
      entryId: args.entry._id.toString(),
      applicationId: args.custody.applicationId.toString(),
      userId: args.custody.userId.toString(),
      amountMinor: args.entry.amountMinor,
      currency: args.custody.currency,
      paymentMethod: args.entry.method,
      bankAccountId: args.entry.bankAccountId?.toString(),
    },
  });
}

/** The canonical inverse of one cash leg — reversal entry `reversalEntryId` cancels `entryId`. */
export async function hookCustodyCashReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    entryId: Id<"financeDealCustodyEntries">;
    kind: CustodyCashKind;
    reversalEntryId: Id<"financeDealCustodyEntries">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  return reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeDealCustodyEntries",
    sourceId: args.entryId.toString(),
    eventType: CUSTODY_CASH_EVENT[args.kind],
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `custody_entry_reversal_${args.reversalEntryId}`,
    pendingPostIdempotencyKey: custodyEntryPostKey(args.entryId),
  });
}

/**
 * Why a replacement version must wait, or `undefined` when it may post now.
 *
 * A fee's or a write-off's version N replaces version N−1 (or earlier),
 * which the caller has just reversed. When that reversal was DEFERRED — no
 * period open for its date — the earlier version is STILL POSTED, and a
 * replacement posting now would carry the same charge twice until the outbox
 * drains. Judged on the LEDGER (an earlier version still POSTED), with the
 * caller's `ReversalOutcome` as a second witness: an outcome describes one
 * branch's path, and the ledger is what the worker re-proves on the queued
 * row (`custodyPostingBlockedReason`). Either alone queues the replacement.
 */
async function custodyReplacementQueueReason(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    eventType: "CUSTODY_FEE_PAID" | "CUSTODY_WRITTEN_OFF";
    sourceType: "financeDealFees" | "financeDealCustody";
    sourceId: string;
    version: number;
    replacesReversal?: ReversalOutcome;
  }
): Promise<string | undefined> {
  const what = args.eventType === "CUSTODY_FEE_PAID" ? "custody fee posting" : "custody write-off";
  const earlier = await earlierVersionStillPosted(
    ctx, args.orgId, args.eventType, args.sourceType, args.sourceId, args.version
  );
  if (earlier !== null) {
    return `${what} v${earlier} it replaces is still on the books; its reversal has not posted yet`;
  }
  if (args.replacesReversal === "DEFERRED") {
    return `${what} v${args.version - 1} it replaces has a deferred reversal that has not posted yet`;
  }
  return undefined;
}

/** A handover cost paid out of custody, at version `version` of the fee's posting. */
export async function hookCustodyFeePaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    fee: Doc<"financeDealFees">;
    custodyId: Id<"financeDealCustody">;
    vehicleId: Id<"vehicles"> | undefined;
    version: number;
    amountMinor: number;
    actorId: Id<"users">;
    occurredAt: number;
    /** What became of the version this one replaces, when the caller reversed one. */
    replacesReversal?: ReversalOutcome;
  }
): Promise<void> {
  assertStoredVersion(args.version, "This cost line's custody posting", "posting this custody-paid cost");
  await ensureDealCustodyAccountsIfChartReady(ctx, args.orgId, args.actorId);
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureFinancedSettlementAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CUSTODY_FEE_PAID",
    queueBehind: await custodyReplacementQueueReason(ctx, {
      orgId: args.orgId,
      eventType: "CUSTODY_FEE_PAID",
      sourceType: "financeDealFees",
      sourceId: args.fee._id.toString(),
      version: args.version,
      replacesReversal: args.replacesReversal,
    }),
    sourceType: "financeDealFees",
    sourceId: args.fee._id.toString(),
    eventVersion: args.version,
    idempotencyKey: custodyFeePostKey(args.fee._id, args.version),
    currency: args.fee.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [SYSTEM_KEYS.DEAL_CUSTODY_CLEARING],
    payload: {
      feeId: args.fee._id.toString(),
      custodyId: args.custodyId.toString(),
      applicationId: args.fee.applicationId.toString(),
      vehicleId: args.vehicleId?.toString(),
      feeType: args.fee.feeType,
      accountingTreatment: args.fee.accountingTreatment,
      amountMinor: args.amountMinor,
      currency: args.fee.currency,
    },
  });
}

/** Reverses version `version` of a fee's custody posting — pinned by version, never `.first()`. */
export async function hookCustodyFeeReversed(
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
  assertStoredVersion(args.version, "This cost line's custody posting", "reversing this custody-paid cost");
  return reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeDealFees",
    sourceId: args.feeId.toString(),
    eventType: "CUSTODY_FEE_PAID",
    eventVersion: args.version,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `custody_fee_reversal_${args.feeId}_v${args.version}`,
    pendingPostIdempotencyKey: custodyFeePostKey(args.feeId, args.version),
  });
}

/**
 * A debit residual nobody could account for, absorbed as Cash Over/Short.
 *
 * A DERIVED posting, like the payable delta: the residual is what the
 * record's legs and lines leave, so it is chained behind those postings
 * (`dependencies`) as well as behind the reversal of the write-off it
 * replaces. A write-off dated today otherwise overtook a receipt queued
 * into a closed month and absorbed a shortage the clearing account did not
 * yet show. The worker re-proves both off the queued row.
 */
export async function hookCustodyWrittenOff(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custody: Doc<"financeDealCustody">;
    version: number;
    amountMinor: number;
    reason: string;
    actorId: Id<"users">;
    occurredAt: number;
    /** What became of the write-off this one replaces, when the caller reversed one. */
    replacesReversal?: ReversalOutcome;
    /** The legs and lines whose residual this absorbs — see the note above. */
    dependencies: ReadonlyArray<CustodyLedgerDependency>;
  }
): Promise<void> {
  assertStoredVersion(args.version, "This custody record's write-off posting", "posting this custody write-off");
  await ensureDealCustodyAccountsIfChartReady(ctx, args.orgId, args.actorId);
  const replacementBlock = await custodyReplacementQueueReason(ctx, {
    orgId: args.orgId,
    eventType: "CUSTODY_WRITTEN_OFF",
    sourceType: "financeDealCustody",
    sourceId: args.custody._id.toString(),
    version: args.version,
    replacesReversal: args.replacesReversal,
  });
  const dependencyBlock =
    replacementBlock !== undefined ? null : await custodyDependencyBlockedReason(ctx, args.orgId, args.dependencies);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CUSTODY_WRITTEN_OFF",
    queueBehind: replacementBlock ?? dependencyBlock ?? undefined,
    sourceType: "financeDealCustody",
    sourceId: args.custody._id.toString(),
    eventVersion: args.version,
    idempotencyKey: custodyWriteOffPostKey(args.custody._id, args.version),
    currency: args.custody.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [SYSTEM_KEYS.DEAL_CUSTODY_CLEARING, SYSTEM_KEYS.CASH_OVER_SHORT],
    payload: {
      custodyId: args.custody._id.toString(),
      applicationId: args.custody.applicationId.toString(),
      userId: args.custody.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.custody.currency,
      reason: args.reason,
      ...custodyDependenciesPayload(args.dependencies),
    },
  });
}

/**
 * One delta on the custody-payable split, versioned per record. Never
 * reversed: the next delta after a reversed movement restores the split, so
 * the primary journals keep their exact inverse and this one only follows.
 *
 * CAUSALLY CHAINED (final round A). Version N is the delta ON TOP of version
 * N−1, so it may only reach the books after it. When the predecessor is not
 * yet POSTED — queued for a month that is closed, held, or failed — this
 * version is queued behind it instead of posting now, with the reason on the
 * row; `custodyPostingBlockedReason` re-proves the same condition when the
 * outbox worker picks it up. Without this an open-period release (v2, a
 * debit) landed while the closed-period recognition (v1, the credit) was
 * still waiting, and the liability read as a debit until the month reopened.
 *
 * ALSO CHAINED BEHIND THE POSTINGS IT REFLECTS (`dependencies`). The chain
 * orders the deltas among themselves; it does not hold a delta behind the
 * fee replacement, fee reversal or cash leg whose consequence it is. A
 * corrected fee whose old version's reversal was deferred (no period open
 * today) while its paid date sits in an open month produced a delta that
 * posted at once — the payable moved to the corrected position while the
 * clearing account still carried the old charge. The caller names the
 * postings the delta follows; each is proven on the ledger here, and the
 * unmet one queues the delta with the reason. The worker re-proves them off
 * the payload (`custodyDependencyBlockedReason`).
 */
export async function hookCustodyPayableReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custody: Doc<"financeDealCustody">;
    version: number;
    deltaMinor: number;
    payableAfterMinor: number;
    actorId: Id<"users">;
    occurredAt: number;
    /** The primary postings this delta is a consequence of — see the note above. */
    dependencies: ReadonlyArray<CustodyLedgerDependency>;
  }
): Promise<void> {
  assertStoredVersion(
    args.version,
    "This custody record's payable reclassification",
    "posting this custody payable reclassification"
  );
  await ensureDealCustodyAccountsIfChartReady(ctx, args.orgId, args.actorId);
  const predecessorUnposted =
    args.version > 1 &&
    !(await custodyPayableReclassPosted(ctx, args.orgId, args.custody._id, args.version - 1));
  const dependencyBlock = predecessorUnposted
    ? null
    : await custodyDependencyBlockedReason(ctx, args.orgId, args.dependencies);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CUSTODY_PAYABLE_RECLASSIFIED",
    queueBehind: predecessorUnposted
      ? `custody payable reclassification v${args.version - 1} has not posted yet`
      : dependencyBlock ?? undefined,
    sourceType: "financeDealCustody",
    sourceId: args.custody._id.toString(),
    eventVersion: args.version,
    idempotencyKey: custodyPayableReclassKey(args.custody._id, args.version),
    currency: args.custody.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    requiredSystemKeys: [SYSTEM_KEYS.DEAL_CUSTODY_CLEARING, SYSTEM_KEYS.EMPLOYEE_REIMBURSEMENTS_PAYABLE],
    payload: {
      custodyId: args.custody._id.toString(),
      applicationId: args.custody.applicationId.toString(),
      userId: args.custody.userId.toString(),
      deltaMinor: args.deltaMinor,
      payableAfterMinor: args.payableAfterMinor,
      currency: args.custody.currency,
      ...custodyDependenciesPayload(args.dependencies),
    },
  });
}

/** Reopening a written-off record puts the shortage back on the employee's clearing balance. */
export async function hookCustodyWriteOffReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    version: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  assertStoredVersion(args.version, "This custody record's write-off posting", "reversing this custody write-off");
  return reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeDealCustody",
    sourceId: args.custodyId.toString(),
    eventType: "CUSTODY_WRITTEN_OFF",
    eventVersion: args.version,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `custody_write_off_reversal_${args.custodyId}_v${args.version}`,
    pendingPostIdempotencyKey: custodyWriteOffPostKey(args.custodyId, args.version),
  });
}
