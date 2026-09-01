/**
 * SCRUM-50 — a manual journal posts to the date the accountant meant.
 *
 * The defect on main: `approveManualJournal` computed `const now = Date.now()`,
 * resolved the period covering the APPROVAL day, and stamped that timestamp onto
 * the journal entry, onto every journal line, and onto the account snapshot's
 * period. A journal prepared for August but approved in September posted into
 * September — silently, with no operator action and nothing to notice.
 *
 * WHY THE FIXTURE USES MONTHLY PERIODS. The existing Phase 10 fixture opens a
 * single ANNUAL period, and under it this defect is invisible: the declared date
 * and the approval date resolve to the SAME period, so the periodId and the
 * snapshot look correct even when the date is wrong. A cross-period defect needs
 * a cross-period fixture. These tests declare a date in the PREVIOUS calendar
 * month and approve in the current one, so a wrong date lands in a different
 * period and a different snapshot row.
 *
 * The distinction being pinned:
 *   accountingDate            = the period the economic event belongs to
 *   postedAt/decidedAt/createdAt = when a human actually acted (audit metadata)
 * Both are real, and they are not the same fact.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** Start of the UTC month containing `ms`. */
function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Exclusive-end minus 1ms: the last instant of the UTC month containing `ms`. */
function monthEnd(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
}

/** Same day-of-month in the previous UTC month, at UTC midnight. */
function previousMonthDay(ms: number, day: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day);
}

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "SCRUM-50 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "s50_user", email: "s50@example.com", name: "Poster" })
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
    ctx.db.insert("users", { clerkId: "s50_reviewer", email: "s50rev@example.com", name: "Reviewer" })
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

  const asUser = t.withIdentity({ subject: "s50_user", clerkId: "s50_user" });
  const asReviewer = t.withIdentity({ subject: "s50_reviewer", clerkId: "s50_reviewer" });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const now = Date.now();
  const priorStart = monthStart(previousMonthDay(now, 15));
  const priorEnd = monthEnd(previousMonthDay(now, 15));
  const currentStart = monthStart(now);
  const currentEnd = monthEnd(now);

  // Two adjacent monthly periods, both OPEN. The declared date lives in the
  // prior one; approval happens "today", in the current one.
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: priorStart,
    endDate: priorEnd,
    fiscalYear: new Date(priorStart).getUTCFullYear(),
    periodNumber: new Date(priorStart).getUTCMonth() + 1,
  });
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: currentStart,
    endDate: currentEnd,
    fiscalYear: new Date(currentStart).getUTCFullYear(),
    periodNumber: new Date(currentStart).getUTCMonth() + 1,
  });

  const periods = await asUser.query(api.accountingPeriods.list, { orgId });
  const priorPeriod = periods.find((p) => p.startDate === priorStart)!;
  const currentPeriod = periods.find((p) => p.startDate === currentStart)!;
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: priorPeriod._id });
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: currentPeriod._id });

  const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
  const manualAccounts = accounts.filter((a) => a.allowManualPosting);
  const declaredDate = previousMonthDay(now, 15);

  const lines = [
    { accountId: manualAccounts[0]._id, debitMinor: 50_000, creditMinor: 0 },
    { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 50_000 },
  ];

  return {
    t, orgId, userId, reviewerId, asUser, asReviewer,
    manualAccounts, lines, declaredDate,
    priorPeriod, currentPeriod, now,
  };
}

