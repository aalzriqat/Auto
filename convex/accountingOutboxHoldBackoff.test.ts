/**
 * SCRUM-807 — a row HELD for a missing/unopened accounting period is parked
 * until that blocker changes. It is never re-claimed periodically.
 *
 * The one-minute `dispatch-outbox-work` cron re-selects any PENDING row whose
 * `nextActionAt` has passed, and a hold used to push that out by a flat 60s: a
 * claim mutation plus a worker mutation per held row per minute, for ever, with
 * no attempt burned to stop it.
 *
 * A period hold now marks the row `dispatchState: "PERIOD_HELD"` in the SAME
 * transaction that read the period (`postOutboxRow`), which neither of the
 * cron's index ranges matches. Opening, creating-open or reopening a period
 * releases the rows it covers through `wakePeriodHeldRows`, scheduled from the
 * period mutation itself. Convex guarantees that a function scheduled by a
 * mutation is scheduled iff the mutation commits, that a scheduled mutation runs
 * exactly once and that internal errors are retried
 * (https://docs.convex.dev/scheduling/scheduled-functions), and each wake page
 * schedules the next from its own mutation. So no custom wake table or cron is
 * needed; a manual `redrive` is the recovery for developer error or a cancelled
 * scheduled function.
 *
 * `convex-test` serializes mutations and has no OCC, so the hold/open race is
 * NOT proved here; it rests on the platform's serializable transactions.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { observeClaimed } from "../test-utils/outboxWork";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const MINUTE = 60_000;

// Date IS faked here (unlike the sweep tests) because the subject is elapsed
// time. Fake timers start at the real current time, so the calendar year used to
// build periods is still the real one.
const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

afterEach(() => {
  vi.useRealTimers();
});

type Harness = ReturnType<typeof convexTestWithComponents>;

async function seed(suffix: string, existing?: Harness) {
  // Pass `existing` to seed a SECOND organization in the same database.
  const t: Harness = existing ?? convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Hold ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `hb_${suffix}`, email: `${suffix}@hb.com`, name: "Owner" })
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
  const asAdmin = t.withIdentity({ subject: `hb_${suffix}`, clerkId: `hb_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });
  return { t, orgId, userId, asAdmin };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = any;

async function queueExpense(t: T, orgId: T, userId: T, accountingDate: number, seq: number) {
  return await t.run(async (ctx: T) =>
    ctx.db.insert("pendingAccountingEvents", {
      orgId, kind: "POST", status: "PENDING",
      idempotencyKey: `expense_posted_hb_${seq}`,
      accountingDate, actorId: userId, attempts: 0, createdAt: Date.now() + seq,
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: `hb_${seq}`,
      eventVersion: 1, occurredAt: accountingDate, currency: "USD",
      payload: { expenseId: `hb_${seq}`, amountMinor: 1000, currency: "USD", category: "OTHER" },
    })
  );
}

async function pump(t: T) {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (
      await t.run(async (ctx: T) => await ctx.db.system.query("_scheduled_functions").collect())
    ).filter((f: T) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
    if (queued === 0) break;
  }
}

/** One cron tick: dispatch whatever is due, then let the scheduler settle. */
async function cronTick(t: T) {
  await t.mutation(internal.accountingOutbox.dispatchDueOutboxWork, {});
  await pump(t);
}

/** Hold the row for its missing period, then park through a few quiet ticks. */
async function holdRow(t: T, rowId: T) {
  await cronTick(t);
  expect((await getRow(t, rowId)).dispatchState).toBe("PERIOD_HELD");
}

const getRow = (t: T, id: T) => t.run(async (ctx: T) => ctx.db.get(id));
const eventCount = (t: T, orgId: T) =>
  t.run(async (ctx: T) =>
    (await ctx.db.query("accountingEvents").collect()).filter(
      (e: T) => String(e.orgId) === String(orgId)
    ).length
  );
