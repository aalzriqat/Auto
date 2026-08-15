/**
 * A manual journal posts to the date the accountant meant (SCRUM-50).
 *
 * `approveManualJournal` took `Date.now()` at approval time and used it for
 * three things at once: to find the period, as the journal entry's
 * `accountingDate`, and as every journal line's `accountingDate`. The draft
 * carried no date of its own, so there was nothing else it could have used.
 *
 * A June 30 accrual approved on July 2 therefore landed in July. Reopening June
 * did not help — the approval path still looked up the period for "now". That is
 * a period-cutoff defect in the authoritative ledger: accruals, reclasses and
 * audit adjustments silently move to whichever period the second signature
 * happened to fall in.
 *
 * Approval time is audit metadata. It belongs on `postedAt` and `decidedAt`, and
 * nowhere near the ledger's idea of when something happened.
 *
 * The periods here are derived from `Date.now()` rather than from calendar
 * months, so the test cannot start failing in the first days of a month.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const DAY = 24 * 60 * 60 * 1000;

async function seedTwoPeriodDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const now = Date.now();

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `MJ Date Dealer ${tag}`, createdAt: now })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_poster`, email: `${tag}@example.com`, name: "Poster" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const reviewerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_reviewer`,
      email: `${tag}rev@example.com`,
      name: "Reviewer",
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_poster`, clerkId: `${tag}_poster` });
  const asReviewer = t.withIdentity({ subject: `${tag}_reviewer`, clerkId: `${tag}_reviewer` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date(now).getUTCFullYear();
  // The PRIOR period — where the adjustment belongs.
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: now - 90 * DAY,
    endDate: now - 30 * DAY,
    fiscalYear,
    periodNumber: 1,
  });
  // The CURRENT period — where approval happens to fall, and where the defect
  // put the entry.
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: now - 30 * DAY + 1,
    endDate: now + 30 * DAY,
    fiscalYear,
    periodNumber: 2,
  });

  const periods = await asUser.query(api.accountingPeriods.list, { orgId });
  const priorPeriod = periods.find((p) => p.periodNumber === 1)!;
  const currentPeriod = periods.find((p) => p.periodNumber === 2)!;
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: priorPeriod._id });
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: currentPeriod._id });

  const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
  const manualAccounts = accounts.filter((a) => a.allowManualPosting);

  /** Inside the prior period, comfortably clear of both boundaries. */
  const targetDate = now - 60 * DAY;

  return {
    t,
    orgId,
    userId,
    reviewerId,
    asUser,
    asReviewer,
    manualAccounts,
    priorPeriod,
    currentPeriod,
    targetDate,
    now,
  };
}

