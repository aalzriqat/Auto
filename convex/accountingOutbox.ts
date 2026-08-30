/**
 * accountingOutbox.ts
 *
 * Durable outbox for accounting events that could not post at the moment of the
 * domain operation (no chart of accounts, or no open accounting period covering
 * the date). The workflow hooks enqueue such events here rather than silently
 * skipping them, so a sale / payment / expense / disbursement is never made
 * operationally final without a captured, retryable GL record.
 *
 * The queue is re-driven (idempotently) whenever the conditions that gate
 * posting change — i.e. when a chart is initialized or a period is opened —
 * via a scheduled drain. Posting itself is idempotent (postAccountingEvent and
 * reverseAccountingEvent dedupe by idempotency key), so re-driving is safe even
 * if the original operation later posts directly.
 */
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { PostCommand, postAccountingEvent } from "./accounting/postingEngine";
import { prepaidPostingBlockedReason } from "./utils/prepaidSourceLedger";
import { payrollPostingBlockedReason } from "./utils/payrollSourceLedger";
import { commissionPostingBlockedReason } from "./utils/commissionSourceLedger";
import { reverseAccountingEvent } from "./accounting/reversals";
import { completeDeferredReversal, ReversalCompletionSource } from "./utils/depositApplications";
import {
  AUTHORITY_SEVERITY,
  authorityOutcomeDetail,
  DeferredAuthorityOutcome,
  restoreAuthorityAfterReversal,
  settleAuthorityAfterReversal,
} from "./commitments";
import { beginSystemRun, tryDecisionContext } from "./utils/commitmentKernel";
import { reinstateDirectDepositHold } from "./utils/commitmentWriters";
import { checkPostingAllowed } from "./accountingPeriods";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

// ─── Enqueue helpers (called from workflow hooks) ─────────────────────────────

export async function enqueuePendingPost(
  ctx: MutationCtx,
  cmd: PostCommand,
  reason: string
): Promise<void> {
  // Dedupe by idempotency key — never queue the same logical event twice.
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .unique();
  if (existing) return;

  await ctx.db.insert("pendingAccountingEvents", {
    orgId: cmd.orgId,
    kind: "POST",
    status: "PENDING",
    idempotencyKey: cmd.idempotencyKey,
    accountingDate: cmd.accountingDate,
    actorId: cmd.actorId,
    branchId: cmd.branchId,
    reason,
    attempts: 0,
    createdAt: Date.now(),
    eventType: cmd.eventType,
    sourceType: cmd.sourceType,
    sourceId: cmd.sourceId,
    eventVersion: cmd.eventVersion,
    occurredAt: cmd.occurredAt,
    currency: cmd.currency,
    payload: cmd.payload,
  });
}

export async function enqueuePendingReversal(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    originalEventId: Id<"accountingEvents">;
    reversalDate: number;
    reason: string;
    actorId: Id<"users">;
    idempotencyKey: string;
    sourceType: string;
    sourceId: string;
  }
): Promise<void> {
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  if (existing) return;

  await ctx.db.insert("pendingAccountingEvents", {
    orgId: args.orgId,
    kind: "REVERSE",
    status: "PENDING",
    idempotencyKey: args.idempotencyKey,
    accountingDate: args.reversalDate,
    actorId: args.actorId,
    reason: args.reason,
    attempts: 0,
    createdAt: Date.now(),
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    originalEventId: args.originalEventId,
  });
}

/**
 * Removes an unposted pending POST whose source operation was undone before it
 * could post (e.g. a sale enqueued while no period existed, then cancelled
 * before any period opened). The correct net GL footprint is zero, so the
 * queued event is simply dropped. Returns true if a record was removed.
 */
export async function cancelPendingPostByKey(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (existing && existing.kind === "POST" && existing.status !== "POSTED") {
    await ctx.db.delete(existing._id);
    return true;
  }
  return false;
}

/**
 * Removes every unposted (PENDING or FAILED) queued POST tied to a given
 * source record — for a source that gets voided/cancelled while it can have
 * more than one outstanding queued post at once (e.g. a monthly F&I
 * recognition deferral that failed to post in two different periods before
 * its sale was cancelled), cancelPendingPostByKey's single-idempotencyKey
 * lookup isn't enough: a stuck entry from an earlier period would survive
 * and could still post — recognizing revenue for something that no longer
 * exists — the next time the outbox drains. Returns the number removed.
 */
