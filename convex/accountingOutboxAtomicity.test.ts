/**
 * SCRUM-222 — RED evidence for outbox posting atomicity.
 *
 * `accountingOutbox.drainEntries` wraps each row's financial writes in a per-row
 * `try`/`catch` (`accountingOutbox.ts:1163-1176`). Convex has no block-scoped
 * rollback: an UNCAUGHT throw undoes every write in the mutation, a CAUGHT one
 * undoes nothing. So a throw AFTER the accounting event, journal entry and some
 * journal lines are written is absorbed, the mutation returns normally, and the
 * partial GL COMMITS. The repository documents this against itself at
 * `accountingOutbox.ts:253-266`, and SCRUM-208 already moved the AUTHORITY half
 * out of that catch — the GL half was never moved.
 *
 * ⚠️ THE FAULT IS REAL, NOT MOCKED. `incrementAccountSnapshot`
 * (`accounting/accountSnapshots.ts:48-58`) reads its shard row with `.unique()`,
 * which throws when more than one row matches. Seeding duplicate snapshot rows
 * across all 8 shards makes the REAL production posting path throw at a REAL
 * late write, with no test seam and no module mock. A seam that *returns* an
 * error cannot reproduce a transaction defect; only a genuine throw can.
 *
 * The write order that makes this the right fault position
 * (`accounting/postingEngine.ts:198-262`):
 *
 *     insert accountingEvents          (status PENDING)
 *     insert journalEntries            (status POSTED)
 *     patch  journalNumber
 *     for each line:  insert journalLines  ->  incrementAccountSnapshot  <-- throws
 *
 * so the throw lands with the event, the journal and the first line already
 * written.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { drainEntries, enqueuePendingReversal } from "./accountingOutbox";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const SHARD_COUNT = 8; // mirrors accounting/accountSnapshots.ts:24

async function seedOrgWithChart(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Atomicity ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `at_${suffix}`, email: `${suffix}@at.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `at_${suffix}`, clerkId: `at_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });
  return { t, orgId, userId, asAdmin };
}

/** Creates and OPENS a period covering the current calendar year. */
async function openCurrentYearPeriod(asAdmin: any, orgId: any, year: number) {
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return period._id;
}

/**
 * Makes the REAL posting path throw at a REAL late write.
 *
 * `incrementAccountSnapshot` picks a RANDOM shard (0..7) and reads it with
 * `.unique()`. Two rows in EVERY shard of EVERY account means whichever shard
 * the PRNG picks, `.unique()` throws — deterministically, with no mock and no
 * seam. The fault therefore lands inside `postAccountingEvent`, after the event,
 * the journal entry and the first journal line are already written.
 */
async function poisonSnapshots(t: any, orgId: any, periodId: any) {
  await t.run(async (ctx: any) => {
    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();
    for (const account of accounts) {
      for (let shard = 0; shard < SHARD_COUNT; shard++) {
        for (let dup = 0; dup < 2; dup++) {
          await ctx.db.insert("accountBalanceSnapshots", {
            orgId, accountId: account._id, currency: "USD", periodId, shard,
            runningDebitMinor: 0, runningCreditMinor: 0, updatedAt: Date.now(),
          });
        }
      }
    }
    return accounts.length;
  });
}

/**
 * The complete GL footprint for an org — never just the outbox row's status.
 *
 * `unbalancedJournals` is the one that matters financially: a journal entry
 * carrying a debit with no matching credit is an unbalanced books assertion,
 * which is what a fault between two line inserts actually produces.
 */
async function glFootprint(t: any, orgId: any) {
  return await t.run(async (ctx: any) => {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();
    const journals = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();

    let unbalancedJournals = 0;
    for (const journal of journals) {
      const own = lines.filter((l: any) => l.journalEntryId === journal._id);
      const debit = own.reduce((s: number, l: any) => s + l.debitMinor, 0);
      const credit = own.reduce((s: number, l: any) => s + l.creditMinor, 0);
      if (debit !== credit) unbalancedJournals += 1;
    }

    return {
      events: events.length,
      journals: journals.length,
      lines: lines.length,
      unbalancedJournals,
      eventStatuses: events.map((e: any) => e.status),
      journalStatuses: journals.map((j: any) => j.status),
    };
  });
}

