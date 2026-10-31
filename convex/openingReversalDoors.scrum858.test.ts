// @vitest-environment node
// SCRUM-858 slice 2 — attack the OPENING_BALANCE journal through every door that could undo it:
// the generic event reversal, the manual-journal pair and the period close/reopen cycle.
//
// The opening journal is written by postOpeningBalanceDraft with sourceType "cutover" and NO
// accounting event, so the generic reversal has nothing legitimate to point at. These tests prove
// the three doors refuse, and refuse BEFORE any write: every one compares the whole ledger
// byte-for-byte after the attempt.
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";
import { api, internal } from "./_generated/api";
import schema from "./schema";

async function fixture() {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST opening reversal doors", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "reversal-owner", email: "owner@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "reversal-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const staffRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: staffRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId, employeeId };
  });
  const owner = t.withIdentity({ subject: "reversal-owner" });
  const { orgId, ownerId, employeeId } = ids;
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const bySystemKey = (key: string) => {
    const row = accounts.find((account) => account.systemKey === key);
    if (!row) throw new Error(`Missing synthetic account ${key}`);
    return row;
  };
  const advances = bySystemKey("EMPLOYEE_ADVANCES");
  const retained = bySystemKey("RETAINED_EARNINGS");
  await settleScheduledOnly(t, orgId);
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { orgId, expectedCurrency: "JOD", asOfDate,
    lines: [
      { accountId: advances._id, debitMinor: 100_000, creditMinor: 0 },
      { accountId: retained._id, debitMinor: 0, creditMinor: 100_000 },
    ],
    allocations: [
      { kind: "EMPLOYEE_ADVANCE" as const, rowKey: "adv-1", accountId: advances._id, userId: employeeId,
        amountMinor: 100_000, note: "Synthetic historical remaining debt" },
    ] });
  const openingJournal = await t.run(async (ctx) => {
    const rows = (await ctx.db.query("journalEntries").collect()).filter((row) => row.category === "OPENING_BALANCE");
    if (rows.length !== 1) throw new Error(`Expected exactly one opening journal, found ${rows.length}`);
    return rows[0];
  });
  return { t, owner, orgId, ownerId, employeeId, periodId: period._id, openingJournal };
}

type Seed = Awaited<ReturnType<typeof fixture>>;

/** Everything a reversal, a manual journal or a period transition could touch. */
async function ledger(seed: Seed) {
  return seed.t.run(async (ctx) => ({
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
    snapshots: await ctx.db.query("accountBalanceSnapshots").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(),
    drafts: await ctx.db.query("manualJournalDrafts").collect(),
    advances: await ctx.db.query("employeeAdvances").collect(),
  }));
}

/** A POSTED event whose journal IS the opening journal: the only shape the generic door could ever reverse. */
async function linkEventToOpening(seed: Seed) {
  return seed.t.run((ctx) => ctx.db.insert("accountingEvents", {
    orgId: seed.orgId, eventType: "EMPLOYEE_ADVANCE_PAID", sourceType: "employeeAdvances", sourceId: "synthetic-link",
    eventVersion: 1, idempotencyKey: "synthetic-link-event", occurredAt: Date.now(), accountingDate: Date.now(),
    currency: "JOD", payload: {}, status: "POSTED", createdBy: seed.ownerId, createdAt: Date.now(),
    journalEntryId: seed.openingJournal._id,
  }));
}

test("the opening journal is the unreversed cutover journal with no accounting event behind it", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  expect(seed.openingJournal).toMatchObject({ category: "OPENING_BALANCE", sourceType: "cutover", status: "POSTED" });
  expect(seed.openingJournal.accountingEventId).toBeUndefined();
  const events = await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(events.filter((event) => event.journalEntryId === seed.openingJournal._id)).toEqual([]);
}));

test("the generic reversal door refuses an id that is not an accounting event, writing nothing", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const before = await ledger(seed);
  await expect(seed.owner.mutation(internal.accountingLedger.reverse, {
    orgId: seed.orgId,
    originalEventId: seed.openingJournal._id as never,
    reversalDate: Date.now(),
    reason: "attack: reverse the opening journal by its own id",
    idempotencyKey: "attack-journal-id",
  })).rejects.toThrow();
  expect(await ledger(seed)).toEqual(before);
}));