export async function cancelPendingPostsBySource(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
): Promise<number> {
  const entries = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId)
    )
    .collect();

  let cancelled = 0;
  for (const entry of entries) {
    if (entry.kind === "POST" && entry.status !== "POSTED") {
      await ctx.db.delete(entry._id);
      cancelled++;
    }
  }
  return cancelled;
}

// A pending event that fails this many times stops being auto-retried and
// moves to FAILED so it surfaces distinctly for manual attention (via
// listPending / retryFailed below) instead of retrying forever on every
// drain — the underlying cause (e.g. a still-missing chart of accounts) is
// usually not something that will resolve itself between drains.
const MAX_ATTEMPTS = 10;

// ─── Drain core (plain function, reused by the mutation + schedulers) ──────────

/**
 * Returns null when the rule declared the event has no accounting consequence —
 * a queued posting can legitimately resolve to nothing, and the drain treats
 * that as done rather than as a failure to retry forever.
 */
async function postPendingEntry(
  ctx: MutationCtx,
  p: Doc<"pendingAccountingEvents">
): Promise<Id<"accountingEvents"> | null> {
  if (!p.eventType) throw new Error("Pending POST record missing eventType");
  if (!p.currency) throw new Error("Pending POST record missing currency");
  const res = await postAccountingEvent(ctx, {
    orgId: p.orgId,
    branchId: p.branchId,
    eventType: p.eventType,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    eventVersion: p.eventVersion ?? 1,
    accountingDate: p.accountingDate,
    occurredAt: p.occurredAt ?? p.accountingDate,
    currency: p.currency,
    idempotencyKey: p.idempotencyKey,
    payload: (p.payload ?? {}) as Record<string, unknown>,
    actorId: p.actorId,
  });
  return res.eventId;
}

async function reversePendingEntry(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">): Promise<Id<"accountingEvents">> {
  if (!p.originalEventId) throw new Error("Pending REVERSE record missing originalEventId");
  const res = await reverseAccountingEvent(ctx, {
    orgId: p.orgId,
    originalEventId: p.originalEventId,
    reversalDate: p.accountingDate,
    reason: p.reason ?? "Reversal (deferred)",
    actorId: p.actorId,
    idempotencyKey: p.idempotencyKey,
  });
  return res.reversalEventId;
}

async function markEntryPosted(
  ctx: MutationCtx,
  p: Doc<"pendingAccountingEvents">,
  // Null when the rule declared the event has no accounting consequence. The
  // queued work is still finished — leaving it PENDING would retry a posting
  // that will correctly resolve to nothing every time, forever.
  resultEventId: Id<"accountingEvents"> | null
): Promise<void> {
  // A deferred deposit reversal is only finished once its journal exists. The
  // application and its slice sit at REVERSING until here, so that a share
  // whose original entry is still POSTED cannot be refunded or re-allocated in
  // the meantime.
  //
  // Done BEFORE the row is marked POSTED, not after. The journal already
  // exists by this point — `reversePendingEntry` returned — so nothing is lost
  // by ordering it first, and a throw in here used to be caught by the drain
  // loop and routed to `markEntryFailed`, which patched the SAME row that had
  // just been patched POSTED. The entry finished FAILED with `resolvedAt` set
  // while its journal sat in the ledger, and the application stayed REVERSING
  // with nothing left to finish it. Now a failure leaves the row untouched and
  // retryable, which is what the drain's error handling already expects.
  // ⚠️ THIS TRANSACTION FINISHES THE ACCOUNTING AND RECORDS WHAT AUTHORITY IS
  // OWED. IT PERFORMS NO AUTHORITY WRITES. (SCRUM-208 c15814.)
  //
  // Settlement used to happen right here, and it could not be made safe from
  // here. `drainEntries` wraps every row in a `try`/`catch` — correct for
  // accounting, because one bad row must not abort an organization's whole
  // drain — but that same catch makes the authority half un-rollbackable: an
  // unexpected failure AFTER a successor root, claim or pointer was written is
  // caught, the mutation returns normally and COMMITS the partial state, and it
  // is then labelled INCONSISTENT. Truthful about failure, and still a
  // half-restoration on a money path.
  //
  // Pre-flight guards closed every failure mode we had enumerated. They cannot
  // prove the next unenumerated one is impossible — and "all four or none" is
  // the property c15808 actually requires. So each freed source now becomes a
  // durable work item, settled in its OWN registered mutation where a throw is
  // a real rollback boundary.
  const owed: Id<"commitmentAuthorityWork">[] = [];
  if (p.kind === "REVERSE") {
    const freed = await completeDeferredReversal(ctx, {
      orgId: p.orgId,
      reversalIdempotencyKey: p.idempotencyKey,
      postedAt: Date.now(),
    });
    for (const source of freed) {
      const workId = await recordAuthorityWork(ctx, p, source);
      if (workId) owed.push(workId);
    }
  }

  // The accounting row is FINAL here, and is never retried because vehicle
  // authority is still pending, rival, ambiguous, withheld or failed. The
  // summary `authorityOutcome` is DERIVED later from the durable items — it is
  // no longer the mechanism that performs any authority write.
  await ctx.db.patch(p._id, {
    status: "POSTED",
    resolvedAt: Date.now(),
    ...(resultEventId ? { resultEventId } : {}),
    attempts: p.attempts + 1,
  });

  // ⚠️ SCHEDULED, NOT CALLED. A scheduled mutation runs in its own transaction,
  // outside this one and outside `drainEntries`' catch — which is the entire
  // point. Calling these inline would rebuild the defect with more steps.
  for (const workId of owed) {
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.beginAuthorityWork, { workId });
  }
}