/** Scheduled functions ever created for one function name, in any state. */
const scheduledNamed = (t: T, name: string) =>
  t.run(async (ctx: T) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: T) =>
      String(f.name).includes(name)
    )
  );

const year = () => new Date().getUTCFullYear();
const inYear = (month: number, day: number) => Date.UTC(year(), month, day);
const yearBounds = () => ({
  startDate: Date.UTC(year(), 0, 1),
  endDate: Date.UTC(year(), 11, 31, 23, 59, 59, 999),
});
const insertPeriod = (t: T, orgId: T, userId: T, status: "OPEN" | "CLOSED" | "FUTURE") =>
  t.run(async (ctx: T) =>
    ctx.db.insert("accountingPeriods", {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, status,
      createdAt: Date.now(), createdBy: userId, snapshotFastPathEligible: true,
    })
  );

describe("a held row is parked, not re-claimed", () => {
  test("two hours of cron ticks claim a period-held row exactly once", async () => {
    const { t, orgId, userId } = await seed("quiet");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), 1);

    for (let minute = 0; minute < 120; minute += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + MINUTE);
    }

    const row = await getRow(t, rowId);
    // `generation` is minted once per claim, so it counts worker runs.
    expect(row.generation).toBe(1);
    expect(row.status).toBe("PENDING");
    // A hold is not a failure: no attempt burned, reason stays visible.
    expect(row.attempts).toBe(0);
    expect(row.lastError).toMatch(/Waiting to post/);
    expect(row.holdKind).toBe("PERIOD");
    expect(row.dispatchState).toBe("PERIOD_HELD");
    // One worker run. At most two claims were ever scheduled — both at the first tick (the
    // cron's and the org drain that `chartOfAccounts.initialize` left queued) — and the
    // count must not grow with the 120 ticks.
    expect((await scheduledNamed(t, "postOutboxRow")).length).toBe(1);
    expect((await scheduledNamed(t, "claimOutboxRow")).length).toBeLessThanOrEqual(2);
  });

  test("the due selector does not return a period-held row, whatever the time", async () => {
    const { t, orgId, userId } = await seed("select");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), 1);
    await holdRow(t, rowId);

    const far = Date.now() + 365 * 24 * 60 * MINUTE;
    const due = await t.query(internal.accountingOutbox.selectDueOutboxWork, { now: far, limit: 200 });
    expect(due.unclaimed).toEqual([]);
    expect(due.awaitingObservation).toEqual([]);
  });

  test("60 held rows (more than a tick's limit) neither burn attempts nor starve a postable row", async () => {
    const { t, orgId, userId, asAdmin } = await seed("starve");
    vi.useFakeTimers({ toFake: [...FAKE] });
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    await pump(t);
    const held = [];
    for (let i = 0; i < 60; i += 1) {
      held.push(await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), i));
    }
    await cronTick(t); // the default tick limit is 50: the rest wait for the next tick
    await cronTick(t);
    for (const id of held) expect((await getRow(t, id)).dispatchState).toBe("PERIOD_HELD");

    const good = await queueExpense(t, orgId, userId, inYear(5, 10), 100);
    await cronTick(t);
    expect((await getRow(t, good)).status).toBe("POSTED");

    for (let minute = 0; minute < 10; minute += 1) {
      vi.setSystemTime(Date.now() + MINUTE);
      await cronTick(t);
    }
    for (const id of held) {
      const row = await getRow(t, id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.generation).toBe(1); // claimed once to be classified, never again
    }
  });

  test("a legacy unmarked held row is classified once and then goes quiet", async () => {
    const { t, orgId, userId } = await seed("legacy");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    // Exactly what a pre-change hold left behind: no marker, a short due time.
    await t.run(async (ctx: T) =>
      ctx.db.patch(rowId, { lastError: "Waiting to post: old.", nextActionAt: Date.now() + MINUTE })
    );
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    for (let i = 0; i < 5; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + MINUTE);
    }
    const row = await getRow(t, rowId);
    expect(row.dispatchState).toBe("PERIOD_HELD");
    expect(row.generation).toBe(1);
  });

  test("a legacy unmarked row whose period is already open simply posts", async () => {
    const { t, orgId, userId } = await seed("legacyopen");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await t.run(async (ctx: T) =>
      ctx.db.patch(rowId, { lastError: "Waiting to post: old.", nextActionAt: Date.now() + MINUTE })
    );
    await insertPeriod(t, orgId, userId, "OPEN");
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await cronTick(t);
    expect((await getRow(t, rowId)).status).toBe("POSTED");
  });
});