describe("a manual journal posts to its stated accounting date", () => {
  test("a back-dated adjustment approved today lands in the period it was dated, not today's", async () => {
    const s = await seedTwoPeriodDealer("backdate");

    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Prior-period accrual",
      accountingDate: s.targetDate,
      lines: [
        { accountId: s.manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
        { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 5000 },
      ],
      idempotencyKey: "mj_backdate_1",
    });

    const { journalId } = await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    const entry = await s.t.run((ctx) => ctx.db.get(journalId));
    expect(entry).toBeTruthy();
    // The three things the defect conflated, asserted separately.
    expect(entry!.accountingDate).toBe(s.targetDate);
    expect(entry!.periodId).toBe(s.priorPeriod._id);
    // Approval time is still recorded — as metadata, which is all it ever was.
    expect(entry!.postedAt).toBeGreaterThan(s.targetDate);
  });

  test("every line carries the stated date too, not just the entry", async () => {
    // The lines are what the dated reports read. An entry stamped correctly
    // while its lines say "today" would still put the money in the wrong month.
    const s = await seedTwoPeriodDealer("lines");

    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Prior-period reclass",
      accountingDate: s.targetDate,
      lines: [
        { accountId: s.manualAccounts[0]._id, debitMinor: 7000, creditMinor: 0 },
        { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 7000 },
      ],
      idempotencyKey: "mj_lines_1",
    });

    const { journalId } = await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    const lines = await s.t.run((ctx) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId))
        .collect()
    );
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.accountingDate).toBe(s.targetDate);
    }
  });

  test("the balance snapshot moves in the target period, not the approval period", async () => {
    // The snapshot is what the Trial Balance reads per period. If it were
    // incremented against the approval period, the entry could sit in June
    // while June's reported balance never moved.
    const s = await seedTwoPeriodDealer("snapshot");

    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Prior-period accrual",
      accountingDate: s.targetDate,
      lines: [
        { accountId: s.manualAccounts[0]._id, debitMinor: 9000, creditMinor: 0 },
        { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 9000 },
      ],
      idempotencyKey: "mj_snapshot_1",
    });
    await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    // Summed across shards, the way the read path does — a single-shard read
    // would be right today only by accident.
    const debitsIn = async (periodId: typeof s.priorPeriod._id) =>
      await s.t.run(async (ctx) => {
        const rows = await ctx.db
          .query("accountBalanceSnapshots")
          .withIndex("by_org_period", (q) => q.eq("orgId", s.orgId).eq("periodId", periodId))
          .collect();
        return rows
          .filter((row) => row.accountId === s.manualAccounts[0]._id)
          .reduce((sum, row) => sum + row.runningDebitMinor, 0);
      });

    expect(await debitsIn(s.priorPeriod._id)).toBe(9000);
    // And nothing landed in the period the approval happened to fall in.
    expect(await debitsIn(s.currentPeriod._id)).toBe(0);
  });

  test("a target date in a CLOSED period is refused rather than quietly moved", async () => {
    // Fail closed. The old behaviour never even consulted the target period, so
    // a closed month could be posted into by dating a draft into it.
    const s = await seedTwoPeriodDealer("closed");

    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Into a closed month",
      accountingDate: s.targetDate,
      lines: [
        { accountId: s.manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "mj_closed_1",
    });

    await s.t.run((ctx) => ctx.db.patch(s.priorPeriod._id, { status: "CLOSED" as const }));

    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId: s.orgId, draftId })
    ).rejects.toThrow(/CLOSED/i);
  });

  test("a target date no period covers is refused", async () => {
    const s = await seedTwoPeriodDealer("noperiod");

    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Long before the books start",
      accountingDate: s.now - 400 * DAY,
      lines: [
        { accountId: s.manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "mj_noperiod_1",
    });

    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId: s.orgId, draftId })
    ).rejects.toThrow(/accounting period/i);
  });

  test("the accounting date is part of the draft's identity, not incidental to it", async () => {
    // The idempotency fingerprint covered memo and lines. Without the date in
    // it, resubmitting the same adjustment for a different month would return
    // the first draft and silently discard the new date.
    const s = await seedTwoPeriodDealer("fingerprint");

    const lines = [
      { accountId: s.manualAccounts[0]._id, debitMinor: 2500, creditMinor: 0 },
      { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 2500 },
    ];
    await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Same memo, same lines",
      accountingDate: s.targetDate,
      lines,
      idempotencyKey: "mj_fingerprint_1",
    });

    await expect(
      s.asUser.mutation(api.financialAudit.createManualJournal, {
        orgId: s.orgId,
        memo: "Same memo, same lines",
        accountingDate: s.now,
        lines,
        idempotencyKey: "mj_fingerprint_1",
      })
    ).rejects.toThrow(/different journal content/i);
  });

  test("a draft written before this change cannot be approved into a guessed date", async () => {
    // Fail closed on legacy rows. Substituting approval time here is exactly
    // the defect; refusing forces the accountant to state the date.
    const s = await seedTwoPeriodDealer("legacy");

    const draftId = await s.t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId: s.orgId,
        status: "PENDING_APPROVAL" as const,
        memo: "Queued before accounting dates existed",
        lines: [
          { accountId: s.manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
          { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
        ],
        idempotencyKey: "mj_legacy_1",
        createdBy: s.userId,
        createdAt: s.now,
      })
    );

    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId: s.orgId, draftId })
    ).rejects.toThrow(/accounting date/i);
  });

  test("an unusable accounting date is refused at the draft, not at approval", async () => {
    // NaN passes a v.number() validator in Convex, and a NaN date would find no
    // period and read as an unrelated failure a month later.
    const s = await seedTwoPeriodDealer("nan");

    const lines = [
      { accountId: s.manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
      { accountId: s.manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
    ];
    await expect(
      s.asUser.mutation(api.financialAudit.createManualJournal, {
        orgId: s.orgId,
        memo: "Not a date",
        accountingDate: Number.NaN,
        lines,
        idempotencyKey: "mj_nan_1",
      })
    ).rejects.toThrow(/accounting date/i);
  });
});
