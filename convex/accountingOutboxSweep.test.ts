/**
 * The outbox drain sweeps with a cursor.
 *
 * It used to read the oldest 50 PENDING rows and stop. A continuation was added
 * that ran only while a pass "made progress" — which fixed nothing for the case
 * it was written for: a first batch of entirely held rows makes no progress, so
 * the chain stopped and every postable row behind it went unexamined, however
 * long it waited. Counting failures as progress was worse in the other
 * direction: it re-read the same rows each pass, burning MAX_ATTEMPTS in
 * seconds and dead-lettering entries a later retry would have posted.
 *
 * A cursor pages past held rows and visits each row at most once per sweep.
 * These tests pin both halves, because neither had any coverage.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedOrgWithChart(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Sweep ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `sw_${suffix}`, email: `${suffix}@sw.com`, name: "Owner" })
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
  const asAdmin = t.withIdentity({ subject: `sw_${suffix}`, clerkId: `sw_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });
  return { t, orgId, userId, asAdmin };
}

/** A queued EXPENSE_POSTED row — the simplest entry with a real posting rule. */
async function queueExpense(
  t: any,
  orgId: any,
  userId: any,
  accountingDate: number,
  seq: number
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("pendingAccountingEvents", {
      orgId, kind: "POST", status: "PENDING",
      idempotencyKey: `expense_posted_sweep_${seq}`,
      accountingDate, actorId: userId, attempts: 0, createdAt: Date.now() + seq,
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: `sweep_${seq}`,
      eventVersion: 1, occurredAt: accountingDate, currency: "USD",
      payload: { expenseId: `sweep_${seq}`, amountMinor: 1000, currency: "USD", category: "OTHER" },
    });
  });
}