test("the generic reversal door refuses an event that is linked to the opening journal, writing nothing", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const eventId = await linkEventToOpening(seed);
  const before = await ledger(seed);
  // The period is OPEN, so only an opening-balance guard can be what stops this.
  await expect(seed.owner.mutation(internal.accountingLedger.reverse, {
    orgId: seed.orgId, originalEventId: eventId, reversalDate: Date.now(),
    reason: "attack: reverse a mis-linked event", idempotencyKey: "attack-linked-event",
  })).rejects.toThrow(/opening balance/i);
  expect(await ledger(seed)).toEqual(before);
  const journal = await seed.t.run((ctx) => ctx.db.get(seed.openingJournal._id));
  expect(journal).toMatchObject({ status: "POSTED" });
  expect(journal?.reversedByJournalEntryId).toBeUndefined();
}));

test("the manual-journal door refuses a journal that offsets the opening, creating no draft or journal", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true });
  const advances = accounts.find((account) => account.systemKey === "EMPLOYEE_ADVANCES");
  const retained = accounts.find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!advances || !retained) throw new Error("Missing synthetic account");
  const before = await ledger(seed);
  await expect(seed.owner.mutation(api.financialAudit.createManualJournal, {
    orgId: seed.orgId, memo: "attack: mirror the opening to wipe it", idempotencyKey: "attack-manual-create",
    accountingDate: Date.now(),
    lines: [
      { accountId: advances._id, debitMinor: 0, creditMinor: 100_000 },
      { accountId: retained._id, debitMinor: 100_000, creditMinor: 0 },
    ],
  })).rejects.toThrow(/turned off during the pilot/);
  expect(await ledger(seed)).toEqual(before);
}));

test("the manual-journal approval door refuses a pending draft that would offset the opening, posting nothing", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true });
  const advances = accounts.find((account) => account.systemKey === "EMPLOYEE_ADVANCES");
  const retained = accounts.find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!advances || !retained) throw new Error("Missing synthetic account");
  const draftId = await seed.t.run((ctx) => ctx.db.insert("manualJournalDrafts", {
    orgId: seed.orgId, status: "PENDING_APPROVAL", memo: "attack: seeded offsetting draft",
    lines: [
      { accountId: advances._id, debitMinor: 0, creditMinor: 100_000 },
      { accountId: retained._id, debitMinor: 100_000, creditMinor: 0 },
    ],
    accountingDate: Date.now(), idempotencyKey: "attack-manual-approve", createdBy: seed.employeeId, createdAt: Date.now(),
  }));
  const before = await ledger(seed);
  await expect(seed.owner.mutation(api.financialAudit.approveManualJournal, { orgId: seed.orgId, draftId }))
    .rejects.toThrow(/turned off during the pilot/);
  expect(await ledger(seed)).toEqual(before);
}));

test("closing and reopening the opening period leaves the opening journal untouched and posts no correction", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(checklist.canClose).toBe(true);
  const before = await ledger(seed);
  await seed.owner.mutation(api.accountingPeriods.close, {
    orgId: seed.orgId, periodId: seed.periodId, acknowledgedWarnings: checklist.warnings,
  });
  await seed.owner.mutation(api.accountingPeriods.reopen, {
    orgId: seed.orgId, periodId: seed.periodId, reason: "synthetic reopen to attack the opening journal",
  });
  await settleScheduledOnly(seed.t, seed.orgId);
  const after = await ledger(seed);
  expect(after.journals).toEqual(before.journals);
  expect(after.lines).toEqual(before.lines);
  expect(after.events).toEqual(before.events);
  expect(after.pending).toEqual(before.pending);
  const openings = after.journals.filter((journal) => journal.category === "OPENING_BALANCE");
  expect(openings).toHaveLength(1);
  expect(openings[0]).toMatchObject({ status: "POSTED" });
  expect(openings[0].reversedByJournalEntryId).toBeUndefined();
}));

test("after a close and reopen the generic reversal door still refuses the opening-linked event", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const eventId = await linkEventToOpening(seed);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  await seed.owner.mutation(api.accountingPeriods.close, {
    orgId: seed.orgId, periodId: seed.periodId, acknowledgedWarnings: checklist.warnings,
  });
  await seed.owner.mutation(api.accountingPeriods.reopen, {
    orgId: seed.orgId, periodId: seed.periodId, reason: "synthetic reopen to attack the opening journal",
  });
  await settleScheduledOnly(seed.t, seed.orgId);
  const before = await ledger(seed);
  await expect(seed.owner.mutation(internal.accountingLedger.reverse, {
    orgId: seed.orgId, originalEventId: eventId, reversalDate: Date.now(),
    reason: "attack: reverse after reopen", idempotencyKey: "attack-after-reopen",
  })).rejects.toThrow(/opening balance/i);
  expect(await ledger(seed)).toEqual(before);
}));