/**
 * Record that one exact source episode is owed a canonical authority
 * settlement. Returns the work item, or null if it already existed.
 *
 * ⚠️ AT MOST ONE ITEM PER SOURCE EPISODE, ENFORCED BY AN EXACT LOOKUP. The
 * identity is built only from STORED FACTS — the accounting row's own
 * `reversed_<applicationKey>` and the id of the exact slice or deposit. No
 * clock, no "newest row" selector, no history inference, no fabricated hold
 * row. So a re-drained accounting row or a re-run worker cannot mint a second
 * work item, and therefore cannot mint a second root or successor claim.
 */
async function recordAuthorityWork(
  ctx: MutationCtx,
  p: Doc<"pendingAccountingEvents">,
  source: ReversalCompletionSource
): Promise<Id<"commitmentAuthorityWork"> | null> {
  const workKey = `${p.idempotencyKey}:${source.kind}:${String(source.holdId ?? source.depositId)}`;
  const existing = await ctx.db
    .query("commitmentAuthorityWork")
    .withIndex("by_org_work_key", (q) => q.eq("orgId", p.orgId).eq("workKey", workKey))
    .unique();
  if (existing) return null;

  return await ctx.db.insert("commitmentAuthorityWork", {
    orgId: p.orgId,
    workKey,
    status: "PENDING" as const,
    sourceKind: source.kind,
    depositId: source.depositId,
    vehicleId: source.vehicleId,
    saleId: source.saleId,
    ...(source.holdId ? { holdId: source.holdId } : {}),
    pendingEventId: p._id,
    attempts: 0,
    createdAt: Date.now(),
  });
}

/**
 * How many settlement attempts one source episode gets before it stops being a
 * retry and becomes a repair condition a person must look at.
 */
const MAX_AUTHORITY_ATTEMPTS = 5;

/**
 * SCRUM-208 c15814 — STEP ONE OF TWO: SPEND AN ATTEMPT, DURABLY.
 *
 * ⚠️ THIS EXISTS AS A SEPARATE TRANSACTION ON PURPOSE. The settlement itself
 * must roll back completely when it fails — that is the whole point of the
 * split — and a rollback would take the attempt counter with it. An item that
 * fails permanently would then be retried forever, and nothing would ever
 * surface it. Incrementing here, in a transaction that COMMITS before the
 * settlement one begins, is what makes the retry bounded AND genuinely
 * rolled back. Those two properties cannot share a transaction.
 */