describe("the outbox drain sweeps past held rows", () => {
  test("held rows at the head do not starve postable rows behind them", async () => {
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("starve");
    const year = new Date().getUTCFullYear();

    // 55 rows dated into a year with no period at all — every one of them is
    // HELD (waiting), not failed, so they stay PENDING at the head forever.
    const noPeriodDate = Date.UTC(year + 5, 0, 15);
    for (let i = 0; i < 55; i++) {
      await queueExpense(t, orgId, userId, noPeriodDate, i);
    }
    // Then 5 rows in a period that IS open.
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    const postableDate = Date.UTC(year, 5, 10);
    for (let i = 100; i < 105; i++) {
      await queueExpense(t, orgId, userId, postableDate, i);
    }

    // ⚠️ FAKE TIMERS GO ON BEFORE THE SWEEP STARTS, NOT AFTER IT.
    //
    // The sweep continues by scheduling ITSELF, so the later pages only run if
    // the scheduler chain is driven. Installing fake timers after triggering
    // the sweep left the chain already running on REAL timers — instrumenting
    // it showed two continuations already `success` and two still `pending`
    // before the pump was even installed. `vi.runAllTimers` drives fake timers
    // only, so those orphaned real ones never advanced, and the assertions ran
    // against a half-finished chain. It passed alone and failed 100% of the
    // time alongside another convex-heavy file, because the race is decided by
    // how much CPU the two workers are sharing — a gate that fails on machine
    // load rather than on what it asserts.
    //
    // `Date` is deliberately NOT faked: this test builds accounting periods
    // from the real calendar year, and freezing the clock at the epoch would
    // put every queued entry outside the period it was written for.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      // Before the cursor, the first page was 50 held rows, "no progress"
      // stopped the chain, and these 5 were never looked at.
      await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
      // Pumped to a fixed point rather than once: the continuation is
      // scheduled BY a scheduled function, so one pass can return with more
      // work still queued behind it.
      for (let pass = 0; pass < 10; pass += 1) {
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        const queued = (
          await t.run(async (ctx: any) =>
            await ctx.db.system.query("_scheduled_functions").collect()
          )
        ).filter((f: any) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
        if (queued === 0) break;
      }
    } finally {
      vi.useRealTimers();
    }

    const stillPending = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect()
    );
    const postedRows = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId).eq("status", "POSTED"))
        .collect()
    );
    expect(postedRows).toHaveLength(5);
    // The 55 held ones are untouched and, crucially, have burned no attempts.
    expect(stillPending).toHaveLength(55);
    expect(stillPending.every((r: any) => r.attempts === 0)).toBe(true);
  });

  test("a failing row is charged exactly one attempt per sweep", async () => {
    // Counting failures as progress re-read the same page each pass, so one
    // drain could take a row from 0 to MAX_ATTEMPTS and dead-letter it.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("attempts");
    const year = new Date().getUTCFullYear();
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    // A row whose posting rule will throw: no eventType the engine can map.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING",
        idempotencyKey: "bogus_sweep_row",
        accountingDate: Date.UTC(year, 5, 10), actorId: userId, attempts: 0,
        createdAt: Date.now(), eventType: "NOT_A_REAL_EVENT_TYPE",
        sourceType: "expenses", sourceId: "bogus", eventVersion: 1,
        occurredAt: Date.UTC(year, 5, 10), currency: "USD", payload: {},
      });
    });

    // One sweep only — no scheduler drain, because a single page is all this
    // needs and the point is how many attempts ONE sweep costs.
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    const row = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q: any) =>
          q.eq("orgId", orgId).eq("idempotencyKey", "bogus_sweep_row")
        )
        .first()
    );
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe("PENDING");
  });

  test("spending the pass budget schedules a resume FROM THE CURSOR, not a restart", async () => {
    // Round 9. The cursor removed starvation only BELOW the pass budget. On
    // exhausting it the code logged and dropped the cursor, and every later
    // trigger — cron or redrive — restarts at `null`. So with a full budget the
    // oldest 2,050 rows are all any sweep ever examines: if those are held,
    // nothing behind them is ever attempted again. That is the same permanent
    // starvation, only moved further out.
    //
    // This asserts on the scheduled continuation rather than on rows posted at
    // the far end of the chain. Driving the chain would prove nothing here: the
    // period fixtures below schedule their own cursorless redrives, and those
    // alone will post the trailing row — so a row-counting version of this test
    // passes just as happily with the fix reverted.
    const { t, orgId, userId, asAdmin } = await seedOrgWithChart("budget");
    const year = new Date().getUTCFullYear();

    // Three held rows at the head — dated into a year with no period at all.
    const noPeriodDate = Date.UTC(year + 5, 0, 15);
    for (let i = 0; i < 3; i++) {
      await queueExpense(t, orgId, userId, noPeriodDate, i);
    }
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    // One postable row behind them.
    await queueExpense(t, orgId, userId, Date.UTC(year, 5, 10), 100);

    // One row per page, entered with the budget already spent, so the boundary
    // is exercised directly rather than by seeding two thousand rows.
    const before = Date.now();
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId,
      limit: 1,
      pass: 40,
    });

    const scheduled = await t.run(async (ctx: any) =>
      await ctx.db.system.query("_scheduled_functions").collect()
    );
    const resumes = scheduled.filter(
      (s: any) =>
        s.name.includes("drainPendingAccountingEvents") && s.args?.[0]?.cursor != null
    );
    // Before the fix this was 0 — the sweep logged and gave up, and the held
    // row it stopped on became a permanent wall.
    expect(resumes).toHaveLength(1);
    expect(resumes[0].args[0].limit).toBe(1);
    // The budget is refreshed, so the sweep keeps advancing rather than
    // re-entering already spent.
    expect(resumes[0].args[0].pass).toBe(0);
    // ...and it yields first, so a large backlog cannot monopolize the scheduler.
    expect(resumes[0].scheduledTime).toBeGreaterThan(before);

    // The held row it stopped on burned no attempt.
    const head = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q: any) =>
          q.eq("orgId", orgId).eq("idempotencyKey", "expense_posted_sweep_0")
        )
        .first()
    );
    expect(head?.status).toBe("PENDING");
    expect(head?.attempts).toBe(0);
  });
});
