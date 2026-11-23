import type { DealCostAccounting } from "./dealCostAccounting";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  assertStoredVersion,
  custodyEntryPostKey,
  custodyFeePostKey,
  custodyPositionDependencies,
  foldAbandonedPayableDeltas,
  nextStoredVersion,
  type CustodyLedgerDependency,
} from "../custodySourceLedger";
import { APPLICATION_NOT_FOUND, CUSTODY_NOT_FOUND, FEE_NOT_FOUND, isTimestamp } from "./dealCostGuards";
import { loadActiveFees, summarizeReadableCustody } from "../settlementDeductions";
import {
  hookCustodyCashMoved,
  hookCustodyFeePaid,
  hookCustodyFeeReversed,
  hookCustodyPayableReclassified,
  type ReversalOutcome,
} from "../../accounting/workflowHooks";
import { isMinorAmount } from "../financingEconomics";
import { requireLinkedCustody } from "./custodyRecords";
import { custodyFeeExpenseKey } from "../dealCustodyPosting";
import { requireOwnedRow } from "../tenancy";
import { assertFeeDocWithinBytes, feeAfterPatch } from "../feeDocLimits";

/**
 * Keeps EMPLOYEE_REIMBURSEMENTS_PAYABLE carrying exactly this record's
 * out-of-pocket position (Codex AF-CUST-01).
 *
 * After every movement that can change the position — a cash leg, its
 * reversal, a custody-paid fee posted, re-posted or reversed — the target
 * payable is `max(0, −position)` with `position = issued − returned −
 * custody-paid fees + reimbursed`, the engine's own identity. The difference
 * against what is already on the books posts as ONE signed delta, so the
 * split is a function of the position and not of the order cash and receipts
 * arrived. The primary journals are never touched: a reversed movement keeps
 * its exact inverse, and the delta that follows restores the split. Nothing
 * posts when the delta is zero, and a legacy record (nothing on the ledger)
 * carries no payable either.
 *
 * Refuses (and rolls the caller back) when the position cannot be read — an
 * unreadable amount is not a liability anyone can state.
 *
 * Each version is CAUSALLY CHAINED behind the one before it (final round A):
 * a delta whose predecessor is still queued — dated into a closed month — is
 * queued behind it rather than posted, and the outbox posts them in order.
 * The row therefore carries the chain's target (`payableTargetMinor`), and
 * what the ledger holds right now is asked of the ledger.
 *
 * And each version is chained behind the PRIMARY POSTINGS it reflects: the
 * delta is computed from the rows, so it is only true of the books once
 * every leg and line the position is made of is where the ledger must show
 * it — `custodyPositionDependencies` names the WHOLE position (every leg
 * SETTLED or OFF the books, every ever-posted line at its current version
 * and off it at every other), and the caller adds the postings this very
 * correction changed (the forward key that must be POSTED, the replaced key
 * that must be OFF the books). The hook queues the delta behind an unmet
 * one, the worker re-proving the same off the queued row. A payable that
 * moved to the corrected position while the clearing account still carried
 * the old charge — or that credited an issuance still queued for a closed
 * month — is exactly what a snapshot between the two would report.
 *
 * And a queued version whose primary was CANCELLED before it posted is not
 * awaited and not posted: `foldAbandonedPayableDeltas` drops it, with the
 * queued tail above it, and this version is issued in its place from the
 * target the POSTED chain reached (follow-up audit, H3).
 */