/** Queues one EXPENSE_POSTED row — the simplest entry with a real posting rule. */
async function queueExpense(t: any, orgId: any, userId: any, accountingDate: number, key: string) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("pendingAccountingEvents", {
      orgId, kind: "POST", status: "PENDING",
      idempotencyKey: key,
      accountingDate, actorId: userId, attempts: 0, createdAt: Date.now(),
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: key,
      eventVersion: 1, occurredAt: accountingDate, currency: "USD",
      payload: { expenseId: key, amountMinor: 5000, currency: "USD", category: "OTHER" },
    });
  });
}

/** Runs the scheduler chain to a fixed point. */
async function pump(t: any) {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (
      await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())
    ).filter((f: any) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
    if (queued === 0) break;
  }
}

/**
 * Drives EXACTLY ONE attempt per row, all the way to a settled outcome.
 *
 * SCRUM-222 split one transaction into four, so "one drain pass" is now a
 * chain: dispatch schedules a claim, the claim schedules a worker, the worker
 * performs the financial writes, and the OBSERVER — a separate transaction —
 * records what became of it.
 *
 * ⚠️ THE OBSERVER STEP IS NOT OPTIONAL IN A TEST, and forgetting it is a real
 * trap: a worker that throws rolls back completely and writes NOTHING, so
 * without an observation the row's attempt counter never moves and a failing
 * row looks untouched rather than failed. Production runs this from the
 * one-minute cron once `nextActionAt` passes; driving it directly here proves
 * the same path without sleeping a minute.
 *
 * Still deliberately NOT going through `drainPendingAccountingEvents`: chart
 * initialization and period opening each schedule their own drains, so that
 * route makes the number of attempts depend on which of those happened to fire.
 */
async function drainOnce(t: any, orgId: any) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    await t.run(async (ctx: any) => {
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .take(50);
      return await drainEntries(ctx, pending);
    });
    await pump(t);

    // Observe whatever is still claimed — exactly what the cron does once the
    // observation deadline passes.
    const claimed: any[] = await t.run(async (ctx: any) =>
      (await ctx.db.query("pendingAccountingEvents").collect())
        .filter((r: any) => String(r.orgId) === String(orgId) && r.dispatchState === "DISPATCHED")
        .map((r: any) => r._id)
    );
    for (const rowId of claimed) {
      await t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });
    }
    await pump(t);
  } finally {
    vi.useRealTimers();
  }
}

describe("SCRUM-222 — a failed posting must leave NO GL footprint", () => {
  test("[fixture 2] one failed attempt writes no event, journal or line", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("partial");
    const year = new Date().getUTCFullYear();
    const periodId = await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    await poisonSnapshots(t, orgId, periodId);
    await queueExpense(t, orgId, userId, accountingDate, "expense_posted_atomicity_1");

    // The drain absorbs the throw and returns normally — that is the defect.
    await drainOnce(t, orgId);

    const footprint = await glFootprint(t, orgId);
    console.log("[SCRUM-222 RED] footprint after ONE failed attempt:", footprint);

    // I1 — FAILURE means ZERO event/journal/line effect. On `bf5769ed1` the
    // catch commits the event, the journal and the first line instead, leaving
    // a journal entry marked POSTED that carries a debit with no credit.
    expect(footprint).toMatchObject({
      events: 0,
      journals: 0,
      lines: 0,
      unbalancedJournals: 0,
    });

    // ...and the obligation itself must survive, durable and retryable.
    const row = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q: any) =>
          q.eq("orgId", orgId).eq("idempotencyKey", "expense_posted_atomicity_1")
        )
        .first()
    );
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
  });

  test("[SCRUM-224] retrying the same row must not accumulate duplicate journals", async () => {
    // This is Codex's DG-01 reproduced by execution, on protected main, with no
    // SCRUM-222 change applied at all.
    //
    // `postAccountingEvent` short-circuits only on a COMPLETE prior event —
    // `status === "POSTED" && journalEntryId` (`postingEngine.ts:107-118`). The
    // event the previous failed attempt committed is still PENDING, so it does
    // NOT short-circuit: the retry falls through and writes a SECOND event and
    // journal for one economic obligation.
    //
    // The third attempt is where it becomes unrecoverable: two events now share
    // one idempotency key, so the `.unique()` idempotency probe at
    // `postingEngine.ts:100-105` THROWS before any write. The row can no longer
    // post by any path, and burns down to dead-letter carrying orphan journals.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("duplicate");
    const year = new Date().getUTCFullYear();
    const periodId = await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    await poisonSnapshots(t, orgId, periodId);
    await queueExpense(t, orgId, userId, accountingDate, "expense_posted_atomicity_2");

    await drainOnce(t, orgId);
    const afterFirst = await glFootprint(t, orgId);
    await drainOnce(t, orgId);
    const afterSecond = await glFootprint(t, orgId);
    await drainOnce(t, orgId);
    const afterThird = await glFootprint(t, orgId);

    console.log("[SCRUM-222 RED] footprint after attempt 1:", afterFirst);
    console.log("[SCRUM-222 RED] footprint after attempt 2:", afterSecond);
    console.log("[SCRUM-222 RED] footprint after attempt 3:", afterThird);

    // One economic obligation may never produce more than one accounting event,
    // and a failed attempt may never leave an unbalanced journal on the books.
    expect(afterThird).toMatchObject({
      events: 0,
      journals: 0,
      lines: 0,
      unbalancedJournals: 0,
    });
  });
});

