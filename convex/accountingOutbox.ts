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
  probeCanonicalHold,
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
  //
  // ⚠️ THIS IS A LATENCY OPTIMISATION, NOT THE RETRY MECHANISM. Settling a
  // freed car should not wait for the next cron tick. But retry LIVENESS comes
  // from `dispatchDueAuthorityWork` reading `nextActionAt`, never from
  // accounting traffic — so an organization that never drains again still
  // retries, which the old drain-riding sweep could not say. And an extra
  // delivery here is now harmless rather than a spent attempt: the dispatcher
  // no-ops unless the work is still READY.
  for (const workId of owed) {
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.dispatchAuthorityWorkItem, {
      workId,
    });
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

  const now = Date.now();
  return await ctx.db.insert("commitmentAuthorityWork", {
    orgId: p.orgId,
    workKey,
    status: "READY" as const,
    sourceKind: source.kind,
    depositId: source.depositId,
    vehicleId: source.vehicleId,
    saleId: source.saleId,
    ...(source.holdId ? { holdId: source.holdId } : {}),
    pendingEventId: p._id,
    executions: 0,
    generation: 0,
    // Due immediately. The cron picks it up if the latency schedule above does
    // not, and neither can spend more than one execution.
    nextActionAt: now,
    createdAt: now,
  });
}

/**
 * How many ACTUAL settlement executions one source episode gets before it
 * stops being a retry and becomes a repair condition a person must look at.
 *
 * ⚠️ EXECUTIONS, NOT DELIVERIES (SCRUM-208 c15825). The predecessor counted
 * every offer to begin work, so anything that re-offered an owed item spent
 * budget whether or not a settlement ever ran — and the row could then report
 * "repeated attempts" for failures that never happened.
 */
const MAX_AUTHORITY_EXECUTIONS = 5;

/**
 * How long to wait before asking the scheduler what became of an execution.
 *
 * Long enough that the ordinary case has already terminalized the work and the
 * observation is a cheap no-op; short enough that a genuinely failed execution
 * is retried while the scheduled-function record still exists to be read.
 */
const AUTHORITY_OBSERVE_DELAY_MS = 30_000;

/**
 * Backoff before the next execution, by generation. Bounded and short — this
 * is a repair queue, not a delivery pipeline, and a car whose authority is
 * unresolved is a car a salesperson may be about to promise twice.
 */
const AUTHORITY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

function authorityBackoffFor(generation: number): number {
  const i = Math.min(Math.max(generation - 1, 0), AUTHORITY_BACKOFF_MS.length - 1);
  return AUTHORITY_BACKOFF_MS[i]!;
}

/**
 * Terminalize one work item as a repair condition, and let the accounting row
 * reflect it.
 *
 * ⚠️ BLOCKED IS TERMINAL AND VISIBLE, NEVER A SILENT GIVE-UP. The accounting
 * stays complete; the car keeps whatever authority it has; a person is told
 * this one needs them.
 */
async function blockAuthorityWork(
  ctx: MutationCtx,
  work: Doc<"commitmentAuthorityWork">,
  outcome:
    | "ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED"
    | "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT",
  detail: string
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(work._id, {
    status: "BLOCKED" as const,
    outcome,
    outcomeAt: now,
    outcomeDetail: detail,
    settledAt: now,
    activeAttemptId: undefined,
    nextActionAt: now,
  });
  await summariseAuthorityOnEvent(ctx, work);
}

/**
 * SCRUM-208 c15825 — THE CRON DISPATCHER. Retry liveness independent of
 * accounting traffic.
 *
 * ⚠️ THIS REPLACES A SWEEP THAT RODE THE ACCOUNTING DRAIN. That sweep fired
 * when an organization's drain finished, which had two defects. It could offer
 * a second begin for work whose settlement was still outstanding — the
 * duplicate delivery that spent budget — and, stated honestly at the time but
 * never fixed, an organization that never drained again never retried at all.
 *
 * ⚠️ IT SELECTS AND SCHEDULES; IT DOES NO PER-ROW WORK. A cron has no tenant,
 * so this reads a global index — and a throwing call inside a global batch is
 * a cross-tenant outage: one corrupt row would roll back every other
 * dealership's dispatch in the same transaction and do so again on every tick.
 * Each row's real work therefore runs in its own mutation, deriving `orgId`
 * from the row it loaded.
 *
 * ⚠️ NOT A DISCOVERY SURFACE. It reads `commitmentAuthorityWork` and nothing
 * else. No historical `pendingAccountingEvents` row is inspected or inferred
 * from; a POSTED row with no work item is legacy and fails closed. SCRUM-201
 * owns any live backlog reconciliation, and this is not it.
 */
