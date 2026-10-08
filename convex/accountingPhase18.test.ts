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
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { reverseAccountingEvent } from "./accounting/reversals";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";
import { postLegacyTransactionEvent } from "../test-utils/legacyMigrationSeed";
import { fromMinorUnits } from "./utils/money";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function seedSnapshotDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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

    // Post directly through postAccountingEvent (same engine every domain event
    // uses) so this test doesn't depend on any one domain module's specific
    // mutation surface. This used to go through
    // `accountingMigration.migrateUnpostedTransactions`, which is retired and
    // can no longer post (SCRUM-234); the seeded events are identical.
    for (const [amount, date, description] of [
      [100, Date.UTC(2025, 1, 1), "Period A expense"],
      [50, Date.UTC(2025, 7, 1), "Period B expense (before cutoff)"],
      [30, Date.UTC(2025, 10, 1), "Period B expense (after cutoff)"],
    ] as const) {
      const transactionId = await ctx.t.run((c) =>
        c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount, date, category: "EXPENSE", description })
      );
      await ctx.t.run((c) => postLegacyTransactionEvent(c, { orgId: ctx.orgId, transactionId, actorId: ctx.userId }));
    }

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

    const transactionId = await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 75, date: Date.UTC(2025, 1, 1), category: "EXPENSE", description: "To be reversed" })
    );
    await ctx.t.run((c) => postLegacyTransactionEvent(c, { orgId: ctx.orgId, transactionId, actorId: ctx.userId }));

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
    // approveManualJournal resolves the period from the draft's DECLARED
    // accountingDate (SCRUM-50), not from Date.now(). This seed's periods are
    // both dated in 2025 and the draft below declares Date.now(), so a period
    // covering "today" still needs to exist, distinct from the period-boundary
    // periods the other tests in this file rely on.
    //
    // ⚠️ THIS TEST CANNOT DETECT THE SCRUM-50 REGRESSION, and that is by
    // design rather than oversight: its period spans a whole calendar year, so
    // the declared date and the approval time fall in the SAME period and the
    // pre-fix (Date.now()-based) lookup would pass here unchanged. The
    // regression coverage lives in manualJournalAccountingDate.test.ts, which
    // uses adjacent MONTHLY periods precisely so the two can diverge.
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
      accountingDate: Date.now(),
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

    // Query strictly after the posting's own accountingDate — which is the
    // date the DRAFT declared (SCRUM-50), not a fresh stamp taken at approval
    // — so the containing-period bounded scan doesn't exclude it.
    const tb = await ctx.asOwner.query(api.accountingReports.trialBalance, { orgId: ctx.orgId, toDate: Date.now() + 1 });
    expect(tb.rows.find((r) => r.code === expenseAccount!.code)?.netMinor).toBe(40_000);
  });

  test("approveOpeningBalance keeps the running snapshot in sync", async () => {
    const ctx = await seedSnapshotDealer();
    const cash = await accountBySystemKey(ctx.t, ctx.orgId, "CASH_ON_HAND");
    const capital = await accountBySystemKey(ctx.t, ctx.orgId, "PARTNER_CAPITAL");

    const draft = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      expectedCurrency: "JOD",
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
        expectedCurrency: "JOD",
        asOfDate: Date.UTC(2025, 0, 15),
        lines: [
          { accountId: otherCash!._id, debitMinor: 100_000, creditMinor: 0 },
          { accountId: capital!._id, debitMinor: 0, creditMinor: 100_000 },
        ],
      })
    ).rejects.toThrow(/not found in this organization/i);
  });
});

type Balance = {
  accountId: Id<"chartOfAccounts">;
  currency: string;
  debitMinor: number;
  creditMinor: number;
};

// Pre-SCRUM-807 containing-period scan, retained as the parity oracle.
// Closed periods still read snapshots (ACC-2).
async function oldCumulativeBalances(ctx: Ctx, orgId: Id<"organizations">, asOfDate: number): Promise<Balance[]> {
  return ctx.t.run(async (dbCtx) => {
    const periods = await dbCtx.db.query("accountingPeriods")
      .withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
    const totals = new Map<string, Balance>();
    const add = (accountId: Id<"chartOfAccounts">, currency: string, debitMinor: number, creditMinor: number) => {
      const key = `${accountId}__${currency}`;
      const row = totals.get(key) ?? { accountId, currency, debitMinor: 0, creditMinor: 0 };
      row.debitMinor += debitMinor;
      row.creditMinor += creditMinor;
      totals.set(key, row);
    };
    for (const period of periods.filter((p) => p.endDate <= asOfDate)) {
      const snapshots = await dbCtx.db.query("accountBalanceSnapshots")
        .withIndex("by_org_period", (q) => q.eq("orgId", orgId).eq("periodId", period._id)).collect();
      for (const row of snapshots) add(row.accountId, row.currency, row.runningDebitMinor, row.runningCreditMinor);
    }
    const containing = periods.find((p) => p.startDate <= asOfDate && asOfDate < p.endDate);
    if (containing) {
      const entries = (await dbCtx.db.query("journalEntries")
        .withIndex("by_org_period", (q) => q.eq("orgId", orgId).eq("periodId", containing._id)).collect())
        .filter((entry) => (entry.status === "POSTED" || entry.status === "REVERSED") && entry.accountingDate <= asOfDate);
      for (const entry of entries) {
        const lines = await dbCtx.db.query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) add(line.accountId, line.currency, line.debitMinor, line.creditMinor);
      }
    }
    return [...totals.values()];
  });
}