/**
 * Posts one EXPENSE_POSTED cleanly and returns its accounting event id.
 *
 * ⚠️ ASSERTS DURABLE STATE, NEVER THE DRAIN'S RETURNED COUNTERS. Chart
 * initialization and period opening each schedule their own drain, so whether
 * this row is posted by the call below or by one of those is a CPU race — the
 * same race `accountingOutboxSweep.test.ts:99-114` documents. The counters say
 * which drain happened to do the work; the row says whether the work is done,
 * and only the second is the property under test. Production's own comment at
 * `accountingOutbox.ts:1169` makes the same distinction.
 */
async function postExpenseCleanly(
  t: any, orgId: any, userId: any, accountingDate: number, key: string
) {
  await queueExpense(t, orgId, userId, accountingDate, key);
  await drainOnce(t, orgId);
  const row = await outboxRow(t, orgId, key);
  expect(row?.status).toBe("POSTED");
  expect(row?.resultEventId).toBeDefined();
  return row!.resultEventId;
}

async function queueReversal(
  t: any, orgId: any, userId: any, originalEventId: any, reversalDate: number, key: string
) {
  await t.run(async (ctx: any) => {
    await enqueuePendingReversal(ctx, {
      orgId, originalEventId, reversalDate,
      reason: "SCRUM-222 fixture", actorId: userId,
      idempotencyKey: key, sourceType: "expenses", sourceId: key,
    });
  });
}

async function outboxRow(t: any, orgId: any, key: string) {
  return await t.run(async (ctx: any) =>
    await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q: any) =>
        q.eq("orgId", orgId).eq("idempotencyKey", key)
      )
      .first()
  );
}

/**
 * The REVERSE half — the one with the wider blast radius.
 *
 * `markEntryPosted:282-292` performs MORE work on the reversal path than on the
 * posting path: `recordAuthorityWork` inserts, and `commitDeferredReversal`
 * flips `depositApplications` to REVERSED. All of it sits inside the same
 * `drainEntries` catch, so fixing POST alone would leave the bigger exposure.
 *
 * The three characterization tests below are GREEN on `bf5769ed1`. They exist
 * because SCRUM-222 must not break them: owner ruling `c17361` made it normative
 * that a REVERSE worker must NOT require the original event to still be POSTED,
 * because `reverseAccountingEvent` deliberately treats an already-REVERSED event
 * with valid linkage as successful idempotent recovery.
 */