export const dispatchDueAuthorityWork = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(args.limit ?? 50, 200);

    // `take`, not `paginate`: Convex permits one paginated query per function,
    // and this reads two ranges. Both are bounded and both are exact.
    const due = await ctx.db
      .query("commitmentAuthorityWork")
      .withIndex("by_status_next_action", (q) =>
        q.eq("status", "READY").lte("nextActionAt", now)
      )
      .take(limit);

    const outstanding = await ctx.db
      .query("commitmentAuthorityWork")
      .withIndex("by_status_next_action", (q) =>
        q.eq("status", "DISPATCHED").lte("nextActionAt", now)
      )
      .take(limit);

    for (const work of due) {
      await ctx.scheduler.runAfter(0, internal.accountingOutbox.dispatchAuthorityWorkItem, {
        workId: work._id,
      });
    }
    for (const work of outstanding) {
      await ctx.scheduler.runAfter(0, internal.accountingOutbox.observeAuthorityAttempt, {
        workId: work._id,
      });
    }

    return { dispatched: due.length, observed: outstanding.length };
  },
});

/**
 * SCRUM-208 c15825 — CLAIM THE WORK AND MINT ONE EXECUTION, ATOMICALLY.
 *
 * ⚠️ THE `READY` CHECK IS THE MUTUAL EXCLUSION, AND IT IS THE WHOLE FIX. The
 * predecessor guarded on "is this still owed", which is true both before an
 * execution and during one — so a duplicate delivery spent a second unit of
 * budget for a settlement that had not failed. Moving the work to `DISPATCHED`
 * in the same transaction that mints the attempt makes the claim durable: a
 * concurrent or repeated dispatcher reads `DISPATCHED` and does nothing.
 *
 * ⚠️ AND THIS TRANSACTION MUST COMMIT BEFORE THE SETTLEMENT ONE BEGINS. The
 * settlement rolls back completely when it fails — that is the point of the
 * split — and a rollback would take the execution count and the attempt row
 * with it. Bounded retry and genuine rollback cannot share a transaction.
 */