export const beginAuthorityWork = internalMutation({
  args: { workId: v.id("commitmentAuthorityWork") },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    // Terminal or vanished: nothing owed. This is the at-most-once guard for a
    // duplicate schedule, a re-drained accounting row, or the sweep racing a
    // worker that already finished.
    if (!work || work.status !== "PENDING") return;

    if (work.attempts >= MAX_AUTHORITY_ATTEMPTS) {
      // ⚠️ BLOCKED IS TERMINAL AND VISIBLE, NEVER A SILENT GIVE-UP. The
      // accounting stays complete; the car keeps whatever authority it has;
      // a person is told this one needs them.
      await ctx.db.patch(work._id, {
        status: "BLOCKED" as const,
        outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT" as const,
        outcomeAt: Date.now(),
        outcomeDetail:
          "this vehicle's authority could not be settled after repeated attempts, so a person must review it",
        settledAt: Date.now(),
      });
      await summariseAuthorityOnEvent(ctx, work);
      return;
    }

    await ctx.db.patch(work._id, { attempts: work.attempts + 1, lastAttemptAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.performAuthoritySettlement, {
      workId: work._id,
    });
  },
});

/**
 * SCRUM-208 c15814 — STEP TWO OF TWO: SETTLE ONE SOURCE EPISODE, ATOMICALLY.
 *
 * ⚠️ NOTHING CATCHES IN HERE, AND THAT IS THE FEATURE. This is a registered
 * mutation of its own, so an unexpected throw aborts THIS transaction and
 * nothing else: no successor root, no claim, no moved pointer, no re-held
 * source, no vehicle projection. The accounting reversal committed in an
 * earlier transaction and is untouched; the work item stays PENDING with its
 * attempt already spent, so the sweep will try again.
 *
 * That is the property the old in-drain catch could never provide. It ran
 * under `drainEntries`' per-row `try`/`catch`, so a post-write failure was
 * absorbed, the mutation returned normally, and the partial authority state
 * COMMITTED — labelled INCONSISTENT, which was honest and still wrong.
 *
 * ⚠️ SO DO NOT ADD A `try`/`catch` HERE. Converting a throw into a recorded
 * outcome from inside this mutation reintroduces the exact defect: the writes
 * made before it would commit. Expected business answers already come back as
 * typed values and never throw; anything that DOES throw is precisely the case
 * that must roll back rather than be described.
 */
export const performAuthoritySettlement = internalMutation({
  args: { workId: v.id("commitmentAuthorityWork") },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (!work || work.status !== "PENDING") return;

    const settled = await settleOneReversalSource(
      ctx,
      work.orgId,
      {
        kind: work.sourceKind,
        depositId: work.depositId,
        vehicleId: work.vehicleId,
        saleId: work.saleId,
        ...(work.holdId ? { holdId: work.holdId } : {}),
      },
      Date.now(),
      // The episode is recorded as opened by whoever initiated the reversal —
      // carried on the accounting row, because a scheduled run has no user.
      (await ctx.db.get(work.pendingEventId))!.actorId
    );

    // ⚠️ `null` IS "NOT OURS TO SETTLE", AND IT IS NOT AN OUTCOME.
    //
    // The source vanished, or the hold belongs to another dealership. The work
    // is finished — leaving it PENDING would retry forever — but inventing a
    // taxonomy answer for it would be a false audit record, and
    // NO_RESTORABLE_BASIS specifically means "lawfully nothing to restore",
    // which is a different statement from "this was never mine". So it
    // terminalizes with NO outcome, and the summary skips it.
    if (!settled) {
      await ctx.db.patch(work._id, { status: "SETTLED" as const, settledAt: Date.now() });
      return;
    }

    await ctx.db.patch(work._id, {
      status: "SETTLED" as const,
      outcome: settled.outcome,
      outcomeAt: Date.now(),
      ...(authorityOutcomeDetail(settled) !== undefined
        ? { outcomeDetail: authorityOutcomeDetail(settled)! }
        : {}),
      settledAt: Date.now(),
    });
    await summariseAuthorityOnEvent(ctx, work);
  },
});

/**
 * Derive the accounting row's summary outcome from the durable work items.
 *
 * ⚠️ DERIVED AFTER SETTLEMENT — IT PERFORMS NO AUTHORITY WRITES. The worst
 * outcome still wins, and the order the episodes settle in still must not
 * matter, but this now reads answers that are already durable instead of being
 * the loop that produces them. A reversal freeing several cars records
 * "RESTORED" for one of them and a blocked condition for another; the summary
 * must never let the clean car bury the one that needs a person.
 *
 * The siblings are found by an EXACT bounded range over `workKey`, which is
 * prefixed by this accounting row's own idempotency key — no scan, and no
 * second index for something the identity already encodes.
 */