describe("SCRUM-222 — REVERSE carries the same defect and its own semantics", () => {
  test("[baseline, GREEN] a deferred reversal posts and links the original", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("revok");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    const originalEventId = await postExpenseCleanly(
      t, orgId, userId, accountingDate, "expense_rev_ok"
    );
    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "reversal_rev_ok");
    await drainOnce(t, orgId);

    const original = await t.run(async (ctx: any) => await ctx.db.get(originalEventId));
    expect(original.status).toBe("REVERSED");
    expect(original.reversedByEventId).toBeDefined();

    const footprint = await glFootprint(t, orgId);
    // Original + reversal, both balanced.
    expect(footprint).toMatchObject({ events: 2, journals: 2, unbalancedJournals: 0 });
    expect((await outboxRow(t, orgId, "reversal_rev_ok"))?.status).toBe("POSTED");
  });

  test("[c17361, GREEN] an already-REVERSED original with valid linkage RECOVERS", async () => {
    // ⚠️ THIS IS THE CASE THE OWNER'S NORMATIVE CLARIFICATION PROTECTS.
    //
    // `reversals.ts:33-45` returns `alreadyReversed: true` when the original is
    // REVERSED and its linked reversal event carries a journal. That is a
    // deliberate SUCCESS path, not a corrupt state. A REVERSE worker that
    // required "the original is still POSTED" as a precondition would reject
    // this row and dead-letter it, stranding the obligation.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("revrec");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    const originalEventId = await postExpenseCleanly(
      t, orgId, userId, accountingDate, "expense_rev_rec"
    );
    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "reversal_rev_rec_1");
    await drainOnce(t, orgId);
    const afterFirst = await glFootprint(t, orgId);

    // A second queued reversal for the SAME original, under a different key —
    // the shape a redelivered or re-enqueued deferred reversal actually takes.
    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "reversal_rev_rec_2");
    await drainOnce(t, orgId);

    // It must COMPLETE, not fail, and must not write a second reversal journal.
    expect((await outboxRow(t, orgId, "reversal_rev_rec_2"))?.status).toBe("POSTED");
    expect(await glFootprint(t, orgId)).toMatchObject({
      events: afterFirst.events,
      journals: afterFirst.journals,
      lines: afterFirst.lines,
      unbalancedJournals: 0,
    });
  });

  test("[GREEN] a REVERSED original with BROKEN linkage fails closed", async () => {
    // The mirror of the case above: REVERSED with no usable reversal journal is
    // NOT recoverable, and `reversals.ts:44` throws rather than inventing one.
    // SCRUM-222 must preserve this: the distinction between the two is exactly
    // what SCRUM-224's audit has to classify on legacy rows.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("revbroken");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    const originalEventId = await postExpenseCleanly(
      t, orgId, userId, accountingDate, "expense_rev_broken"
    );
    const before = await glFootprint(t, orgId);

    // REVERSED, but nothing links to a reversal journal — a dangling footprint.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(originalEventId, { status: "REVERSED" });
    });

    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "reversal_rev_broken");
    await drainOnce(t, orgId);

    // Fails closed: the row survives, and nothing was written to the ledger.
    const row = await outboxRow(t, orgId, "reversal_rev_broken");
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    expect(await glFootprint(t, orgId)).toMatchObject({
      events: before.events,
      journals: before.journals,
      lines: before.lines,
    });
  });

  test("[fixture 10, RED] a failed REVERSE must leave no reversal footprint", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("revpartial");
    const year = new Date().getUTCFullYear();
    const periodId = await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    const originalEventId = await postExpenseCleanly(
      t, orgId, userId, accountingDate, "expense_rev_partial"
    );
    const before = await glFootprint(t, orgId);

    // Poison AFTER the original posted, so only the reversal faults.
    await poisonSnapshots(t, orgId, periodId);
    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "reversal_rev_partial");
    await drainOnce(t, orgId);

    const after = await glFootprint(t, orgId);
    console.log("[SCRUM-222 RED] reversal footprint before:", before, "after:", after);

    // I1 on the REVERSE path: a failed reversal writes nothing at all.
    expect(after).toMatchObject({
      events: before.events,
      journals: before.journals,
      lines: before.lines,
      unbalancedJournals: 0,
    });

    // And the original must not be left half-reversed.
    const original = await t.run(async (ctx: any) => await ctx.db.get(originalEventId));
    expect(original.status).toBe("POSTED");
  });
});

/**
 * §5.2 / fixture 19 — the manual retry door, characterized on current code.
 *
 * `retryFailed:1358` patches exactly `{ status: "PENDING", attempts: 0,
 * lastError: undefined }` and returns NOTHING — so today it makes no false
 * "posting completed" claim, and the contract's "report retry queued" is a NEW
 * requirement rather than a current defect. What must not regress is below: a
 * revived row is picked up by the VERY NEXT drain, not merely eventually. Once
 * the design adds claim metadata, a revive that fails to clear it would leave
 * the row reading as claimed and silently skipped — which is why this property
 * is pinned before the metadata exists.
 */
