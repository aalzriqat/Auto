/**
 * Phase 18 tests — report scalability via running account balance snapshots.
 *
 * Acceptance gates: trial balance and balance sheet no longer collect every
 * journal line ever posted (verified by exercising a scenario that spans a
 * closed prior period plus a partially-elapsed current period, and checking
 * the snapshot table itself); results must stay exactly correct, including
 * at a date that falls strictly inside the current period (only entries
 * up to that date count) and after a reversal (snapshot nets back out).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { reverseAccountingEvent } from "./accounting/reversals";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedSnapshotDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase18 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p18_owner", email: "p18owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p18_owner", clerkId: "p18_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  // Two consecutive half-year periods so there's a genuinely "fully
  // elapsed" prior period plus a distinct "current, partially elapsed"
  // period to test the snapshot+delta boundary.
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2025, 0, 1), endDate: Date.UTC(2025, 5, 30, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 1,
  });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2025, 6, 1), endDate: Date.UTC(2025, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 2,
  });
  const periods = await asOwner.query(api.accountingPeriods.list, { orgId });
  const periodA = periods.find((p) => p.periodNumber === 1)!; // Jan-Jun
  const periodB = periods.find((p) => p.periodNumber === 2)!; // Jul-Dec
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: periodA._id });
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: periodB._id });

  return { t, orgId, userId, asOwner, periodA, periodB };
}

type Ctx = Awaited<ReturnType<typeof seedSnapshotDealer>>;

async function accountBySystemKey(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

describe("Phase 18 — snapshot correctness across a period boundary", () => {
  test("snapshots accumulate per (account, currency, period) and reports sum them correctly", async () => {
    const ctx = await seedSnapshotDealer();

    // Post directly through the migration's postAccountingEvent path (same
    // engine every domain event uses) so this test doesn't depend on any
    // one domain module's specific mutation surface.
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 100, date: Date.UTC(2025, 1, 1), category: "EXPENSE", description: "Period A expense" })
    );
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 50, date: Date.UTC(2025, 7, 1), category: "EXPENSE", description: "Period B expense (before cutoff)" })
    );
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 30, date: Date.UTC(2025, 10, 1), category: "EXPENSE", description: "Period B expense (after cutoff)" })
    );
    await ctx.asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, { orgId: ctx.orgId, dryRun: false });

    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    const expenseAccount = await accountBySystemKey(ctx.t, ctx.orgId, "GENERAL_EXPENSE");

    const snapshots = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", ctx.periodA._id)).collect()
    );
    const cashSnapshotA = snapshots.find((s) => s.accountId === cash?._id);
    const expenseSnapshotA = snapshots.find((s) => s.accountId === expenseAccount?._id);
    expect(cashSnapshotA?.runningCreditMinor).toBe(100_000);
    expect(expenseSnapshotA?.runningDebitMinor).toBe(100_000);

    const snapshotsB = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", ctx.periodB._id)).collect()
    );
    const cashSnapshotB = snapshotsB.find((s) => s.accountId === cash?._id);
    // Period B's snapshot accumulates BOTH postings within it regardless of
    // date — the as-of-date boundary only matters for the bounded re-derive
    // of the containing period at report time, not for what the snapshot
    // itself stores.
    expect(cashSnapshotB?.runningCreditMinor).toBe(80_000);

    // As of a date inside period B (Sep 15) — period A is fully elapsed
    // (safe to sum from its snapshot in full); period B is the containing
    // period, so only its Aug 1 entry (on/before Sep 15) should count, not
    // the Nov 1 one.
    const midPeriodB = Date.UTC(2025, 8, 15);
    const bsBefore = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: midPeriodB });
    const cashRowBefore = bsBefore.assetRows.find((r) => r.code === cash?.code);
    expect(cashRowBefore?.netMinor).toBe(-150_000); // -(100_000 + 50_000); Nov 1 excluded

    // As of a date after all three postings, the Nov 1 entry is now included too.
    const afterAll = Date.UTC(2025, 11, 31, 23, 59, 59, 999);
    const bsAfter = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: afterAll });
    const cashRowAfter = bsAfter.assetRows.find((r) => r.code === cash?.code);
    expect(cashRowAfter?.netMinor).toBe(-180_000);

    // Trial balance's cumulative (no-fromDate) path must agree with balance
    // sheet at the same as-of date — both now read the same snapshot helper.
    const tbBefore = await ctx.asOwner.query(api.accountingReports.trialBalance, { orgId: ctx.orgId, toDate: midPeriodB });
    const tbCashRow = tbBefore.rows.find((r) => r.code === cash?.code);
    expect(tbCashRow?.netMinor).toBe(-150_000);
  });

  test("a reversed event nets its snapshot contribution back to zero", async () => {
    const ctx = await seedSnapshotDealer();

    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 75, date: Date.UTC(2025, 1, 1), category: "EXPENSE", description: "To be reversed" })
    );
    await ctx.asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, { orgId: ctx.orgId, dryRun: false });

    const event = await ctx.t.run((c) =>
      c.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", ctx.orgId)).filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED")).first()
    );
    expect(event).toBeTruthy();

    const asOfBeforeReversal = Date.UTC(2025, 5, 30);
    const bsBefore = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: asOfBeforeReversal });
    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    expect(bsBefore.assetRows.find((r) => r.code === cash?.code)?.netMinor).toBe(-75_000);

    await ctx.t.run(async (c) => {
      await reverseAccountingEvent(c, {
        orgId: ctx.orgId,
        originalEventId: event!._id,
        reversalDate: Date.UTC(2025, 2, 1),
        reason: "Test reversal",
        actorId: ctx.userId,
        idempotencyKey: "reversal_test_1",
      });
    });

    const snapshotsA = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", ctx.periodA._id)).collect()
    );
    const cashSnapshot = snapshotsA.find((s) => s.accountId === cash?._id);
    // Original credited 75_000; reversal (swapped) debits 75_000 back — net zero.
    expect((cashSnapshot?.runningDebitMinor ?? 0) - (cashSnapshot?.runningCreditMinor ?? 0)).toBe(-75_000 + 75_000);

    const bsAfter = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: Date.UTC(2025, 5, 30) });
    const cashRowAfter = bsAfter.assetRows.find((r) => r.code === cash?.code);
    expect(cashRowAfter?.netMinor ?? 0).toBe(0);
  });
});
