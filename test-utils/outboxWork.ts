/**
 * SCRUM-222 — DRIVE GL POSTING THROUGH ITS REAL DOORS.
 *
 * Posting no longer happens inside the drain. `drainEntries` schedules one
 * claim per row; `claimOutboxRow` mints a generation and schedules a worker;
 * `postOutboxRow` performs every financial write in a registered mutation of
 * its own, so an unexpected throw rolls its whole transaction back instead of
 * committing a partial, unbalanced journal; and `observeOutboxAttempt` — a
 * SEPARATE transaction — records what became of it.
 *
 * ⚠️ THE OBSERVER STEP IS NOT OPTIONAL, AND OMITTING IT IS THE TRAP. A worker
 * that throws rolls back completely and therefore writes NOTHING — not even its
 * own failure. Until something observes the attempt, a failing row's counter
 * never moves and the row looks untouched rather than failed. Production runs
 * this from the one-minute `dispatch-outbox-work` cron once `nextActionAt`
 * passes; these helpers drive the same mutation directly so a test need not
 * sleep a minute to see a failure recorded.
 *
 * ⚠️ THESE HELPERS CALL THE REAL MUTATIONS. Nothing here fabricates a claim, a
 * generation or an attempt identity: the values a test settles with are the
 * ones the production dispatcher actually issued. That matters because the
 * generation guard is the thing standing between a stale worker and a duplicate
 * journal, and a helper that invented its own identity would never exercise it.
 *
 * ⚠️ AND THEY DO NOT CATCH. A throw from the worker is a CONTRACT, not an
 * accident — it is what proves the rollback boundary exists. A helper that
 * swallowed it would hide the property these tests are here to check.
 *
 * ⚠️ THE HARNESS CANNOT AUTHORIZE CONCURRENCY. `convex-test` serializes and has
 * no OCC, so nothing here proves that two dispatchers racing in production
 * yield one worker. It proves the state machine's LOGIC — a second dispatch
 * against a claimed row is a no-op. Do not read a green run here as evidence of
 * exclusion under contention.
 */
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";

/**
 * ⚠️ TIMER FUNCTIONS ONLY — NOT `Date`. `convex-test` runs a scheduled function
 * off a real `setTimeout`, and its pump only reaches timers that were faked
 * BEFORE the scheduling mutation ran. Freezing `Date` as well would pin
 * `Date.now()` and move every seeded row out of the window its due-time gate is
 * compared against — and these fixtures build accounting periods from the real
 * calendar year.
 */
const TIMER_FNS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;

/** Runs the scheduler chain to a fixed point. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pump(t: any): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).filter((f: any) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
    if (queued === 0) break;
  }
}

/**
 * Observe every row still holding a claim — exactly what the cron does once the
 * observation deadline passes. Returns how many were observed.
 */
export async function observeClaimed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">
): Promise<number> {
  const claimed: Id<"pendingAccountingEvents">[] = await t.run(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (ctx: any) =>
      (await ctx.db.query("pendingAccountingEvents").collect())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => String(r.orgId) === String(orgId) && r.dispatchState === "DISPATCHED")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r._id)
  );
  for (const rowId of claimed) {
    await t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });
  }
  return claimed.length;
}

/**
 * One full drain: dispatch every due row, run the workers, then observe
 * whatever is still outstanding — the complete cycle, settled.
 *
 * Fake timers go on BEFORE anything is scheduled. Installing them afterwards
 * leaves the chain already running on real timers, which
 * `accountingOutboxSweep.test.ts:99-114` documents as a load-dependent flake
 * that passes alone and fails beside another convex-heavy file.
 */
export async function settleOutbox(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">
): Promise<void> {
  vi.useFakeTimers({ toFake: [...TIMER_FNS] });
  try {
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    await pump(t);
    await observeClaimed(t, orgId);
    await pump(t);
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Rows the worker HELD, identified by DURABLE STATE rather than by a returned
 * counter: still `PENDING`, **zero attempts spent**, and carrying a visible
 * waiting reason.
 *
 * ⚠️ THE ZERO IS THE LOAD-BEARING PART. Held and failed differ precisely in
 * whether an attempt was burned; conflating them is what dead-letters a
 * perfectly valid entry because of somebody else's blocker, after which no
 * drain touches it again and its GL impact silently disappears.
 */
export async function heldRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await t.run(async (ctx: any) =>
    (await ctx.db.query("pendingAccountingEvents").collect()).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) =>
        String(r.orgId) === String(orgId) &&
        r.status === "PENDING" &&
        r.attempts === 0 &&
        typeof r.lastError === "string" &&
        r.lastError.startsWith("Waiting to post:")
    )
  );
}

/**
 * Simulate the passage of time: make every still-PENDING row due again.
 *
 * ⚠️ THIS EXISTS BECAUSE A HOLD IS A BACKOFF, NOT A NO-OP. A held row is pushed
 * out by `OUTBOX_HOLD_DELAY_MS` precisely so it cannot re-select on every tick
 * and starve the rows behind it, which means a second `settleOutbox` in the
 * same test genuinely cannot pick it up — the row is not due yet, and
 * `claimOutboxRow` says so. That is correct production behaviour, so the test
 * must move the clock rather than the code.
 *
 * Only `nextActionAt` is rewritten. Nothing else about the row is touched, so
 * the guards, attempt counters and claim state under test stay exactly as the
 * production path left them.
 */
export async function makeDue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await t.run(async (ctx: any) => {
    const rows = (await ctx.db.query("pendingAccountingEvents").collect()).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => String(r.orgId) === String(orgId) && r.status === "PENDING"
    );
    for (const row of rows) {
      await ctx.db.patch(row._id, { nextActionAt: undefined });
    }
  });
}

/** Every outbox row for one org. */
export async function outboxRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await t.run(async (ctx: any) =>
    (await ctx.db.query("pendingAccountingEvents").collect()).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => String(r.orgId) === String(orgId)
    )
  );
}