describe("SCRUM-222 §5.2 — a revived row is immediately eligible", () => {
  test("[GREEN] retryFailed makes a dead-lettered row post on the next drain", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("retry");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    // A dead-lettered row that would post perfectly well if it were retried.
    const pendingEventId = await t.run(async (ctx: any) =>
      await ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "FAILED",
        idempotencyKey: "expense_retry_1",
        accountingDate, actorId: userId, attempts: 10, createdAt: Date.now(),
        lastError: "chart of accounts was not initialized",
        eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: "retry_1",
        eventVersion: 1, occurredAt: accountingDate, currency: "USD",
        payload: { expenseId: "retry_1", amountMinor: 5000, currency: "USD", category: "OTHER" },
      })
    );

    await asAdmin.mutation(api.accountingOutbox.retryFailed, { orgId, pendingEventId });

    const revived = await outboxRow(t, orgId, "expense_retry_1");
    expect(revived?.status).toBe("PENDING");
    expect(revived?.attempts).toBe(0);
    expect(revived?.lastError).toBeUndefined();

    // The very next drain must find it — not a later one.
    await drainOnce(t, orgId);
    const settled = await outboxRow(t, orgId, "expense_retry_1");
    expect(settled?.status).toBe("POSTED");
    expect(await glFootprint(t, orgId)).toMatchObject({ unbalancedJournals: 0 });
  });
});

/**
 * SCRUM-222 §3.4 / §5 — THE ROW CAN ALWAYS BE RECOVERED.
 *
 * These cover the two ways a claimed row could be stranded forever, which is
 * the failure mode this design creates and therefore has to close explicitly:
 * an observation that can never conclude, and a sweep that cannot see claimed
 * work at all.
 */
describe("SCRUM-222 — a claimed row is never stranded", () => {
  test("[fixture 18] a MISSING scheduler record is observed failure, not silence", async () => {
    // ⚠️ THIS BRANCH WAS ABSENT FROM AN EARLIER REVISION OF THE DESIGN, and its
    // absence was invisible: §5 says an unknown outcome is re-observed and never
    // re-dispatched, so a lost or expired scheduler record would have been
    // re-observed forever and the row stranded permanently — a queue that looks
    // busy and is dead. The precedent already had it
    // (`observeAuthorityAttempt:707-741`); I under-copied the pattern I cited.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("lostrec");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    await queueExpense(t, orgId, userId, Date.UTC(year, 5, 10), "lost_record");

    const rowId = (await outboxRow(t, orgId, "lost_record"))._id;
    await t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId });

    // The scheduler record is gone — expired, or never recorded.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(rowId, { scheduledFunctionId: undefined });
    });

    const result = await t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });

    expect(result.transition, "an unreadable attempt is a FAILED attempt").toBe("RETRY");
    const row = await outboxRow(t, orgId, "lost_record");
    expect(row.dispatchState, "the claim is released so a fresh generation can run").toBeUndefined();
    expect(row.activeAttemptId).toBeUndefined();
    expect(row.attempts, "and it costs exactly one attempt, so it dead-letters eventually").toBe(1);
    expect(row.nextActionAt, "released with a backoff, not immediately due").toBeGreaterThan(Date.now());
    expect(row.status, "still retryable").toBe("PENDING");
  });

  test("[fixture 16] the due sweep RE-OBSERVES a claimed row rather than re-dispatching it", async () => {
    // If the sweep only ever selected unclaimed rows, a worker that died would
    // leave its row claimed with nobody left to ask about it. And if it
    // re-CLAIMED instead of observing, one obligation could have two live
    // workers — the duplicate-journal risk the generation guard exists for.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("lostobs");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    await queueExpense(t, orgId, userId, Date.UTC(year, 5, 10), "lost_observer");

    const rowId = (await outboxRow(t, orgId, "lost_observer"))._id;
    const claim = await t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId });

    // The observation deadline passes with the worker's fate unknown.
    await t.run(async (ctx: any) => await ctx.db.patch(rowId, { nextActionAt: Date.now() - 1000 }));

    const due = await t.query(internal.accountingOutbox.selectDueOutboxWork, {});
    expect(
      due.awaitingObservation.map((r: any) => r.idempotencyKey),
      "a claimed, overdue row is offered for OBSERVATION"
    ).toEqual(["lost_observer"]);
    expect(
      due.unclaimed.map((r: any) => r.idempotencyKey),
      "and never as fresh work — that would be a second worker on one obligation"
    ).toEqual([]);

    // The sweep itself must not mint a new claim over the live one.
    await t.mutation(internal.accountingOutbox.dispatchDueOutboxWork, {});
    const row = await outboxRow(t, orgId, "lost_observer");
    expect(row.generation, "the sweep did not re-claim").toBe(claim.generation);
    expect(row.activeAttemptId).toBe(claim.attemptId);
  });
});