async function summariseAuthorityOnEvent(
  ctx: MutationCtx,
  work: Doc<"commitmentAuthorityWork">
): Promise<void> {
  const event = await ctx.db.get(work.pendingEventId);
  if (!event) return;

  const prefix = `${event.idempotencyKey}:`;
  const siblings = await ctx.db
    .query("commitmentAuthorityWork")
    .withIndex("by_org_work_key", (q) =>
      q.eq("orgId", work.orgId).gte("workKey", prefix).lt("workKey", `${prefix}￿`)
    )
    .collect();

  let worst: Doc<"commitmentAuthorityWork"> | null = null;
  for (const s of siblings) {
    if (!s.outcome) continue;
    if (!worst || AUTHORITY_SEVERITY[s.outcome] > AUTHORITY_SEVERITY[worst.outcome!]) worst = s;
  }
  if (!worst || !worst.outcome) return;

  await ctx.db.patch(event._id, {
    authorityOutcome: worst.outcome,
    authorityOutcomeAt: Date.now(),
    ...(worst.outcomeDetail !== undefined ? { authorityOutcomeDetail: worst.outcomeDetail } : {}),
  });
}

/**
 * SCRUM-208 c15814 — THE RETRY SWEEP. Work that rolled back stays owed.
 *
 * ⚠️ IT READS ONLY THIS TABLE, AND ONLY ITS OWN PENDING ROWS. Nothing infers
 * authority work from a historical POSTED accounting row: an old row with no
 * work item is legacy and fails closed, exactly as an unactivated organization
 * does. SCRUM-201 owns any live backlog reconciliation, and this is not it.
 */
export const sweepAuthorityWork = internalMutation({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const owed = await ctx.db
      .query("commitmentAuthorityWork")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .take(Math.min(args.limit ?? 25, 100));

    for (const work of owed) {
      await ctx.scheduler.runAfter(0, internal.accountingOutbox.beginAuthorityWork, {
        workId: work._id,
      });
    }
    return { scheduled: owed.length };
  },
});

/**
 * Re-exported from `commitments.ts`, where it is DEFINED, beside the taxonomy
 * it ranks. Both cancellation paths need this order and two copies of it would
 * be two opinions about which condition is worse.
 */
export { AUTHORITY_SEVERITY };

// ⚠️ `settleFreedHoldsAuthority` WAS HERE, AND IT IS NOT COMING BACK.
//
// It looped every freed source inside the accounting drain and wrapped each one
// in a `try`/`catch`, turning an unexpected failure into a recorded
// INCONSISTENT outcome. That closed the SILENCE and could never close the
// DEFECT: the catch ran inside `drainEntries`' own transaction, so every
// authority write made before the failure COMMITTED anyway and was then
// labelled inconsistent. Honest about failure, and still a half-restoration on
// a money path (SCRUM-208 c15814).
//
// Settlement now happens one source episode at a time, in
// `performAuthoritySettlement` — a registered mutation of its own, where a
// throw is a real rollback boundary. The worst-outcome-wins summary still
// exists, in `summariseAuthorityOnEvent`, but it now DERIVES from durable work
// items instead of being the loop that writes them.
//
// If a future change needs "settle them all here", that is this defect
// returning. `authorityWorkIsolation.test.ts` fails when settlement can commit
// partial authority state from inside the drain.

/**
 * Finish one source whose reversing journal has now posted.
 *
 * ⚠️ THE ACCOUNTING IS ALREADY DONE AND STAYS DONE. Every branch below leaves
 * the reversal completed. What varies is only whether the CAR comes back, and
 * a car that cannot come back is reported rather than forced.
 *
 * ⚠️ AT MOST ONCE, AND INDEPENDENT OF QUEUE ORDER. The restoration is decided
 * from PERSISTED state — the deposit's own hold flag and the vehicle's
 * ownership — not from anything the drain remembers about what it has already
 * seen. A second completion for the same source therefore finds the work done
 * and changes nothing, whichever order the entries drain in.
 */
