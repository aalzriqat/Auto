/**
 * SCRUM-807 — a row HELD for a missing/unopened accounting period must not be
 * re-claimed and re-run every minute for ever.
 *
 * The one-minute `dispatch-outbox-work` cron re-selects any PENDING row whose
 * `nextActionAt` has passed, and a hold used to push that out by a flat 60s.
 * A row waiting for a period nobody has opened therefore cost a claim mutation
 * plus a worker mutation every minute, indefinitely, and burned no attempts so
 * nothing ever stopped it.
 *
 * The fix backs period holds off (bounded) and wakes them on the actual blocker
 * resolution — a period opening or being created open — touching only rows whose
 * date the period covers. These tests pin: bounded retries, the wake routes,
 * exactly-once posting, no starvation, and that a MISSED wake still posts.
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

const getRow = (t: T, id: T) => t.run(async (ctx: T) => ctx.db.get(id));
const eventCount = (t: T, orgId: T) =>
  t.run(async (ctx: T) =>
    (await ctx.db.query("accountingEvents").collect()).filter(
      (e: T) => String(e.orgId) === String(orgId)
    ).length
  );

const year = () => new Date().getUTCFullYear();
const inYear = (month: number, day: number) => Date.UTC(year(), month, day);
const yearBounds = () => ({
  startDate: Date.UTC(year(), 0, 1),
  endDate: Date.UTC(year(), 11, 31, 23, 59, 59, 999),
});

describe("held-row retry cost is bounded", () => {
  test("a row held for a missing period is claimed O(log n) times over two hours, not 120", async () => {
    const { t, orgId, userId } = await seed("bound");
    vi.useFakeTimers({ toFake: [...FAKE] });
    // No period exists for this date at all.
    const rowId = await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), 1);

    for (let minute = 0; minute < 120; minute += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + MINUTE);
    }

    const row = await getRow(t, rowId);
    // `generation` is minted once per claim, so it counts worker runs.
    expect(row.generation).toBeLessThanOrEqual(10);
    expect(row.generation).toBeGreaterThanOrEqual(3);
    expect(row.status).toBe("PENDING");
    // A hold is not a failure: no attempt burned, reason stays visible.
    expect(row.attempts).toBe(0);
    expect(row.lastError).toMatch(/Waiting to post/);
    expect(row.dispatchState).toBeUndefined();
    expect(row.holdStreak).toBeGreaterThanOrEqual(3);
    // The delay grows but is capped, so a missed wake costs bounded latency.
    expect(row.nextActionAt - Date.now()).toBeLessThanOrEqual(60 * MINUTE);
  });
});

describe("a period becoming available wakes exactly the rows it covers", () => {
  test("opening a FUTURE period posts a deeply backed-off held row at once", async () => {
    const { t, orgId, userId, asAdmin } = await seed("open");
    vi.useFakeTimers({ toFake: [...FAKE] });
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1,
    });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    for (let i = 0; i < 8; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
    const held = await getRow(t, rowId);
    expect(held.status).toBe("PENDING");
    expect(held.nextActionAt).toBeGreaterThan(Date.now() + 5 * MINUTE);

    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    await pump(t); // the scheduler only — NO cron tick

    const after = await getRow(t, rowId);
    expect(after.status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("creating a period with openImmediately posts a held row at once", async () => {
    const { t, orgId, userId, asAdmin } = await seed("create");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    for (let i = 0; i < 6; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
    expect((await getRow(t, rowId)).status).toBe("PENDING");

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    await pump(t);

    expect((await getRow(t, rowId)).status).toBe("POSTED");
    expect(await eventCount(t, orgId)).toBe(1);
  });

  test("the wake leaves out-of-range rows and another org's in-range row alone", async () => {
    const { t, orgId, userId, asAdmin } = await seed("scope");
    // Same database: only the orgId on the index range keeps this row out.
    const other = await seed("scope2", t);
    vi.useFakeTimers({ toFake: [...FAKE] });
    const outside = await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), 1);
    const otherOrgRow = await queueExpense(t, other.orgId, other.userId, inYear(5, 10), 2);
    for (let i = 0; i < 4; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
    const outsideBefore = await getRow(t, outside);
    const otherBefore = await getRow(t, otherOrgRow);
    expect(otherBefore.holdKind).toBe("PERIOD");
    expect(otherBefore.holdStreak).toBeGreaterThanOrEqual(2);

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    await pump(t);

    for (const [id, before] of [[outside, outsideBefore], [otherOrgRow, otherBefore]] as const) {
      const after = await getRow(t, id);
      expect(after.status).toBe("PENDING");
      expect(after.nextActionAt).toBe(before.nextActionAt);
      expect(after.generation).toBe(before.generation);
    }
  });

  test("a period hold that turns into a failure drops its marker and the wake cannot release it", async () => {
    const { t, orgId, userId } = await seed("fail");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await cronTick(t);
    expect((await getRow(t, rowId)).holdKind).toBe("PERIOD");

    // The period now exists but is CLOSED: not a hold. The worker throws and
    // rolls back, and the observer — a separate transaction — records the failure.
    await t.run(async (ctx: T) =>
      ctx.db.insert("accountingPeriods", {
        orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, status: "CLOSED",
        createdAt: Date.now(), createdBy: userId, snapshotFastPathEligible: true,
      })
    );
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await cronTick(t);
    expect(await observeClaimed(t, orgId)).toBe(1);

    const failed = await getRow(t, rowId);
    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toMatch(/did not complete/);
    expect(failed.holdKind).toBeUndefined();
    expect(failed.holdStreak).toBeUndefined();
    expect(failed.nextActionAt).toBeGreaterThan(Date.now());

    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, { orgId, ...yearBounds() });
    await pump(t);

    const after = await getRow(t, rowId);
    expect(after.nextActionAt).toBe(failed.nextActionAt);
    expect(after.generation).toBe(failed.generation);
    expect(after.attempts).toBe(1);
  });

  test("a wake that races the cron and a repeated wake post exactly once", async () => {
    const { t, orgId, userId, asAdmin } = await seed("once");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    for (let i = 0; i < 4; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
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
    const journals = await t.run(async (ctx: T) =>
      (await ctx.db.query("journalEntries").collect()).filter(
        (j: T) => String(j.orgId) === String(orgId)
      ).length
    );
    expect(journals).toBe(1);
  });

  test("the wake pages through more rows than one page holds", async () => {
    const { t, orgId, userId } = await seed("page");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const ids = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(await queueExpense(t, orgId, userId, inYear(5, 10), i));
    }
    for (let i = 0; i < 3; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
    // Open the period WITHOUT the mutation's own wake.
    await t.run(async (ctx: T) =>
      ctx.db.insert("accountingPeriods", {
        orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, status: "OPEN",
        createdAt: Date.now(), createdBy: userId, snapshotFastPathEligible: true,
      })
    );
    await t.mutation(internal.accountingOutbox.wakePeriodHeldRows, {
      orgId, ...yearBounds(), limit: 10,
    });
    await pump(t);

    for (const id of ids) expect((await getRow(t, id)).status).toBe("POSTED");
  });
});

describe("eventual posting does not depend on the wake", () => {
  test("a period opened with no wake still posts once the capped delay elapses", async () => {
    const { t, orgId, userId } = await seed("missed");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    for (let i = 0; i < 12; i += 1) {
      await cronTick(t);
      vi.setSystemTime(Date.now() + 10 * MINUTE);
    }
    await t.run(async (ctx: T) =>
      ctx.db.insert("accountingPeriods", {
        orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, status: "OPEN",
        createdAt: Date.now(), createdBy: userId, snapshotFastPathEligible: true,
      })
    );
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    await cronTick(t);
    expect((await getRow(t, rowId)).status).toBe("POSTED");
  });

  test("a legacy held row with no hold fields is still re-offered and posts", async () => {
    const { t, orgId, userId } = await seed("legacy");
    vi.useFakeTimers({ toFake: [...FAKE] });
    const rowId = await queueExpense(t, orgId, userId, inYear(5, 10), 1);
    await t.run(async (ctx: T) =>
      ctx.db.patch(rowId, { lastError: "Waiting to post: old.", nextActionAt: Date.now() + MINUTE })
    );
    await t.run(async (ctx: T) =>
      ctx.db.insert("accountingPeriods", {
        orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, status: "OPEN",
        createdAt: Date.now(), createdBy: userId, snapshotFastPathEligible: true,
      })
    );
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await cronTick(t);
    expect((await getRow(t, rowId)).status).toBe("POSTED");
  });

  test("55 backed-off held rows neither burn attempts nor starve a postable row", async () => {
    const { t, orgId, userId, asAdmin } = await seed("starve");
    vi.useFakeTimers({ toFake: [...FAKE] });
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId, ...yearBounds(), fiscalYear: year(), periodNumber: 1, openImmediately: true,
    });
    const held = [];
    for (let i = 0; i < 55; i += 1) {
      held.push(await queueExpense(t, orgId, userId, Date.UTC(year() + 5, 0, 15), i));
    }
    let good: T;
    for (let minute = 0; minute < 20; minute += 1) {
      if (minute === 15) good = await queueExpense(t, orgId, userId, inYear(5, 10), 100);
      await cronTick(t);
      if (minute === 15) expect((await getRow(t, good)).status).toBe("POSTED");
      vi.setSystemTime(Date.now() + MINUTE);
    }

    let claims = 0;
    for (const id of held) {
      const row = await getRow(t, id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      claims += row.generation;
    }
    // Claims at minutes 0, 1, 3, 7, 15 ≈ 5 per row; a flat 60s hold would be 20.
    expect(claims).toBeLessThanOrEqual(55 * 6);
  });
});