export const dispatchAuthorityWorkItem = internalMutation({
  args: { workId: v.id("commitmentAuthorityWork") },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    // Terminal, vanished, already claimed, or not yet due. This one line is
    // the at-most-once guard for a duplicate schedule, a re-drained accounting
    // row, and the cron racing the latency schedule.
    if (!work || work.status !== "READY") return { dispatched: false as const };
    if (work.nextActionAt > Date.now()) return { dispatched: false as const };

    if (work.executions >= MAX_AUTHORITY_EXECUTIONS) {
      await blockAuthorityWork(
        ctx,
        work,
        "ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED",
        "this vehicle's authority could not be settled after repeated attempts, so a person must review it"
      );
      return { dispatched: false as const };
    }

    const now = Date.now();
    const generation = work.generation + 1;

    // ⚠️ INSERT, SCHEDULE, THEN BACK-FILL — ONE TRANSACTION. The attempt row
    // must exist before `runAfter` can carry its id, and `runAfter` is what
    // returns the scheduled-function id the observer will read. Both halves
    // commit together or neither does.
    const attemptId = await ctx.db.insert("commitmentAuthorityAttempt", {
      orgId: work.orgId,
      workId: work._id,
      generation,
      attemptKey: `${String(work._id)}:${generation}`,
      status: "SCHEDULED" as const,
      createdAt: now,
    });

    const scheduledFunctionId = await ctx.scheduler.runAfter(
      0,
      internal.accountingOutbox.performAuthoritySettlement,
      { workId: work._id, attemptId, generation }
    );
    await ctx.db.patch(attemptId, { scheduledFunctionId });

    await ctx.db.patch(work._id, {
      status: "DISPATCHED" as const,
      generation,
      activeAttemptId: attemptId,
      executions: work.executions + 1,
      lastAttemptAt: now,
      nextActionAt: now + AUTHORITY_OBSERVE_DELAY_MS,
    });

    return { dispatched: true as const, attemptId, generation };
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
  args: {
    workId: v.id("commitmentAuthorityWork"),
    attemptId: v.id("commitmentAuthorityAttempt"),
    generation: v.number(),
  },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (!work || work.status !== "DISPATCHED") return;

    // ⚠️ ONLY THE ACTIVE ATTEMPT MAY WRITE AUTHORITY (SCRUM-208 c15825).
    //
    // A stale execution is not hypothetical: the observer moves work back to
    // READY when it believes an execution failed, and the work is then
    // re-dispatched under a new generation. If the older execution were still
    // to arrive — a delayed run, a duplicate delivery — it would settle from a
    // decision taken against state that has since moved. Two generations must
    // never both be able to mint a successor root for one source episode.
    //
    // Returning rather than throwing: a superseded execution is ordinary
    // history, not a failure, and throwing would mark the scheduled function
    // failed and feed a retry that has already happened.
    if (String(work.activeAttemptId) !== String(args.attemptId)) return;
    if (work.generation !== args.generation) return;

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
    const now = Date.now();
    // The execution reached a typed answer, so it succeeded as an EXECUTION —
    // including when that answer is "these records need a person". A blocked
    // business outcome is a successful settlement of a bad situation, and
    // counting it as a failed execution would spend a technical retry on
    // something no retry can change.
    await ctx.db.patch(args.attemptId, { status: "SUCCEEDED" as const, observedAt: now });

    if (!settled) {
      await ctx.db.patch(work._id, {
        status: "SETTLED" as const,
        settledAt: now,
        activeAttemptId: undefined,
        nextActionAt: now,
      });
      return;
    }

    await ctx.db.patch(work._id, {
      status: "SETTLED" as const,
      outcome: settled.outcome,
      outcomeAt: now,
      ...(authorityOutcomeDetail(settled) !== undefined
        ? { outcomeDetail: authorityOutcomeDetail(settled)! }
        : {}),
      settledAt: now,
      activeAttemptId: undefined,
      nextActionAt: now,
    });
    await summariseAuthorityOnEvent(ctx, work);
  },
});

/**
 * SCRUM-208 c15825 — WHAT ACTUALLY BECAME OF ONE EXECUTION.
 *
 * ⚠️ THIS EXISTS BECAUSE A ROLLED-BACK SETTLEMENT DESTROYS ITS OWN EVIDENCE.
 * Tx C has no catch, by design — so when it fails, every write it made is
 * undone and nothing inside it survives to say so. The durable attempt row
 * committed BEFORE the execution, and Convex's own `_scheduled_functions`
 * document records how that exact execution ended. Reading them together is
 * the only way the system can tell "failed and should retry" from "still
 * running" without guessing.
 *
 * ⚠️ THE SCHEDULER IS A TRANSPORT OBSERVATION, NEVER BUSINESS TRUTH. It
 * answers what happened to one execution. It does not decide an authority
 * outcome, and its raw error text is server-logged rather than persisted: the
 * work row's detail reaches every VIEW_FINANCE user through the accounting
 * surfaces, and a backend stack trace does not belong in front of a
 * dealership.
 *
 * ⚠️ A MISSING SCHEDULED-FUNCTION DOCUMENT IS NEVER SUCCESS. Convex retains
 * completed results for a bounded window. Past it, the honest reading is
 * "unobservable" — so the work retries, which is safe because settlement is
 * keyed on an exact source episode and a repeat finds the work already done.
 * Reading absence as success would silently abandon a car's authority.
 */
