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
import { Doc, Id } from "./_generated/dataModel";
import { reverseAccountingEvent } from "./accounting/reversals";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

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

  // A second finance-authorized user for opening-balance segregation of
  // duties (approver must differ from the preparer).
  const reviewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p18_reviewer", email: "p18reviewer@example.com", name: "Reviewer" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p18_owner", clerkId: "p18_owner" });
  const asReviewer = t.withIdentity({ subject: "p18_reviewer", clerkId: "p18_reviewer" });
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

  return { t, orgId, userId, reviewerId, asOwner, asReviewer, periodA, periodB };
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

// A single account's snapshot can now be split across multiple shard rows
// (see accounting/accountSnapshots.ts), so tests must sum every matching
// row instead of assuming exactly one exists per account.
function sumSnapshots(
  snapshots: Doc<"accountBalanceSnapshots">[],
  accountId: Id<"chartOfAccounts">
) {
  return snapshots
    .filter((s) => s.accountId === accountId)
    .reduce(
      (sum, s) => ({
        debitMinor: sum.debitMinor + s.runningDebitMinor,
        creditMinor: sum.creditMinor + s.runningCreditMinor,
      }),
      { debitMinor: 0, creditMinor: 0 }
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
    expect(sumSnapshots(snapshots, cash!._id).creditMinor).toBe(100_000);
    expect(sumSnapshots(snapshots, expenseAccount!._id).debitMinor).toBe(100_000);

    const snapshotsB = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", ctx.periodB._id)).collect()
    );
    // Period B's snapshot accumulates BOTH postings within it regardless of
    // date — the as-of-date boundary only matters for the bounded re-derive
    // of the containing period at report time, not for what the snapshot
    // itself stores.
    expect(sumSnapshots(snapshotsB, cash!._id).creditMinor).toBe(80_000);

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
    const cashSnapshot = sumSnapshots(snapshotsA, cash!._id);
    // Original credited 75_000; reversal (swapped) debits 75_000 back — net zero.
    expect(cashSnapshot.debitMinor - cashSnapshot.creditMinor).toBe(-75_000 + 75_000);

    const bsAfter = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: Date.UTC(2025, 5, 30) });
    const cashRowAfter = bsAfter.assetRows.find((r) => r.code === cash?.code);
    expect(cashRowAfter?.netMinor ?? 0).toBe(0);
  });
});