describe("SCRUM-50 — a manual journal posts to its declared accounting date", () => {
  test("the journal entry carries the declared date, not the approval timestamp", async () => {
    const s = await seedDealer();
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Prior-month accrual approved late",
      lines: s.lines,
      idempotencyKey: "s50-entry-date",
      accountingDate: s.declaredDate,
    });
    const { journalId } = await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    const entry = await s.t.run((ctx) => ctx.db.get(journalId));
    expect(entry!.accountingDate).toBe(s.declaredDate);
    // The period must be the one containing the DECLARED date. Under a single
    // annual period this assertion would hold even with the defect present,
    // which is exactly why the fixture uses monthly periods.
    expect(entry!.periodId).toBe(s.priorPeriod._id);
  });

  test("EVERY journal line carries the declared date, not just the header", async () => {
    const s = await seedDealer();
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Line dates must agree with the header",
      lines: s.lines,
      idempotencyKey: "s50-line-dates",
      accountingDate: s.declaredDate,
    });
    const { journalId } = await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    // journalLines carries its OWN accountingDate column, so dating only the
    // entry would leave the lines contradicting the entry they belong to.
    const lines = await s.t.run((ctx) =>
      ctx.db.query("journalLines").filter((q) => q.eq(q.field("journalEntryId"), journalId)).collect()
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.accountingDate).toBe(s.declaredDate);
    }
  });

  test("the balance snapshot increments the declared date's period, not today's", async () => {
    const s = await seedDealer();
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Snapshot must follow the declared period",
      lines: s.lines,
      idempotencyKey: "s50-snapshot",
      accountingDate: s.declaredDate,
    });
    await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    // The reports read snapshots, not journal lines. A correctly dated entry
    // whose snapshot went to the wrong period still misstates the trial balance,
    // so this is asserted separately rather than assumed from the entry above.
    const snapshots = await s.t.run((ctx) =>
      ctx.db.query("accountBalanceSnapshots").collect()
    );
    const touched = snapshots.filter(
      (row) => row.runningDebitMinor > 0 || row.runningCreditMinor > 0
    );
    expect(touched.length).toBeGreaterThan(0);
    for (const row of touched) {
      expect(row.periodId).toBe(s.priorPeriod._id);
    }
    expect(touched.some((row) => row.periodId === s.currentPeriod._id)).toBe(false);
  });

  test("approval-time audit metadata stays approval-time and is NOT back-dated", async () => {
    const s = await seedDealer();
    const before = Date.now();
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Audit metadata is a different fact from the accounting date",
      lines: s.lines,
      idempotencyKey: "s50-audit-meta",
      accountingDate: s.declaredDate,
    });
    const { journalId } = await s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: s.orgId,
      draftId,
    });

    // The fix must not over-reach: back-dating postedAt/decidedAt would destroy
    // the record of when a human actually approved it, which is the audit trail
    // segregation of duties exists to produce.
    const entry = await s.t.run((ctx) => ctx.db.get(journalId));
    const draft = await s.t.run((ctx) => ctx.db.get(draftId));
    expect(entry!.postedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.createdAt).toBeGreaterThanOrEqual(before);
    expect(draft!.decidedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.postedAt).not.toBe(s.declaredDate);
  });
});