async function settleOneReversalSource(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  source: ReversalCompletionSource,
  decisionNow: number,
  actorId: Id<"users">
): Promise<DeferredAuthorityOutcome | null> {
  const run = beginSystemRun("accountingOutbox.settleOneReversalSource", decisionNow);

  if (source.kind === "SLICE") {
    // A slice does NOT go back on hold — it waits for a manager to decide
    // between refund and re-allocation. So there is no source to make live and
    // nothing to restore: only the vehicle authority settles.
    const hold = source.holdId ? await ctx.db.get(source.holdId) : null;
    if (!hold || hold.orgId !== orgId) return null;
    const context = await tryDecisionContext(ctx, run, orgId);
    return await settleAuthorityAfterReversal(ctx, {
      orgId,
      vehicleId: hold.vehicleId,
      decisionNow,
      reason: "deferred reversal posted",
      ...(context.kind === "READY" ? { decision: context.decision } : {}),
    });
  }

  const deposit = await ctx.db.get(source.depositId);
  if (!deposit || deposit.orgId !== orgId) return null;
  // The money must still be reinstatable. A row refunded or forfeited in the
  // meantime has had real money leave the business, and putting the car back
  // on hold for it would make that money spendable a second time.
  if (deposit.status !== "HELD") {
    return {
      outcome: "ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS",
      detail: `the deposit is ${deposit.status}`,
    };
  }

  // ⚠️ NO SECOND OPINION ABOUT OWNERSHIP HERE. THAT WAS THE DEFECT.
  //
  // This used to take its own `resolveOwnership` reading before reinstating
  // the hold, and treat ANY owned root as a rival. It cannot tell a rival's
  // root from a later generation of THIS deal's own lineage — so on a deal
  // paid in two instalments with both reversals deferred, the first instalment
  // restored the deal and the second was then reported as a rival of its own
  // customer's root. That money stayed HELD with no active hold and no
  // episode, invisible to the canonical reader; releasing the first deposit
  // afterwards would free the car while the dealership still held the second.
  //
  // The resolver already owns that judgment and answers JOIN_LINEAGE. So the
  // hold is handed to the spine as the step to run once the decision says the
  // deal comes back — in the same transaction as the episode that justifies
  // it — and this function no longer decides anything about the vehicle.
  return await restoreAuthorityAfterReversal(ctx, {
    run,
    orgId,
    vehicleId: source.vehicleId,
    source: { kind: "DEPOSIT", depositId: deposit._id },
    saleId: source.saleId,
    createdBy: actorId,
    makeSourceLive: async (inner) => {
      await reinstateDirectDepositHold(inner, { orgId, depositId: deposit._id });
    },
  });
}

/**
 * Below the retry threshold: keep it PENDING and retryable, just surface the
 * error for visibility. At/above it: stop auto-retrying and mark FAILED so it
 * needs deliberate attention instead of retrying forever.
 */
async function markEntryFailed(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">, message: string): Promise<void> {
  const attempts = p.attempts + 1;
  await ctx.db.patch(p._id, {
    attempts,
    lastError: message,
    ...(attempts >= MAX_ATTEMPTS ? { status: "FAILED" as const } : {}),
  });
}

/**
 * Records WHY an entry was skipped without counting it as an attempt, so it
 * stays PENDING and drains by itself once its blocker clears. The reason lands
 * in lastError purely so it is visible on the Accounting → Setup pending list —
 * an entry that silently refuses to post with no explanation is worse for the
 * accountant than one that fails loudly.
 */
async function markEntryHeld(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">, reason: string): Promise<void> {
  const lastError = `Waiting to post: ${reason}.`;
  if (p.lastError === lastError) return;
  await ctx.db.patch(p._id, { lastError });
}

/**
 * Attempts to post/reverse a batch of already-fetched outbox rows, one at a
 * time, isolating each row's failure from the rest. Factored out of
 * drainPendingForOrg so a narrower, pre-filtered subset (e.g. one prepaid
 * schedule's own rows — see prepaidExpenses.redriveScheduleEvents) can share
 * the exact same posting/retry/dead-letter logic instead of re-implementing it.
 */