/**
 * SCRUM-222 GATE 2 — A STALE GENERATION MAY NOT TOUCH ANYTHING.
 *
 * Required by owner ruling `c17365`: given a stale generation N while the row is
 * owned by N+1, N must not post, must not reverse, must not complete or release
 * N+1, and must produce zero accounting delta.
 *
 * ⚠️ THE STALE STATE IS BUILT THROUGH REAL DOORS, NOT FABRICATED. The first
 * claim is issued by `claimOutboxRow`, its scheduled worker is CANCELLED so the
 * real observer sees a genuinely dead execution and releases the claim, and the
 * second claim is issued by the same production dispatcher. So the identities N
 * and N+1 are the ones production actually mints. A test that invented its own
 * attempt id would never exercise the guard — that exact mistake is recorded in
 * `test-utils/authorityWork.ts:12-16`.
 *
 * ⚠️ AND THIS IS THE CASE THAT CANNOT FAIL ON UNPATCHED MAIN, because neither
 * the generation nor the worker exists there. Its value comes from the mutation
 * proof: delete the two guard lines in `postOutboxRow` and this test must fail.
 * That run is recorded in the Stage B evidence rather than left as an assertion
 * about an assertion.
 */
describe("SCRUM-222 — a superseded worker writes nothing", () => {
  async function claimTwice(t: any, orgId: any, key: string) {
    // First claim: generation N.
    const rowId = (await outboxRow(t, orgId, key))._id;
    const first = await t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId });
    expect(first.claimed).toBe(true);

    // Kill its worker for real, so the observer reads a dead execution rather
    // than a state the test fabricated.
    await t.run(async (ctx: any) => {
      const row = await ctx.db.get(rowId);
      await ctx.scheduler.cancel(row.scheduledFunctionId);
    });
    await t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });

    // The observer released the claim with a backoff; move the clock as the
    // one-minute cron would, then let the dispatcher mint generation N+1.
    await t.run(async (ctx: any) => await ctx.db.patch(rowId, { nextActionAt: undefined }));
    const second = await t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId });
    expect(second.claimed).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);

    return { rowId, stale: first, active: second };
  }

  test("[POST] generation N cannot post while N+1 owns the row", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("staleposta");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    await queueExpense(t, orgId, userId, accountingDate, "stale_post");
    const { rowId, stale, active } = await claimTwice(t, orgId, "stale_post");

    const before = await glFootprint(t, orgId);

    // The stale worker arrives late, carrying a perfectly valid-looking
    // identity that is simply no longer the active one.
    const result = await t.mutation(internal.accountingOutbox.postOutboxRow, {
      rowId,
      attemptId: stale.attemptId,
      generation: stale.generation,
    });

    expect(result.outcome, "a superseded execution is history, not a failure").toBe("SUPERSEDED");
    // ZERO ACCOUNTING DELTA.
    expect(await glFootprint(t, orgId)).toEqual(before);

    // ...and it did not complete or release the live attempt either.
    const row = await outboxRow(t, orgId, "stale_post");
    expect(row.status, "N did not terminalize the row").toBe("PENDING");
    expect(row.dispatchState, "N+1 still owns the claim").toBe("DISPATCHED");
    expect(row.activeAttemptId).toBe(active.attemptId);
    expect(row.generation).toBe(active.generation);
  });

  test("[REVERSE] generation N cannot reverse while N+1 owns the row", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("stalerev");
    const year = new Date().getUTCFullYear();
    await openCurrentYearPeriod(asAdmin, orgId, year);
    const accountingDate = Date.UTC(year, 5, 10);

    const originalEventId = await postExpenseCleanly(
      t, orgId, userId, accountingDate, "stale_rev_source"
    );
    await queueReversal(t, orgId, userId, originalEventId, accountingDate, "stale_rev");
    const { rowId, stale, active } = await claimTwice(t, orgId, "stale_rev");

    const before = await glFootprint(t, orgId);

    const result = await t.mutation(internal.accountingOutbox.postOutboxRow, {
      rowId,
      attemptId: stale.attemptId,
      generation: stale.generation,
    });

    expect(result.outcome).toBe("SUPERSEDED");
    // No reversal journal, and the original is untouched — the REVERSE path
    // writes more than POST does (authority work, deposit applications), so a
    // stale reversal is the more expensive mistake.
    expect(await glFootprint(t, orgId)).toEqual(before);
    const original = await t.run(async (ctx: any) => await ctx.db.get(originalEventId));
    expect(original.status, "the original was not reversed by a stale worker").toBe("POSTED");

    const row = await outboxRow(t, orgId, "stale_rev");
    expect(row.dispatchState).toBe("DISPATCHED");
    expect(row.activeAttemptId).toBe(active.attemptId);
    expect(row.generation).toBe(active.generation);
  });
});