describe("a period becoming available wakes exactly the rows it covers", () => {
  test("opening a FUTURE period posts a long-parked held row without any cron tick", async () => {
    const { t, orgId, userId, asAdmin } = await seed("open");
    vi.useFakeTimers({ toFake: [...FAKE] });
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1,
    });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);
    vi.setSystemTime(Date.now() + 3 * 24 * 60 * MINUTE);

    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    await pump(t); // the scheduler only — NO cron tick

    const after = await getRow(t, rowId);
    expect(after.status).toBe("POSTED");
    expect(after.holdKind).toBeUndefined();
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("creating a period with openImmediately posts a held row without any cron tick", async () => {
    const { t, orgId, userId, asAdmin } = await seed("create");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    await pump(t);

    expect((await getRow(t, rowId)).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("reopening a period schedules the wake, which releases a held row inside it", async () => {
    const { t, orgId, userId, asAdmin } = await seed("reopen");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const periodId = await insertPeriod(t, orgId, userId, "CLOSED");
    // A held row inside a CLOSED period cannot arise from the worker today (CLOSED is a
    // refusal, not a hold); it is built by hand to prove reopen's wake is wired.
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await t.run(async (ctx: T) =>
      ctx.db.patch(rowId, { dispatchState: "PERIOD_HELD", holdKind: "PERIOD", lastError: "Waiting to post: x." })
    );

    await asAdmin.mutation(api.accountingPeriods.reopen, {
      orgId, periodId, reason: "SCRUM-807 wake wiring",
    });
    expect((await scheduledNamed(t, "wakePeriodHeldRows")).length).toBe(1);
    await pump(t);

    expect((await getRow(t, rowId)).status).toBe("POSTED");
  });

  test("the wake leaves out-of-range rows and another org's in-range row alone", async () => {
    const { t, orgId, userId, asAdmin } = await seed("scope");
    // Same database: only the orgId on the index range keeps this row out.
    const other = await seed("scope2", t);
    vi.useFakeTimers({ toFake: [...FAKE] });
    const outside = await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), 1);
    const otherOrgRow = await queueExpense(t, other.orgId, other.userId, inYear(5, 10), 2);
    await cronTick(t);
    const outsideBefore = await getRow(t, outside);
    const otherBefore = await getRow(t, otherOrgRow);
    expect(outsideBefore.dispatchState).toBe("PERIOD_HELD");
    expect(otherBefore.dispatchState).toBe("PERIOD_HELD");

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    await pump(t);

    for (const [id, before] of [[outside, outsideBefore], [otherOrgRow, otherBefore]] as const) {
      const after = await getRow(t, id);
      expect(after.status).toBe("PENDING");
      expect(after.dispatchState).toBe("PERIOD_HELD");
      expect(after.generation).toBe(before.generation);
    }
  });

  test("a period closed before the claim refuses the row: attempt burned, marker cleared, no journal", async () => {
    const { t, orgId, userId } = await seed("fail");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);

    // The date's period now exists but is CLOSED: a refusal, not a hold. Releasing the
    // row re-proves that; the worker throws and rolls back and the observer — a separate
    // transaction — records the failure.
    await insertPeriod(t, orgId, userId, "CLOSED");
    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, { orgId, ...yearBounds() });
    await pump(t);
    expect(await observeClaimed(t, orgId)).toBe(1);

    const failed = await getRow(t, rowId);
    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toMatch(/did not complete/);
    expect(failed.holdKind).toBeUndefined();
    expect(failed.dispatchState).toBeUndefined();
    expect(await eventCount(t, orgId)).toBe(0);

    // A second wake over the same range must not release a row in failure backoff.
    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, { orgId, ...yearBounds() });
    await pump(t);
    const after = await getRow(t, rowId);
    expect(after.nextActionAt).toBe(failed.nextActionAt);
    expect(after.generation).toBe(failed.generation);
    expect(after.attempts).toBe(1);
  });

  test("a repeated wake racing the cron posts exactly once, with an independently computed journal", async () => {
    const { t, orgId, userId, asAdmin } = await seed("once");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    const range = { orgId, ...yearBounds() };
    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, range);
    await t.mutation(internal.accountingOutbox.dispatchDueOutboxWork, {});
    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, range);
    await pump(t);
    await cronTick(t);

    expect((await getRow(t, rowId)).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);
    const { entries, lines } = await t.run(async (ctx: T) => ({
      entries: (await ctx.db.query("journalEntries").collect()).filter(
        (j: T) => String(j.orgId) === String(orgId)
      ),
      lines: (await ctx.db.query("journalLines").collect()).filter(
        (l: T) => String(l.orgId) === String(orgId)
      ),
    }));
    expect(entries.length).toBe(1);
    // Hand-computed from the fixture, not read back from the posting path: one 1000-minor
    // expense debits and credits exactly 1000 in total, on at least two lines.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.reduce((sum: number, l: T) => sum + l.debitMinor, 0)).toBe(1000);
    expect(lines.reduce((sum: number, l: T) => sum + l.creditMinor, 0)).toBe(1000);
  });

  test("the wake pages through more rows than one page holds, each page scheduling the next", async () => {
    const { t, orgId, userId } = await seed("page");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const ids: T[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(await queueExpense(t, orgId, userId, inYear(5, 10), i));
    }
    await cronTick(t);
    await cronTick(t);
    for (const id of ids) expect((await getRow(t, id)).dispatchState).toBe("PERIOD_HELD");
    // Open the period WITHOUT the mutation's own wake.
    await insertPeriod(t, orgId, userId, "OPEN");

    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, { orgId, ...yearBounds(), limit: 10 });
    // After ONE page only: 10 released, and the next page already exists as a scheduled function
    // created in the same transaction — that persisted schedule is the chain's durability.
    const released = await t.run(async (ctx: T) =>
      (await Promise.all(ids.map((id: T) => ctx.db.get(id)))).filter(
        (r: T) => r.dispatchState !== "PERIOD_HELD"
      ).length
    );
    expect(released).toBe(10);
    const wakes = await scheduledNamed(t, "wakePeriodHeldRows");
    expect(wakes.length).toBe(1);
    expect(wakes[0].args[0].cursor).toEqual(expect.any(String));

    await pump(t);
    for (const id of ids) expect((await getRow(t, id)).status).toBe("POSTED");
  });
});