export const observeAuthorityAttempt = internalMutation({
  args: { workId: v.id("commitmentAuthorityWork") },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (!work || work.status !== "DISPATCHED") return { transition: "NONE" as const };

    // ⚠️ NO DUE-TIME GATE HERE ON PURPOSE. The cron owns due selection; this
    // function answers "what happened to the outstanding execution" whenever it
    // is asked. Observing early is harmless — it reads `pending` and asks again
    // — whereas a second dueness check would only make the one branch that
    // matters unreachable to anything but a clock.
    const attempt = work.activeAttemptId ? await ctx.db.get(work.activeAttemptId) : null;
    if (!attempt || attempt.status !== "SCHEDULED") {
      // The work says an execution is outstanding and the attempt does not.
      // Retry rather than invent a reading of it; the claim is released so the
      // dispatcher can mint a fresh generation.
      console.error("[authority-observe] dispatched work has no live attempt", {
        workId: String(work._id),
        activeAttemptId: work.activeAttemptId ? String(work.activeAttemptId) : null,
      });
      return await releaseForRetry(ctx, work, "the previous settlement could not be accounted for");
    }

    const scheduled = attempt.scheduledFunctionId
      ? await ctx.db.system.get(attempt.scheduledFunctionId)
      : null;

    // Still running, or not started. Look again later; spend nothing.
    if (scheduled && (scheduled.state.kind === "pending" || scheduled.state.kind === "inProgress")) {
      await ctx.db.patch(work._id, {
        nextActionAt: Date.now() + AUTHORITY_OBSERVE_DELAY_MS,
      });
      return { transition: "OBSERVE_AGAIN" as const };
    }

    // ⚠️ A SUCCEEDED EXECUTION THAT LEFT THE WORK CLAIMED IS AN INVARIANT
    // VIOLATION, AND IT FAILS VISIBLE. Tx C either terminalizes this work or
    // returns without writing because it was superseded — and a superseded
    // execution cannot be the active attempt, which is the branch above. So
    // there is no legitimate path to here. Recording an outcome would paper
    // over a state machine that has stopped being true.
    if (scheduled && scheduled.state.kind === "success") {
      throw new Error(
        `[authority-observe] settlement reported success but work ${String(work._id)} is still DISPATCHED`
      );
    }

    if (scheduled && scheduled.state.kind === "failed") {
      // Server log only. `state.error` is a backend stack trace.
      console.error("[authority-observe] settlement execution failed", {
        workId: String(work._id),
        generation: attempt.generation,
        error: scheduled.state.error,
      });
    }

    const attemptStatus =
      scheduled && scheduled.state.kind === "canceled" ? ("CANCELED" as const) : ("FAILED" as const);
    await ctx.db.patch(attempt._id, {
      status: attemptStatus,
      observedAt: Date.now(),
      detail: scheduled
        ? "this settlement attempt did not complete"
        : "this settlement attempt could not be observed",
    });

    if (work.executions >= MAX_AUTHORITY_EXECUTIONS) {
      await blockAuthorityWork(
        ctx,
        work,
        "ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED",
        "this vehicle's authority could not be settled after repeated attempts, so a person must review it"
      );
      return { transition: "BLOCKED" as const };
    }

    return await releaseForRetry(ctx, work, "the previous settlement attempt did not complete");
  },
});

/**
 * Give the claim back so a fresh generation can be minted, after a bounded
 * wait. The execution count is NOT rolled back — it counts what really ran.
 */
async function releaseForRetry(
  ctx: MutationCtx,
  work: Doc<"commitmentAuthorityWork">,
  _reason: string
): Promise<{ transition: "RETRY" }> {
  await ctx.db.patch(work._id, {
    status: "READY" as const,
    activeAttemptId: undefined,
    nextActionAt: Date.now() + authorityBackoffFor(work.generation),
  });
  return { transition: "RETRY" as const };
}

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
 * ⚠️ THE WORST-OF LOOP IS A FORWARD GUARD, NOT A PRODUCTION-EXERCISED PATH,
 * AND I PUBLISHED IT AS THE OPPOSITE (SCRUM-208 c15825). `completeDeferredReversal`
 * returns AT MOST ONE source per accounting event today — the SLICE branch
 * returns immediately and the DIRECT branch pushes one — so no production
 * event mints sibling work rows, and the multi-row topology I offered as proof
 * of isolation was one only the test helpers can build. The loop stays because
 * the day an event frees two cars, a clean restoration must not bury a car
 * that needs a person; it is not evidence that that day has come.
 *
 * Siblings are found by the stored relationship rather than by a string-prefix
 * range over `workKey`. The prefix range was correct in practice and one
 * idempotency key that is a prefix of another away from summarising a
 * different accounting row's work.
 */