export async function drainEntries(
  ctx: MutationCtx,
  entries: Doc<"pendingAccountingEvents">[]
): Promise<{ posted: number; failed: number; held: number }> {
  let posted = 0;
  let failed = 0;
  let held = 0;

  for (const p of entries) {
    // A drain is org-wide, but the events that trigger one (a period opening, a
    // chart being initialized) are not specific to any entry. So an entry whose
    // own period simply isn't open yet gets swept into every unrelated drain and
    // charged an attempt each time — ten unrelated period-opens and a perfectly
    // valid entry dead-letters, after which no drain will ever touch it again
    // and its GL impact silently disappears until someone spots it in the FAILED
    // list. Waiting on your own period is not failing, so hold instead: the
    // entry stays PENDING with a visible reason and posts by itself the moment
    // its period opens. A CLOSED or LOCKED period is a different matter — that
    // is a deliberate refusal that will not resolve on its own, so it still
    // burns attempts and dead-letters as designed.
    const periodCheck = await checkPostingAllowed(ctx, p.orgId, p.accountingDate);
    if (!periodCheck.ok && periodCheck.waiting) {
      await markEntryHeld(ctx, p, periodCheck.reason);
      held++;
      continue;
    }

    // Posting-side guard. What makes an entry drain is "a period covering THIS
    // entry's date opened" — which says nothing about whether the entry is
    // still coherent with the rest of the ledger. A prepaid correction queued
    // before prepaidExpenses.ts's guard existed would otherwise post here and
    // credit an asset whose debit is still queued, recreating the exact
    // negative balance that guard prevents, with no operator action. Reversals
    // are exempt: they unwind something that already posted.
    if (p.kind === "POST") {
      let blockedReason: string | null;
      try {
        blockedReason =
          (await prepaidPostingBlockedReason(ctx, p)) ??
          (await payrollPostingBlockedReason(ctx, p)) ??
          (await commissionPostingBlockedReason(ctx, p));
      } catch (err) {
        // A guard that THROWS must fail this one entry, not the drain. These
        // guards walk data the admin raw-JSON editor can write, so a single
        // malformed row could otherwise abort the whole mutation — and because
        // every drain starts from the same query, that row would be hit first
        // every time, silently stopping all GL posting for the organization.
        const message = err instanceof Error ? err.message : String(err);
        await markEntryFailed(ctx, p, `posting guard failed: ${message}`);
        failed++;
        continue;
      }
      if (blockedReason) {
        // Held, not failed: this entry is not broken and retrying it is not
        // wrong — it is waiting on something else to post first. Routing it
        // through markEntryFailed would burn attempts and eventually
        // dead-letter a perfectly valid entry for someone else's blocker.
        await markEntryHeld(ctx, p, blockedReason);
        held++;
        continue;
      }
    }
    try {
      const resultEventId = p.kind === "POST" ? await postPendingEntry(ctx, p) : await reversePendingEntry(ctx, p);
      await markEntryPosted(ctx, p, resultEventId);
      posted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markEntryFailed(ctx, p, message);
      failed++;
    }
  }

  return { posted, failed, held };
}

export async function drainPendingForOrg(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  limit = 50
): Promise<{ posted: number; failed: number; held: number }> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .take(Math.min(limit, 200));

  return drainEntries(ctx, pending);
}

// ─── Internal mutation (scheduler target) ─────────────────────────────────────

/** Pages per uninterrupted scheduler chain, before the sweep yields and resumes. */
const MAX_DRAIN_PASSES = 40;

/**
 * How long a sweep waits before resuming from its cursor once the pass budget is
 * spent. Long enough that a large backlog cannot monopolize the scheduler, short
 * enough that draining it stays a matter of minutes rather than days.
 */
const DRAIN_RESUME_DELAY_MS = 60_000;

/**
 * Drains one PAGE and continues with a cursor until the org's PENDING rows are
 * exhausted or the sweep budget runs out.
 *
 * Cursor, not "did we make progress". `drainPendingForOrg` always reads the
 * OLDEST PENDING rows, and a held row stays PENDING — so a first batch that is
 * entirely held meant no progress, no continuation, and every postable row
 * behind it went unexamined however long it waited. Paging past them fixes
 * that. It also fixes the mirror-image problem: counting failures as progress
 * re-read the same rows on the next pass, so a batch of genuinely failing
 * entries burned through MAX_ATTEMPTS in seconds and dead-lettered entries that
 * a later retry would have posted. A cursor visits each row at most once per
 * sweep, so one sweep costs each row exactly one attempt.
 */