describe("manual redrive releases parked rows and says so truthfully", () => {
  test("org redrive: a period opened by a path whose wake never ran recovers, scheduled counts the row", async () => {
    const { t, orgId, userId, asAdmin } = await seed("redrive");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);

    // The period opened by some path that never woke the row (a failed or cancelled schedule).
    await insertPeriod(t, orgId, userId, "OPEN");
    const result = await asAdmin.mutation(api.accountingOutbox.redrive, { orgId });

    // The returned counters describe the row that was actually queued, so the
    // existing consumer (which reads `scheduled`) cannot report "nothing".
    expect(result).toEqual({ scheduled: 1, alreadyInFlight: 0, periodHeld: 0 });

    await pump(t);
    expect((await getRow(t, rowId)).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);

    // A second click finds nothing to do and posts nothing twice.
    const again = await asAdmin.mutation(api.accountingOutbox.redrive, { orgId });
    expect(again.scheduled).toBe(0);
    await pump(t);
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("org redrive carries the release across drain pages (55 parked rows, page size 50)", async () => {
    const { t, orgId, userId, asAdmin } = await seed("redrivepages");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const ids: T[] = [];
    for (let i = 0; i < 55; i += 1) ids.push(await queueExpense(t, orgId, userId, inYear(5, 10), i));
    await cronTick(t);
    await cronTick(t);
    for (const id of ids) expect((await getRow(t, id)).dispatchState).toBe("PERIOD_HELD");
    await insertPeriod(t, orgId, userId, "OPEN");

    const result = await asAdmin.mutation(api.accountingOutbox.redrive, { orgId });
    expect(result.scheduled).toBe(50); // the first page; the second is already scheduled
    await pump(t);

    for (const id of ids) expect((await getRow(t, id)).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(55);
  });

  test("a generic org drain (period/chart triggers) still leaves parked rows alone and counts them", async () => {
    const { t, orgId, userId } = await seed("generic");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);
    await insertPeriod(t, orgId, userId, "OPEN");

    const result = await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    expect(result).toEqual({ scheduled: 0, alreadyInFlight: 0, periodHeld: 1 });
    await pump(t);
    const row = await getRow(t, rowId);
    expect(row.status).toBe("PENDING");
    expect(row.dispatchState).toBe("PERIOD_HELD");
  });

  test("prepaid redrive: an OPEN period whose wake never ran recovers the parked source row once", async () => {
    const { t, orgId, userId, asAdmin } = await seed("prepaid");
    vi.useFakeTimers({ toFake: [...FAKE] });
    await t.run(async (ctx: T) => {
      const role = await ctx.db.query("roles").withIndex("by_org", (q: T) => q.eq("orgId", orgId)).first();
      await ctx.db.patch(role._id, {
        permissions: ["view:finance", "manage:finance", "view:expenses", "create:expenses", "manage:expenses"],
      });
    });
    const expenseId = await asAdmin.mutation(api.expenses.create, {
      idempotencyKey: crypto.randomUUID(), orgId, title: "Insurance", amount: 1200,
      date: inYear(5, 10), category: "FEES", status: "PAID", paymentMethod: "CASH",
      isPrepaid: true, amortizationMonths: 12,
    });
    await cronTick(t);
    const schedule = await t.run(async (ctx: T) =>
      ctx.db.query("prepaidExpenseSchedules").first()
    );
    const key = `expense_posted_${expenseId}`;
    const sourceRow = () =>
      t.run(async (ctx: T) =>
        ctx.db.query("pendingAccountingEvents")
          .withIndex("by_org_idempotency", (q: T) => q.eq("orgId", orgId).eq("idempotencyKey", key))
          .unique()
      );
    expect((await sourceRow()).dispatchState).toBe("PERIOD_HELD");

    await insertPeriod(t, orgId, userId, "OPEN"); // opened with no wake
    const result = await asAdmin.mutation(api.prepaidExpenses.redriveScheduleEvents, {
      orgId, scheduleId: schedule._id,
    });
    expect(result).toEqual({ revived: 0, scheduled: 1, alreadyInFlight: 0 });

    await pump(t);
    expect((await sourceRow()).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("redrive with the period still missing re-parks the row without burning an attempt", async () => {
    const { t, orgId, userId, asAdmin } = await seed("redrivenone");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await holdRow(t, rowId);

    await asAdmin.mutation(api.accountingOutbox.redrive, { orgId });
    await pump(t);

    const row = await getRow(t, rowId);
    expect(row.status).toBe("PENDING");
    expect(row.dispatchState).toBe("PERIOD_HELD");
    expect(row.attempts).toBe(0);
  });
});