describe("SCRUM-50 — the declared date is validated, never guessed", () => {
  test("a date in a CLOSED period is refused", async () => {
    const s = await seedDealer();
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Into a closed period",
      lines: s.lines,
      idempotencyKey: "s50-closed",
      accountingDate: s.declaredDate,
    });
    // Seeded directly rather than through `accountingPeriods.close`: that
    // mutation's checklist blocks on the very draft this test needs pending
    // ("1 manual journal entry is awaiting approval"). The STATE is ordinary and
    // production-reachable — an owner closes a period with an override while a
    // stale draft sits in the queue, and someone approves the draft afterwards —
    // so the precondition is seeded and the guard under test is the approval's.
    await s.t.run((ctx) => ctx.db.patch(s.priorPeriod._id, { status: "CLOSED" as const }));

    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId: s.orgId, draftId })
    ).rejects.toThrow(/CLOSED|closed/);
  });

  test("a date no accounting period covers is refused, not silently retargeted", async () => {
    const s = await seedDealer();
    // Ten years before any period this org has ever defined.
    const orphanDate = Date.UTC(new Date(s.now).getUTCFullYear() - 10, 5, 12);
    const { draftId } = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "No period covers this",
      lines: s.lines,
      idempotencyKey: "s50-orphan",
      accountingDate: orphanDate,
    });

    // The defect's shape was to fall back to whatever period covered TODAY.
    // Refusing is the only honest answer: the operator picked a date the books
    // cannot represent.
    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId: s.orgId, draftId })
    ).rejects.toThrow(/period/i);
  });

  test("a legacy draft carrying no declared date is refused rather than back-filled with now()", async () => {
    const s = await seedDealer();
    // A row shaped like one written before this change: no accountingDate at all.
    // Inserted directly because no supported door can produce it any more.
    const legacyDraftId = await s.t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId: s.orgId,
        status: "PENDING_APPROVAL" as const,
        memo: "Pre-SCRUM-50 draft",
        lines: s.lines,
        idempotencyKey: "s50-legacy",
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );

    // Guessing here is precisely the defect. The operator must resubmit with a
    // date they actually chose.
    await expect(
      s.asReviewer.mutation(api.financialAudit.approveManualJournal, {
        orgId: s.orgId,
        draftId: legacyDraftId,
      })
    ).rejects.toThrow(/accounting date/i);

    // And nothing was posted on the way to refusing.
    const entries = await s.t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(entries).toHaveLength(0);
  });

  test("a legacy dateless draft can still be REJECTED, so refusing it is not a dead end", async () => {
    const s = await seedDealer();
    const legacyDraftId = await s.t.run((ctx) =>
      ctx.db.insert("manualJournalDrafts", {
        orgId: s.orgId,
        status: "PENDING_APPROVAL" as const,
        memo: "Pre-SCRUM-50 draft",
        lines: s.lines,
        idempotencyKey: "s50-legacy-rejectable",
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );

    // ⚠️ THIS IS THE TEST THAT KEEPS THE FIX FROM BEING A DEAD END, and it is
    // here because the previous ticket in this program shipped exactly that
    // mistake: a fail-closed refusal with no disposal path, which permanently
    // blocked a workflow. Refusing to APPROVE a dateless draft is only
    // acceptable while REJECTING it still works, because that is the operator's
    // way out — reject, then resubmit with a date they actually chose.
    await s.asReviewer.mutation(api.financialAudit.rejectManualJournal, {
      orgId: s.orgId,
      draftId: legacyDraftId,
      rejectionReason: "Prepared before the accounting date became explicit.",
    });

    const draft = await s.t.run((ctx) => ctx.db.get(legacyDraftId));
    expect(draft!.status).toBe("REJECTED");
  });

  test("reusing an idempotency key with a different accounting date is refused", async () => {
    const s = await seedDealer();
    await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Same memo, same lines",
      lines: s.lines,
      idempotencyKey: "s50-same-key",
      accountingDate: s.declaredDate,
    });

    // Once the date is meaningful, two journals differing only by date are
    // DIFFERENT journals. Returning the first one would silently discard the
    // second date — the same class of silent substitution this ticket exists to
    // remove.
    await expect(
      s.asUser.mutation(api.financialAudit.createManualJournal, {
        orgId: s.orgId,
        memo: "Same memo, same lines",
        lines: s.lines,
        idempotencyKey: "s50-same-key",
        accountingDate: s.declaredDate - 86_400_000,
      })
    ).rejects.toThrow(/Idempotency key reused/i);
  });

  test("replaying the identical request, date included, is still idempotent", async () => {
    const s = await seedDealer();
    const first = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Retry after a dropped response",
      lines: s.lines,
      idempotencyKey: "s50-replay",
      accountingDate: s.declaredDate,
    });
    const second = await s.asUser.mutation(api.financialAudit.createManualJournal, {
      orgId: s.orgId,
      memo: "Retry after a dropped response",
      lines: s.lines,
      idempotencyKey: "s50-replay",
      accountingDate: s.declaredDate,
    });

    // Tightening the fingerprint must not break the retry it exists to serve.
    expect(second.alreadyCreated).toBe(true);
    expect(second.draftId).toBe(first.draftId);
  });
});