async function drainPageAndContinue(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  limit: number,
  cursor: string | null,
  pass: number
): Promise<{ posted: number; failed: number; held: number }> {
  const page = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .paginate({ cursor, numItems: Math.min(limit, 200) });

  const result = await drainEntries(ctx, page.page);

  console.log(
    `[outbox-drain] org ${orgId} pass ${pass}: posted ${result.posted}, failed ${result.failed}, held ${result.held}`
  );

  if (!page.isDone) {
    // Always continue FROM THE CURSOR, even when the pass budget is spent.
    //
    // Stopping here used to drop the cursor, and every later trigger — cron or
    // redrive — restarts at `null`. That reinstated the very starvation the
    // cursor was added to remove, just further out: with a full budget the
    // oldest 2,050 rows are all any sweep ever examines, so if those are held,
    // nothing behind them is ever attempted again. Moving a permanent boundary
    // is not removing it.
    //
    // The budget still does its real job of bounding one uninterrupted
    // scheduler chain; it just yields instead of giving up. The delayed
    // continuation resets the counter, so the sweep advances monotonically
    // through the cursor and terminates on `isDone` regardless of backlog size,
    // while capping how much work any one org can demand per minute.
    const budgetSpent = pass >= MAX_DRAIN_PASSES;
    if (budgetSpent) {
      console.warn(
        `[outbox-drain] org ${orgId}: pass budget spent with rows remaining — resuming from the cursor in ${DRAIN_RESUME_DELAY_MS}ms`
      );
    }
    await ctx.scheduler.runAfter(
      budgetSpent ? DRAIN_RESUME_DELAY_MS : 0,
      internal.accountingOutbox.drainPendingAccountingEvents,
      {
        orgId,
        limit,
        cursor: page.continueCursor,
        pass: budgetSpent ? 0 : pass + 1,
      }
    );
  }

  // ⚠️ AUTHORITY WORK THAT ROLLED BACK IS STILL OWED, so a finished drain
  // re-offers this organization's PENDING work items to their own transactions.
  //
  // A settlement that fails rolls its whole mutation back — that is the design —
  // so nothing re-schedules it from inside. Riding the drain gives it a real
  // retry without inventing cron infrastructure or enumerating tenants: the
  // events that drain an org (a period opening, a chart initializing, an
  // operator redrive) re-offer its owed work.
  //
  // ⚠️ ONCE PER DRAIN, NOT ONCE PER PAGE. A multi-page backlog continues through
  // this function many times, and scheduling a sweep from each pass would queue
  // one redundant sweep per page while changing nothing — the sweep is bounded
  // and idempotent, so the extra invocations are pure noise. It fires when the
  // drain has actually finished.
  //
  // ⚠️ Stated honestly rather than oversold: an org that never drains again does
  // not retry on its own. The work stays PENDING and findable by an exact range
  // rather than being lost, and SCRUM-201 — not this change — owns live backlog
  // recovery.
  if (page.isDone) {
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.sweepAuthorityWork, { orgId });
  }

  return result;
}

export const drainPendingAccountingEvents = internalMutation({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    pass: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    drainPageAndContinue(ctx, args.orgId, args.limit ?? 50, args.cursor ?? null, args.pass ?? 0),
});

// ─── Visibility query ─────────────────────────────────────────────────────────

export const listPending = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("POSTED"), v.literal("FAILED"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const limit = Math.min(args.limit ?? 50, 200);
    if (args.status) {
      return ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});

/** Manual re-drive trigger (MANAGE_FINANCE) for operators clearing a backlog. */
export const redrive = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    // Drains the first PAGE and continues from that page's cursor. Draining
    // inline and then scheduling a cursorless sweep charged a failing row two
    // attempts per button press — the inline call left it PENDING and the sweep
    // selected it again immediately — so a row on its eighth attempt
    // dead-lettered on one click, spending the retry budget the operator was
    // trying to give it. The caller still gets this page's counts to show.
    return drainPageAndContinue(ctx, args.orgId, 50, null, 0);
  },
});

/**
 * Resets a dead-lettered event back to PENDING (with a fresh attempts count)
 * for another round of automatic retries, once whatever caused it to exhaust
 * MAX_ATTEMPTS has been fixed (e.g. the chart of accounts is now initialized).
 * Does not itself attempt to post — call redrive/drainPendingForOrg after.
 */
export const retryFailed = mutation({
  args: { orgId: v.id("organizations"), pendingEventId: v.id("pendingAccountingEvents") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const event = await ctx.db.get(args.pendingEventId);
    if (!event || event.orgId !== args.orgId) {
      throw new ConvexError("Pending accounting event not found in this organization.");
    }
    if (event.status !== "FAILED") {
      throw new ConvexError(`Only a FAILED event can be retried (current status: ${event.status}).`);
    }

    await ctx.db.patch(args.pendingEventId, { status: "PENDING", attempts: 0, lastError: undefined });
  },
});