/**
 * SCRUM-222 STAGE A — the EXACT selector, run locally before the runtime gate.
 *
 * ⚠️ THIS TESTS A DIFFERENT QUERY FROM THE PROBE BELOW, AND THE DIFFERENCE IS
 * THE WHOLE RISK. The probe below proves `eq(field, undefined)` matches an
 * absent field. The selector additionally does `lte("nextActionAt", now)` on a
 * field that is ABSENT — a RANGE comparison against a missing value, which is a
 * separate platform question that `eq` semantics do not answer. My first pass
 * treated the probe as covering both; it does not.
 *
 * Local agreement here is still not certification: §4.2's real-runtime gate on
 * a non-production deployment is what certifies it, because `convex-test` has
 * documented divergence from the real runtime on exactly this kind of query
 * constraint.
 */
describe("SCRUM-222 §4.2 — the exact due-work selector, locally", () => {
  test("a legacy row with nextActionAt COMPLETELY ABSENT is returned as due", async () => {
    const { t, orgId, userId } = await seedOrgWithChart("duework");
    const accountingDate = Date.UTC(new Date().getUTCFullYear(), 5, 10);
    const now = Date.now();

    // Three genuinely LEGACY-shaped rows: none of the SCRUM-222 fields exist.
    await queueExpense(t, orgId, userId, accountingDate, "due_legacy_1");
    await queueExpense(t, orgId, userId, accountingDate, "due_legacy_2");
    await queueExpense(t, orgId, userId, accountingDate, "due_legacy_3");

    // A claimed row whose observation deadline has passed.
    await queueExpense(t, orgId, userId, accountingDate, "due_claimed");
    // A row deliberately scheduled into the future — must NOT be selected.
    await queueExpense(t, orgId, userId, accountingDate, "due_future");
    await t.run(async (ctx: any) => {
      const claimed = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q: any) =>
          q.eq("orgId", orgId).eq("idempotencyKey", "due_claimed")
        )
        .first();
      await ctx.db.patch(claimed._id, {
        dispatchState: "DISPATCHED", generation: 1,
        activeAttemptId: "attempt-1", nextActionAt: now - 60_000,
      });
      const future = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q: any) =>
          q.eq("orgId", orgId).eq("idempotencyKey", "due_future")
        )
        .first();
      await ctx.db.patch(future._id, { nextActionAt: now + 3_600_000 });
    });

    const due = await t.query(internal.accountingOutbox.selectDueOutboxWork, { now });

    const unclaimedKeys = due.unclaimed.map((r: any) => r.idempotencyKey).sort();
    const observeKeys = due.awaitingObservation.map((r: any) => r.idempotencyKey).sort();

    // THE LOAD-BEARING ASSERTION: rows whose `nextActionAt` is absent are due.
    expect(unclaimedKeys).toEqual(["due_legacy_1", "due_legacy_2", "due_legacy_3"]);
    // ...and they really were legacy-shaped, not stamped by the fixture.
    expect(due.unclaimed.every((r: any) => r.hasNextActionAt === false)).toBe(true);
    expect(due.unclaimed.every((r: any) => r.hasDispatchState === false)).toBe(true);
    // A claimed row is NOT offered as unclaimed work; it is offered for
    // observation instead, so a lost worker cannot strand it (§5).
    expect(observeKeys).toEqual(["due_claimed"]);
    // A future-dated row is excluded from both ranges.
    expect(unclaimedKeys).not.toContain("due_future");
    expect(observeKeys).not.toContain("due_future");
  });

  test("the selector never offers a POSTED or FAILED row", async () => {
    const { t, orgId, userId } = await seedOrgWithChart("duestatus");
    const accountingDate = Date.UTC(new Date().getUTCFullYear(), 5, 10);

    await queueExpense(t, orgId, userId, accountingDate, "due_status_pending");
    await queueExpense(t, orgId, userId, accountingDate, "due_status_posted");
    await queueExpense(t, orgId, userId, accountingDate, "due_status_failed");
    await t.run(async (ctx: any) => {
      for (const [key, status] of [
        ["due_status_posted", "POSTED"],
        ["due_status_failed", "FAILED"],
      ] as const) {
        const row = await ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_idempotency", (q: any) =>
            q.eq("orgId", orgId).eq("idempotencyKey", key)
          )
          .first();
        await ctx.db.patch(row._id, { status });
      }
    });

    const due = await t.query(internal.accountingOutbox.selectDueOutboxWork, {});
    expect(due.unclaimed.map((r: any) => r.idempotencyKey)).toEqual(["due_status_pending"]);
    expect(due.awaitingObservation).toEqual([]);
  });
});