describe("Phase 18 — every direct journalLines inserter keeps snapshots in sync", () => {
  // postingEngine.ts and reversals.ts aren't the only places that ever insert
  // a journalLine: manual journal approval (Phase 10) and the opening-balance
  // cutover mutation (Phase 17) both build entries directly too. A snapshot
  // helper is only as good as its coverage of every insertion point, so each
  // of those gets its own regression test here rather than relying on the
  // posting-engine tests to imply the others are fine.
  test("approveManualJournal keeps the running snapshot in sync", async () => {
    const ctx = await seedSnapshotDealer();
    // approveManualJournal (unlike this file's other mutations) always
    // checks for a period covering the real Date.now(), not a caller-given
    // date — this seed's periods are both dated in 2025, so a period
    // covering "today" needs to exist too, distinct from the period-boundary
    // periods the other tests in this file rely on.
    const now = Date.now();
    const nowYear = new Date(now).getUTCFullYear();
    await ctx.asOwner.mutation(api.accountingPeriods.create, {
      orgId: ctx.orgId, startDate: Date.UTC(nowYear, 0, 1), endDate: Date.UTC(nowYear, 11, 31, 23, 59, 59, 999),
      fiscalYear: nowYear, periodNumber: 1,
    });
    const currentPeriod = (await ctx.asOwner.query(api.accountingPeriods.list, { orgId: ctx.orgId })).find((p) => p.fiscalYear === nowYear)!;
    await ctx.asOwner.mutation(api.accountingPeriods.open, { orgId: ctx.orgId, periodId: currentPeriod._id });

    // Manual journals only accept allowManualPosting accounts — unlike most
    // system accounts (Cash, Partner Capital, ...), these two are the
    // dedicated manual-adjustment accounts that permit it.
    const expenseAccount = await accountBySystemKey(ctx.t, ctx.orgId, "GENERAL_EXPENSE");
    const cashOverShort = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_OVER_SHORT");

    // Manual journal approval requires a different actor from the poster
    // (segregation of duties), so this needs its own second user+membership
    // distinct from ctx.asOwner (who will approve).
    const posterId = await ctx.t.run((c) =>
      c.db.insert("users", { clerkId: "p18_poster", email: "p18poster@example.com", name: "Poster" })
    );
    const posterRoleId = await ctx.t.run((c) =>
      c.db.insert("roles", { orgId: ctx.orgId, name: "Poster", permissions: ["view:finance", "manage:finance"] })
    );
    await ctx.t.run((c) => c.db.insert("memberships", { orgId: ctx.orgId, userId: posterId, roleId: posterRoleId }));
    const asPoster = ctx.t.withIdentity({ subject: "p18_poster", clerkId: "p18_poster" });

    const draft = await asPoster.mutation(api.financialAudit.createManualJournal, {
      orgId: ctx.orgId,
      memo: "Snapshot regression check",
      lines: [
        { accountId: expenseAccount!._id, debitMinor: 40_000, creditMinor: 0 },
        { accountId: cashOverShort!._id, debitMinor: 0, creditMinor: 40_000 },
      ],
      idempotencyKey: "p18_manual_journal_1",
    });
    await ctx.asOwner.mutation(api.financialAudit.approveManualJournal, { orgId: ctx.orgId, draftId: draft.draftId });

    const snapshots = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", currentPeriod._id)).collect()
    );
    expect(sumSnapshots(snapshots, expenseAccount!._id).debitMinor).toBe(40_000);
    expect(sumSnapshots(snapshots, cashOverShort!._id).creditMinor).toBe(40_000);

    // Query strictly after the posting's own accountingDate (approveManualJournal
    // stamps its own later Date.now(), not the `now` captured above) so the
    // containing-period bounded scan doesn't exclude it.
    const tb = await ctx.asOwner.query(api.accountingReports.trialBalance, { orgId: ctx.orgId, toDate: Date.now() + 1 });
    expect(tb.rows.find((r) => r.code === expenseAccount!.code)?.netMinor).toBe(40_000);
  });

  test("approveOpeningBalance keeps the running snapshot in sync", async () => {
    const ctx = await seedSnapshotDealer();
    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    const capital = await accountBySystemKey(ctx.t, ctx.orgId, "PARTNER_CAPITAL");

    const draft = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      asOfDate: Date.UTC(2025, 0, 15),
      lines: [
        { accountId: cash!._id, debitMinor: 500_000, creditMinor: 0 },
        { accountId: capital!._id, debitMinor: 0, creditMinor: 500_000 },
      ],
    });
    await ctx.asReviewer.mutation(api.accountingCutover.approveOpeningBalance, {
      orgId: ctx.orgId,
      draftId: draft.draftId as Id<"openingBalanceDrafts">,
    });

    const snapshots = await ctx.t.run((c) =>
      c.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", ctx.orgId).eq("periodId", ctx.periodA._id)).collect()
    );
    expect(sumSnapshots(snapshots, cash!._id).debitMinor).toBe(500_000);
    expect(sumSnapshots(snapshots, capital!._id).creditMinor).toBe(500_000);

    const bs = await ctx.asOwner.query(api.accountingReports.balanceSheet, { orgId: ctx.orgId, asOfDate: Date.UTC(2025, 5, 30) });
    expect(bs.assetRows.find((r) => r.code === cash!.code)?.netMinor).toBe(500_000);
  });

  test("draftOpeningBalance rejects an account that belongs to a different org", async () => {
    const ctx = await seedSnapshotDealer();
    const otherOrgId = await ctx.t.run((c) =>
      c.db.insert("organizations", { name: "Other Org", createdAt: Date.now() })
    );
    await ctx.t.run((c) =>
      c.db.insert("subscriptions", { orgId: otherOrgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const otherOwnerId = await ctx.t.run((c) =>
      c.db.insert("users", { clerkId: "p18_other_owner", email: "p18other@example.com", name: "Other Owner" })
    );
    const otherRoleId = await ctx.t.run((c) =>
      c.db.insert("roles", { orgId: otherOrgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true })
    );
    await ctx.t.run((c) => c.db.insert("memberships", { orgId: otherOrgId, userId: otherOwnerId, roleId: otherRoleId }));
    const asOtherOwner = ctx.t.withIdentity({ subject: "p18_other_owner", clerkId: "p18_other_owner" });
    await asOtherOwner.mutation(api.chartOfAccounts.initialize, { orgId: otherOrgId });
    const otherCash = await accountBySystemKey(ctx.t, otherOrgId, "CASH_ON_HAND");

    const capital = await accountBySystemKey(ctx.t, ctx.orgId, "PARTNER_CAPITAL");

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
        orgId: ctx.orgId,
        asOfDate: Date.UTC(2025, 0, 15),
        lines: [
          { accountId: otherCash!._id, debitMinor: 100_000, creditMinor: 0 },
          { accountId: capital!._id, debitMinor: 0, creditMinor: 100_000 },
        ],
      })
    ).rejects.toThrow(/not found in this organization/i);
  });
});