function sortedBalances(rows: Balance[]) {
  return [...rows].sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)) || a.currency.localeCompare(b.currency));
}

describe("SCRUM-807 — trial balance snapshot fast-path parity", () => {
  test("matches the old scan across periods, future postings, reversal, and two orgs", async () => {
    const ctx = await seedSnapshotDealer();
    const dates = [Date.UTC(2025, 1, 1), Date.UTC(2025, 7, 1), Date.UTC(2025, 10, 1)] as const;
    for (const [index, date] of dates.entries()) {
      const transactionId = await ctx.t.run((c) => c.db.insert("transactions", {
        orgId: ctx.orgId, type: "OUT", amount: (index + 1) * 25,
        date, category: "EXPENSE", description: `Parity ${index}`,
      }));
      await ctx.t.run((c) => postLegacyTransactionEvent(c, { orgId: ctx.orgId, transactionId, actorId: ctx.userId }));
    }
    const event = await ctx.t.run((c) =>
      c.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED")).first()
    );
    expect(event).toBeTruthy();
    await ctx.t.run((c) => reverseAccountingEvent(c, {
      orgId: ctx.orgId, originalEventId: event!._id, reversalDate: Date.UTC(2025, 2, 1),
      reason: "Parity reversal", actorId: ctx.userId, idempotencyKey: "scrum807-parity-reversal",
    }));

    const otherOrgId = await ctx.t.run((c) =>
      c.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() })
    );
    await ctx.t.run((c) => c.db.insert("subscriptions", {
      orgId: otherOrgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const otherRoleId = await ctx.t.run((c) => c.db.insert("roles", {
      orgId: otherOrgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    }));
    await ctx.t.run((c) => c.db.insert("memberships", { orgId: otherOrgId, userId: ctx.userId, roleId: otherRoleId }));
    await ctx.t.run((c) => c.db.insert("orgSettings", {
      orgId: otherOrgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    }));
    await ctx.asOwner.mutation(api.chartOfAccounts.initialize, { orgId: otherOrgId });
    await ctx.asOwner.mutation(api.accountingPeriods.create, {
      orgId: otherOrgId, startDate: Date.UTC(2025, 6, 1), endDate: Date.UTC(2025, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2025, periodNumber: 2,
    });
    const otherPeriod = (await ctx.asOwner.query(api.accountingPeriods.list, { orgId: otherOrgId }))[0];
    await ctx.asOwner.mutation(api.accountingPeriods.open, { orgId: otherOrgId, periodId: otherPeriod._id });
    const otherTransactionId = await ctx.t.run((c) => c.db.insert("transactions", {
      orgId: otherOrgId, type: "OUT", amount: 200, date: Date.UTC(2025, 7, 1),
      category: "EXPENSE", description: "Other org posting",
    }));
    await ctx.t.run((c) => postLegacyTransactionEvent(c, {
      orgId: otherOrgId, transactionId: otherTransactionId, actorId: ctx.userId,
    }));

    for (const date of [Date.UTC(2025, 8, 1), Date.UTC(2025, 11, 1), Date.UTC(2025, 11, 31, 23, 59)]) {
      for (const orgId of [ctx.orgId, otherOrgId]) {
        const oldRows = sortedBalances(await oldCumulativeBalances(ctx, orgId, date));
        const newRows = sortedBalances(await ctx.t.run((c) => getCumulativeBalancesAsOf(c, orgId, date)));
        expect(newRows).toEqual(oldRows);
        const trial = await ctx.asOwner.query(api.accountingReports.trialBalance, { orgId, toDate: date });
        const accounts = await ctx.t.run((c) => c.db.query("chartOfAccounts")
          .withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
        const accountMap = new Map(accounts.map((account) => [account._id, account]));
        const expectedRows = oldRows.flatMap((balance) => {
          const account = accountMap.get(balance.accountId);
          if (!account || (balance.debitMinor === 0 && balance.creditMinor === 0)) return [];
          const netMinor = account.normalBalance === "DEBIT"
            ? balance.debitMinor - balance.creditMinor
            : balance.creditMinor - balance.debitMinor;
          return [{
            accountId: account._id, code: account.code, name: account.name, nameAr: account.nameAr,
            type: account.type, normalBalance: account.normalBalance,
            debitMinor: balance.debitMinor, creditMinor: balance.creditMinor, netMinor,
            currency: balance.currency, netDisplay: fromMinorUnits(netMinor, balance.currency),
            translatedNetMinor: undefined,
          }];
        }).sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));
        const totalDebits = expectedRows.reduce((sum, row) => sum + row.debitMinor, 0);
        const totalCredits = expectedRows.reduce((sum, row) => sum + row.creditMinor, 0);
        expect(trial).toEqual({
          rows: expectedRows, totalDebits, totalCredits, isBalanced: totalDebits === totalCredits,
          currency: "JOD", totalsByCurrency: expectedRows.length
            ? [{ currency: "JOD", totalDebits, totalCredits, isBalanced: totalDebits === totalCredits }]
            : [],
          reportingCurrency: null, missingRates: [],
        });
      }
    }
  });
});