/**
 * §4.2 — the local half of the index question.
 *
 * The design's due-work selector keys on a NEW optional `nextActionAt`, and
 * every pre-SCRUM-222 row will lack that field entirely. If an index scan
 * cannot see rows whose indexed field is ABSENT, "missing `nextActionAt` means
 * immediately due" is false and the whole visible backlog silently becomes
 * invisible — the single highest risk in the design.
 *
 * ⚠️ EVIDENCE BOUNDARY, STATED RATHER THAN GLOSSED. This probes the PLATFORM
 * RULE using `by_org_authority_outcome`, an index that already exists over the
 * already-optional `authorityOutcome` on the very same table. It does NOT
 * certify SCRUM-222's own compound selector, which does not exist yet, and it
 * runs under `convex-test` rather than a real deployment. §4.2's REQUIRED
 * REAL-RUNTIME GATE — the exact selector against a genuinely legacy-shaped row
 * on a real non-production Convex deployment — is what certifies that, and this
 * test does not substitute for it.
 */
/**
 * SCRUM-222 §3.5 — THE FALSIFIER FOR THE CALLEE-DERIVED ENUMERATION.
 *
 * ⚠️ THIS EXISTS BECAUSE I GOT THE ENUMERATION WRONG ONCE. An earlier revision
 * listed the `drainEntries` callers a REVIEW had named and asserted the list was
 * exhaustive; the next round found a fourth — the per-org drain helper, which had no
 * cursor and no pass budget and therefore none of the starvation fixes. The
 * lesson was about the DIRECTION of the search: enumerate from the callee, never
 * from someone else's findings list. A prose claim of exhaustiveness cannot be
 * re-run. This can.
 */
describe("SCRUM-222 §3.5 — the retired drain door stays retired", () => {
  test("[fixture 20] the retired per-org drain helper has no definition and no caller", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // Assembled from parts so this file does not match its own search — which
    // is cheaper and less brittle than special-casing an exclusion path.
    const RETIRED = "drainPending" + "ForOrg";

    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git" || entry === "_generated") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (readFileSync(full, "utf8").includes(RETIRED)) hits.push(full);
      }
    };
    walk(join(repoRoot, "convex"));
    walk(join(repoRoot, "test-utils"));

    expect(hits, `the retired drain helper is still referenced in: ${hits.join(", ")}`).toEqual([]);
  });
});

describe("SCRUM-222 §4.2 — an absent optional field must stay index-visible", () => {
  test("a row with the indexed optional field ABSENT is matched by eq(field, undefined)", async () => {
    const { t, orgId, userId } = await seedOrgWithChart("selector");
    const accountingDate = Date.UTC(new Date().getUTCFullYear(), 5, 10);

    // Two LEGACY-SHAPED rows: the optional indexed field is not merely
    // undefined, it is absent from the document entirely.
    await queueExpense(t, orgId, userId, accountingDate, "selector_legacy_1");
    await queueExpense(t, orgId, userId, accountingDate, "selector_legacy_2");
    // One NEW-SHAPED row that carries the field.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "REVERSE", status: "PENDING",
        idempotencyKey: "selector_new_1",
        accountingDate, actorId: userId, attempts: 0, createdAt: Date.now(),
        sourceType: "expenses", sourceId: "selector_new_1",
        authorityOutcome: "RESTORED",
      });
    });

    const { all, absentOnly } = await t.run(async (ctx: any) => {
      const all = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_authority_outcome", (q: any) => q.eq("orgId", orgId))
        .collect();
      const absentOnly = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_authority_outcome", (q: any) =>
          q.eq("orgId", orgId).eq("authorityOutcome", undefined)
        )
        .collect();
      return { all: all.length, absentOnly: absentOnly.map((r: any) => r.idempotencyKey).sort() };
    });

    // A prefix scan sees every row regardless of the optional field.
    expect(all).toBe(3);
    // ...and constraining the optional component to `undefined` selects exactly
    // the rows where it is ABSENT. If this returns [] the design needs a
    // backfill or a sentinel, which is a §8 non-goal and returns to the owner.
    expect(absentOnly).toEqual(["selector_legacy_1", "selector_legacy_2"]);
  });
});