export async function syncCustodyPayable(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">,
  actorId: Id<"users">,
  occurredAt: number,
  dependencies: ReadonlyArray<CustodyLedgerDependency>
): Promise<void> {
  const custody = await ctx.db.get(custodyId);
  if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
  if (custody.ledgerPosting !== "CANONICAL") return;
  const action = "reclassifying this custody record's balance";
  const summary = summarizeReadableCustody(custody, await loadActiveFees(ctx, custody.applicationId), action);
  const position = summary.remainingEmployeeBalanceMinor + custody.reimbursedMinor;
  const target = Math.max(0, -position);
  // The delta is against the chain's TARGET, not the ledger's balance: a
  // version still waiting in the outbox is part of the chain and will post
  // in order (the hook queues each version behind an unposted predecessor),
  // so the next delta is measured from where the chain will land — less any
  // queued version that followed a primary the ledger will never carry,
  // which is dropped here and re-based into this one.
  const { nextVersion, baseTargetMinor } = await foldAbandonedPayableDeltas(ctx, custody, action);
  // The chain's date stamps, one per issued version, from which the worker
  // proves a queued delta's envelope. A fold that re-bases at a lower
  // version drops the stamps of the versions it dropped with it.
  const stamps = (custody.payableReclassIssued ?? []).filter((stamp) => stamp.version < nextVersion);
  const delta = target - baseTargetMinor;
  if (delta === 0) {
    if (nextVersion !== (custody.payableReclassVersion ?? 0) + 1) {
      await ctx.db.patch(custodyId, {
        payableTargetMinor: target,
        payableReclassVersion: nextVersion - 1,
        payableReclassIssued: stamps,
        updatedAt: Date.now(),
      });
    }
    return;
  }
  const positionDependencies = await custodyPositionDependencies(ctx, custody, action);
  const seen = new Set(positionDependencies.map((d) => `${d.must}:${d.idempotencyKey}`));
  const merged = [...positionDependencies];
  for (const dependency of dependencies) {
    const key = `${dependency.must}:${dependency.idempotencyKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dependency);
  }
  await hookCustodyPayableReclassified(ctx, {
    orgId: custody.orgId,
    custody,
    version: nextVersion,
    deltaMinor: delta,
    payableAfterMinor: target,
    actorId,
    occurredAt,
    dependencies: merged,
  });
  await ctx.db.patch(custodyId, {
    payableTargetMinor: target,
    payableReclassVersion: nextVersion,
    payableReclassIssued: [...stamps, { version: nextVersion, occurredAt }],
    updatedAt: Date.now(),
  });
}

/**
 * Makes the ledger agree with one fee line's custody charge.
 *
 * The line is on the books as a custody-paid cost at most ONCE, at its
 * current actual, against its current custody — `custodyPosted` says what
 * that is. Anything that changes it (a corrected amount, a re-charge to
 * another record, an unlink, a void) reverses the live version through the
 * canonical reversal path and, if a live charge remains, posts the next
 * version. Called AFTER the row has been written, on the row as it now is,
 * so the ledger follows the record and never the caller's intent.
 *
 * Nothing posts for a line without an actual, or with a zero actual: "the
 * company charged nothing for it" is a fact with no journal.
 */
export async function syncCustodyFeePosting(
  ctx: MutationCtx,
  feeId: Id<"financeDealFees">,
  actorId: Id<"users">,
  reason: string
): Promise<void> {
  const fee = await ctx.db.get(feeId);
  if (fee === null) throw new ConvexError(FEE_NOT_FOUND);
  const live =
    fee.voidedAt === undefined &&
    fee.custodyId !== undefined &&
    fee.actualAmountMinor !== undefined &&
    isMinorAmount(fee.actualAmountMinor) &&
    fee.actualAmountMinor > 0;
  const target = live ? { custodyId: fee.custodyId!, amountMinor: fee.actualAmountMinor! } : null;
  const posted = fee.custodyPosted;
  const unchanged =
    posted !== undefined &&
    target !== null &&
    posted.custodyId === target.custodyId &&
    posted.amountMinor === target.amountMinor;
  if (unchanged) return;

  // Both stored links are proven this org's, on this deal, and the claimed
  // version proven a version, BEFORE the reversal, the re-post and the
  // payable syncs they drive (R7, F3 + F4): nothing below acts on a link or
  // a number the row merely carries.
  const action = "syncing this cost's custody posting";
  if (posted !== undefined) {
    await requireLinkedCustody(ctx, fee, posted.custodyId, action);
    assertStoredVersion(posted.version, "This cost line's custody posting", action);
  }
  if (target !== null) await requireLinkedCustody(ctx, fee, target.custodyId, action);

  const now = Date.now();
  // What became of the live version: a DEFERRED reversal leaves it POSTED
  // until the outbox drains, and the replacement below is queued behind it
  // rather than posted beside it (consolidated round, item 2).
  let reversal: ReversalOutcome | undefined;
  if (posted !== undefined) {
    reversal = await hookCustodyFeeReversed(ctx, {
      orgId: fee.orgId,
      feeId: fee._id,
      version: posted.version,
      reason,
      actorId,
      reversalDate: now,
    });
    await ctx.db.patch(fee._id, { custodyPosted: undefined, updatedAt: now });
  }
  // The postings the payable deltas below are consequences of: the version
  // that was on the books must be OFF it, the replacement (if any) ON it.
  const replacedOffBooks: CustodyLedgerDependency[] =
    posted !== undefined ? [{ must: "OFF_BOOKS", idempotencyKey: custodyFeePostKey(fee._id, posted.version) }] : [];
  if (target === null) {
    // The record the line left (or was voided on) may have owed the employee
    // for it; its payable follows the position, dated with the correction —
    // and held behind the reversal of the charge it no longer carries.
    if (posted !== undefined) await syncCustodyPayable(ctx, posted.custodyId, actorId, now, replacedOffBooks);
    return;
  }

  const expense = custodyFeeExpenseKey(fee.accountingTreatment);
  if (expense.systemKey === null) throw new ConvexError(expense.refusal);
  const version = nextStoredVersion(fee.custodyPostingVersion, "This cost line", action);
  // A fresh charge is posted against a deal that EXISTS in this org (R6,
  // F3): a line whose parent is gone or another tenant's is never put on
  // the books, whatever door led here. Thrown before the forward posts, so
  // the mutation rolls back — the reversal above with it — and nothing moves.
  const app = await requireOwnedRow(ctx, fee.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  // Dated when the employee paid it, where that is known and readable;
  // otherwise when it was recorded. A past date in a closed period queues.
  // The same instant is stamped on the version (`custodyPosted.occurredAt`)
  // so the worker can prove a queued row's envelope against it.
  const occurredAt = fee.paidAt !== undefined && isTimestamp(fee.paidAt) ? fee.paidAt : now;
  await hookCustodyFeePaid(ctx, {
    orgId: fee.orgId,
    fee,
    custodyId: target.custodyId,
    vehicleId: app.vehicleId,
    version,
    amountMinor: target.amountMinor,
    actorId,
    occurredAt,
    replacesReversal: reversal,
  });
  const postedPatch = {
    custodyPosted: { version, amountMinor: target.amountMinor, custodyId: target.custodyId, occurredAt },
    custodyPostingVersion: version,
    updatedAt: now,
  };
  assertFeeDocWithinBytes(feeAfterPatch(fee, postedPatch), "posting this cost to custody");
  await ctx.db.patch(fee._id, postedPatch);
  // The receiving record's payable, dated with the fee and held behind the
  // replacement version (which is itself queued behind the deferred reversal
  // of the version it replaces) and, on the same record, behind that
  // reversal too; and the record the line moved off, if any, dated with the
  // correction and held behind the reversal alone.
  const replacementPosted: CustodyLedgerDependency = {
    must: "SETTLED",
    idempotencyKey: custodyFeePostKey(fee._id, version),
  };
  await syncCustodyPayable(
    ctx, target.custodyId, actorId,
    occurredAt,
    posted !== undefined && posted.custodyId === target.custodyId
      ? [...replacedOffBooks, replacementPosted]
      : [replacementPosted]
  );
  if (posted !== undefined && posted.custodyId !== target.custodyId) {
    await syncCustodyPayable(ctx, posted.custodyId, actorId, now, replacedOffBooks);
  }
}

/** Posts one freshly inserted cash entry (ISSUED / RETURNED / REIMBURSED) against its custody record. */
export async function postCustodyEntry(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">,
  entryId: Id<"financeDealCustodyEntries">,
  actorId: Id<"users">
): Promise<void> {
  const [custody, entry] = await Promise.all([ctx.db.get(custodyId), ctx.db.get(entryId)]);
  if (custody === null || entry === null || entry.kind === "REVERSAL") {
    throw new ConvexError(CUSTODY_NOT_FOUND);
  }
  await hookCustodyCashMoved(ctx, { orgId: custody.orgId, entry, custody, kind: entry.kind, actorId });
  // The split follows the leg, so it is held behind the leg's own posting.
  await syncCustodyPayable(ctx, custodyId, actorId, entry.occurredAt, [
    { must: "SETTLED", idempotencyKey: custodyEntryPostKey(entry._id) },
  ]);
}