async function summariseAuthorityOnEvent(
  ctx: MutationCtx,
  work: Doc<"commitmentAuthorityWork">
): Promise<void> {
  const event = await ctx.db.get(work.pendingEventId);
  if (!event) return;

  const siblings = await ctx.db
    .query("commitmentAuthorityWork")
    .withIndex("by_org_pending_event", (q) =>
      q.eq("orgId", work.orgId).eq("pendingEventId", event._id)
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

// ⚠️ `sweepAuthorityWork` WAS HERE, AND IT IS NOT COMING BACK.
//
// It re-offered an organization's owed work when that organization's accounting
// drain finished. Two defects, one of which I disclosed at the time and treated
// the disclosure as a mitigation (SCRUM-208 c15825):
//
//  - It offered work that was still `PENDING` *because a settlement was
//    outstanding*, spending a second unit of a budget meant to count real
//    failures. The old state machine could not tell "owed" from "executing".
//  - An organization that never drained again never retried. Saying so plainly
//    in a comment did not make it safe; it was half of the accepted HIGH.
//
// Retry liveness is now `dispatchDueAuthorityWork`, a static cron over
// `nextActionAt` that no accounting traffic can starve, and the claim that
// makes duplicate dispatch a no-op is the `DISPATCHED` status itself.
//
// If a future change re-attaches authority retry to the drain, that is this
// defect returning.

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

    // ⚠️ THE SAME PRE-WRITE CONTRADICTION CHECK THE DIRECT PATH GETS
    // (SCRUM-208 c15825). This branch used to go straight to settlement, while
    // DIRECT reached `probeCanonicalHold` inside `restoreAuthorityAfterReversal`.
    // So a canonical contradiction on a SLICE escaped as a throw out of
    // `releaseRootIfNoLiveBasis`, rolled the settlement back, spent a technical
    // retry, and eventually surfaced as "could not be settled after repeated
    // attempts" — which names nothing the repairer can act on, and buried the
    // one curated sentence that did.
    //
    // A known contradiction is an EXPECTED terminal answer for both
    // representations: it terminalizes on the first execution, keeps its
    // diagnosis, writes no authority, and never enters the retry channel.
    // ⚠️ `READY` IS NOT `CANONICAL`, AND THAT MISREADING WAS A DEFECT OF ITS
    // OWN (SCRUM-208 c15825, found by Codex against 3882014ae).
    //
    // `tryDecisionContext` answers `READY` whenever authority could be
    // RESOLVED — which includes a LEGACY organization, the majority case until
    // SCRUM-201's cutover. The canonical readers then refuse a non-V1 decision
    // by THROWING (`requireCanonicalAuthority`), and `probeCanonicalHold`
    // persists a curated `ConvexError` verbatim as a data contradiction. So
    // gating on `kind === "READY"` alone recorded "this dealership is not on
    // the canonical authority" as "this dealership's records contradict each
    // other" — terminally, in the field a VIEW_FINANCE user reads. The two are
    // not interchangeable: one says the records were never examined.
    //
    // ⚠️ AND THE GATE IS `V1`, NOT A REDIRECT TO WITHHELD. Returning WITHHELD
    // here would ALSO change what a legacy slice does — today it settles
    // through the legacy liveness readers inside `settleAuthorityAfterReversal`
    // and reaches a real business answer. Restoring the audit label while
    // silently dropping that settlement would be half a fix, and which of the
    // two legacy policies is correct is a product decision, not something a
    // repair for this defect gets to make. Non-V1 therefore falls through
    // BYTE-IDENTICALLY to its previous behaviour; only V1 enters the probe,
    // which is the only version whose readers can produce a contradiction.
    if (context.kind === "READY" && context.decision.authorityVersion === "V1") {
      const probe = await probeCanonicalHold(ctx, context.decision, hold.vehicleId);
      if (!probe.ok) {
        return {
          outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT",
          detail: probe.reason,
        };
      }
    }

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

  // ⚠️ NO AUTHORITY SWEEP RIDES THIS DRAIN ANY MORE (SCRUM-208 c15825).
  //
  // A finished drain used to re-offer the organization's owed authority work.
  // It spent retry budget on settlements that had not failed, and it left any
  // organization that stopped draining with no retry at all. Authority retry is
  // now `dispatchDueAuthorityWork`, a static cron over `nextActionAt`, which
  // accounting traffic can neither drive nor starve. Accounting completion
  // still schedules the FIRST dispatch for latency — see `markEntryPosted` —
  // but nothing here is load-bearing for retry.
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
