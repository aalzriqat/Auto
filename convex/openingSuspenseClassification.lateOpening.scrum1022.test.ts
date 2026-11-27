/**
 * SCRUM-1022 (owner ruling 2026-11-27): posting a bank's stored opening late (SCRUM-1012) credits Opening suspense
 * (1900) outside the organization opening journal. That must not make the opening-difference classification
 * permanently ineligible. Invariant: classification proceeds iff every 1900 line outside the organization opening
 * journal belongs to a POSTED late-bank-opening accounting event of this organization (event identity, never memo);
 * the amount classified is the organization opening's own 1900 net; late credits are never swept in or altered.
 * Hand-written literals. Serial convex-test evidence; no platform, OCC or production claim.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bankOpening, seedBankOpeningFixture as seed, type BankOpeningFixture as Fx,
} from "../test-utils/openingBalanceBankFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  LATE_BANK_OPENING_EVENT, LATE_BANK_OPENING_SOURCE, LATE_BANK_OPENING_VERSION, lateBankOpeningEventKey,
} from "./accounting/lateBankOpening";

const OPENING_BANK_AMOUNT = 1_000_000;
const OPENING_OFFSET_CREDIT = 950_000; // 50.000 short of the bank debit, so 1900 carries a 50.000 credit
const SUSPENSE_CREDIT = 50_000;
const LATE_AMOUNT = 250_000;

type Seeded = Awaited<ReturnType<typeof seedClassifiable>>;

async function systemAccount(fx: Fx, systemKey: string): Promise<Id<"chartOfAccounts">> {
  return fx.t.run(async (ctx) => {
    const account = await ctx.db.query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", fx.orgId).eq("systemKey", systemKey)).first();
    if (!account) throw new Error(`System account ${systemKey} missing`);
    return account._id;
  });
}

/** Org opening names bank A and leaves a 50.000 credit in 1900; bank B is created later with a stated opening of 250.000. */
async function seedClassifiable() {
  const fx = await seed();
  const bankA = await fx.createBank("Opening bank", "JOD", true);
  const opening = bankOpening(fx, bankA, OPENING_BANK_AMOUNT);
  await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    ...opening, lines: [opening.lines[0], { ...opening.lines[1], creditMinor: OPENING_OFFSET_CREDIT }],
  });
  const bankB = await fx.asOwner.mutation(api.bankAccounts.create, {
    orgId: fx.orgId, name: "Late bank", currency: "JOD", openingBalanceMinor: LATE_AMOUNT, openingBalanceDate: Date.now(),
  });
  const reviewerId = await fx.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId: "s1022_reviewer", email: "s1022@example.test", name: "Reviewer" });
    const roleId = await ctx.db.insert("roles", {
      orgId: fx.orgId, name: "Cost reviewer", permissions: ["view:finance", "manage:finance", "view:cost_price"],
    });
    await ctx.db.insert("memberships", { orgId: fx.orgId, userId, roleId });
    return userId;
  });
  const asReviewer = fx.t.withIdentity({ subject: "s1022_reviewer", clerkId: "s1022_reviewer" });
  const suspenseId = await systemAccount(fx, "OPENING_SUSPENSE");
  const targetId = await systemAccount(fx, "MISCELLANEOUS_INCOME");
  const draft = await fx.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Opening draft missing");
  if (!draft.journalEntryId) throw new Error("Opening journal missing");
  return { fx, bankA, bankB, asReviewer, reviewerId, suspenseId, targetId, draftId: draft._id, draftJournalId: draft.journalEntryId };
}

async function postLate(s: Seeded) {
  const bank = await s.fx.t.run((ctx) => ctx.db.get(s.bankB));
  return s.fx.asOwner.mutation(api.bankAccounts.postLateOpeningBalance, {
    orgId: s.fx.orgId, bankAccountId: s.bankB, idempotencyKey: "s1022-late",
    expectedAmountMinor: bank?.openingBalanceMinor ?? 0, expectedOpeningBalanceDate: bank?.openingBalanceDate ?? 0,
  });
}

const classificationArgs = (s: Seeded) => ({
  orgId: s.fx.orgId, draftId: s.draftId, accountId: s.targetId, reason: "Classify the documented opening difference.",
});

async function netCredit(s: Seeded, accountId: Id<"chartOfAccounts">) {
  const lines = await s.fx.t.run((ctx) => ctx.db.query("journalLines")
    .withIndex("by_org_account", (q) => q.eq("orgId", s.fx.orgId).eq("accountId", accountId)).collect());
  return lines.reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
}

async function bookBalances(s: Seeded) {
  const rows = await s.fx.asOwner.query(api.bankAccounts.listBookBalances, { orgId: s.fx.orgId });
  return new Map(rows.map((row) => [row.bankAccountId, row.balanceMinor]));
}

async function classificationOf(s: Seeded, asUser: Seeded["fx"]["asOwner"]) {
  return (await asUser.query(api.openingBalanceMaintenance.status, { orgId: s.fx.orgId })).suspenseClassification;
}

async function journalLinesOf(s: Seeded, journalId: Id<"journalEntries">) {
  return s.fx.t.run((ctx) => ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).collect());
}

async function ledgerCount(s: Seeded) {
  return s.fx.t.run(async (ctx) => ({
    journals: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    draft: await ctx.db.get(s.draftId),
  }));
}

/** Ineligible = the screen offers no classification and a request is refused with the coded error, writing nothing. */
async function expectClassificationIneligible(s: Seeded) {
  expect(await classificationOf(s, s.fx.asOwner)).toBeUndefined();
  const before = await ledgerCount(s);
  await expect(s.fx.asOwner.mutation(api.openingBalanceMaintenance.requestSuspenseClassification, classificationArgs(s)))
    .rejects.toThrow(/OPENING_SUSPENSE_INELIGIBLE/);
  expect(await ledgerCount(s)).toEqual(before);
}

/** The single field in which a seeded 1900 credit differs from a genuine late opening; "GENUINE" differs in none. */
type Deviation =
  | "GENUINE" | "NO_EVENT" | "EVENT_OTHER_TYPE" | "EVENT_FOREIGN_ORG" | "DEBIT_LINE" | "REVERSED_JOURNAL"
  | "TWO_LINES_IN_JOURNAL" | "EVENT_KEY_MISMATCH";

/**
 * A 1900 posting for a separate bank (so it never collides with the real late opening of bank B) that is a genuine late
 * opening in EVERY field (journal source/category/status/org, event type/source/version/status/org/key, journal link in
 * both directions) except the one named by `deviation`.
 */
async function seedSecondLateLine(s: Seeded, deviation: Deviation) {
  await s.fx.t.run(async (ctx) => {
    const now = Date.now();
    const bankC = await ctx.db.insert("bankAccounts", {
      orgId: s.fx.orgId, name: "Third bank", currency: "JOD", openingBalanceMinor: 1_000, openingBalanceDate: now,
      isActive: true, isReconciliationTarget: false, createdBy: s.fx.ownerId, createdAt: now, updatedAt: now,
    });
    const sourceId = String(bankC);
    const eventOrgId = deviation === "EVENT_FOREIGN_ORG"
      ? await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: now }) : s.fx.orgId;
    const eventId = deviation === "NO_EVENT" ? undefined : await ctx.db.insert("accountingEvents", {
      orgId: eventOrgId,
      eventType: deviation === "EVENT_OTHER_TYPE" ? "SOMETHING_ELSE" : LATE_BANK_OPENING_EVENT,
      sourceType: LATE_BANK_OPENING_SOURCE, sourceId, eventVersion: LATE_BANK_OPENING_VERSION,
      idempotencyKey: deviation === "EVENT_KEY_MISMATCH" ? "s1022-wrong-key" : lateBankOpeningEventKey(sourceId),
      occurredAt: now, accountingDate: now, currency: "JOD", payload: {}, status: "POSTED", createdBy: s.fx.ownerId, createdAt: now,
    });
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.fx.orgId, ...(eventId ? { accountingEventId: eventId } : {}), journalNumber: "S1022-SECOND",
      accountingDate: now, sourceType: LATE_BANK_OPENING_SOURCE, sourceId, category: "ADJUSTMENT",
      memo: "Bank opening balance posted after cutover", status: "POSTED", currency: "JOD",
      postedBy: s.fx.ownerId, postedAt: now, createdAt: now,
      ...(deviation === "REVERSED_JOURNAL" ? { reversedByJournalEntryId: s.draftJournalId } : {}),
    });
    if (eventId) await ctx.db.patch(eventId, { journalEntryId });
    const line = {
      orgId: s.fx.orgId, journalEntryId, accountId: s.suspenseId, currency: "JOD", scale: 3, accountingDate: now,
    };
    await ctx.db.insert("journalLines", deviation === "DEBIT_LINE"
      ? { ...line, lineNumber: 1, debitMinor: 1_000, creditMinor: 0 }
      : { ...line, lineNumber: 1, debitMinor: 0, creditMinor: 1_000 });
    if (deviation === "TWO_LINES_IN_JOURNAL") {
      await ctx.db.insert("journalLines", { ...line, lineNumber: 2, debitMinor: 0, creditMinor: 500 });
    }
  });
}

describe("SCRUM-1022 opening-suspense classification after a late bank opening", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 5, 15, 10, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("classification stays eligible after a late bank opening and classifies exactly the organization opening's own 1900 amount", async () => {
    const s = await seedClassifiable();
    expect(await netCredit(s, s.suspenseId)).toBe(SUSPENSE_CREDIT);
    const late = await postLate(s);
    expect(await netCredit(s, s.suspenseId)).toBe(SUSPENSE_CREDIT + LATE_AMOUNT);
    const banksBefore = await bookBalances(s);
    expect(banksBefore).toEqual(new Map([[s.bankA, OPENING_BANK_AMOUNT], [s.bankB, LATE_AMOUNT]]));

    expect(await classificationOf(s, s.fx.asOwner)).toMatchObject({ signedBalanceMinor: -SUSPENSE_CREDIT, pending: null });
    const { version } = await s.fx.asOwner.mutation(api.openingBalanceMaintenance.requestSuspenseClassification, classificationArgs(s));
    expect((await classificationOf(s, s.asReviewer))?.pending).toMatchObject({ version, canApprove: true });
    const { journalId } = await s.asReviewer.mutation(api.openingBalanceMaintenance.approveSuspenseClassification, {
      orgId: s.fx.orgId, draftId: s.draftId, expectedVersion: version,
    });

    const lines = (await journalLinesOf(s, journalId)).sort((a, b) => a.lineNumber - b.lineNumber);
    expect(lines.map((line) => [line.accountId, line.debitMinor, line.creditMinor])).toEqual([
      [s.suspenseId, SUSPENSE_CREDIT, 0],
      [s.targetId, 0, SUSPENSE_CREDIT],
    ]);
    // 1900 afterwards holds exactly the late credit; the target holds exactly the classified amount.
    expect(await netCredit(s, s.suspenseId)).toBe(LATE_AMOUNT);
    expect(await netCredit(s, s.targetId)).toBe(SUSPENSE_CREDIT);
    // Bank balances are untouched and the late journal is unchanged.
    expect(await bookBalances(s)).toEqual(banksBefore);
    expect(await s.fx.t.run((ctx) => ctx.db.get(late.journalEntryId))).toMatchObject({ status: "POSTED", category: "ADJUSTMENT" });
    expect(await s.fx.t.run((ctx) => ctx.db.get(late.eventId))).toMatchObject({ status: "POSTED" });
    const all = await s.fx.t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(all.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0)).toBe(0);
  });

  test("a classification requested before the late posting can still be approved afterwards with the same amounts", async () => {
    const s = await seedClassifiable();
    const { version } = await s.fx.asOwner.mutation(api.openingBalanceMaintenance.requestSuspenseClassification, classificationArgs(s));
    expect((await classificationOf(s, s.asReviewer))?.pending).toMatchObject({ version, canApprove: true });

    await postLate(s);
    expect((await classificationOf(s, s.asReviewer))?.pending).toMatchObject({ version, canApprove: true });
    const { journalId } = await s.asReviewer.mutation(api.openingBalanceMaintenance.approveSuspenseClassification, {
      orgId: s.fx.orgId, draftId: s.draftId, expectedVersion: version,
    });

    const lines = (await journalLinesOf(s, journalId)).sort((a, b) => a.lineNumber - b.lineNumber);
    expect(lines.map((line) => [line.accountId, line.debitMinor, line.creditMinor])).toEqual([
      [s.suspenseId, SUSPENSE_CREDIT, 0],
      [s.targetId, 0, SUSPENSE_CREDIT],
    ]);
    expect(await netCredit(s, s.suspenseId)).toBe(LATE_AMOUNT);
  });

  test("a non-late posting on 1900 still makes classification ineligible, even next to a genuine late opening", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await s.fx.t.run(async (ctx) => {
      const now = Date.now();
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId: s.fx.orgId, journalNumber: "S1022-MANUAL", accountingDate: now, sourceType: "fixture", sourceId: "manual-on-1900",
        category: "MANUAL", memo: "Manual posting on opening suspense", status: "POSTED", currency: "JOD",
        postedBy: s.fx.ownerId, postedAt: now, createdAt: now,
      });
      await ctx.db.insert("journalLines", {
        orgId: s.fx.orgId, journalEntryId, lineNumber: 1, accountId: s.suspenseId,
        debitMinor: 0, creditMinor: 1_000, currency: "JOD", scale: 3, accountingDate: now,
      });
    });
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike whose accounting event is of another type is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "EVENT_OTHER_TYPE");
    await expectClassificationIneligible(s);
  });

  test("control: a second 1900 credit that is a genuine late opening in every field is tolerated", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "GENUINE");
    expect(await classificationOf(s, s.fx.asOwner)).toMatchObject({ signedBalanceMinor: -SUSPENSE_CREDIT, pending: null });
  });

  test("a late-opening look-alike that is a debit line is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "DEBIT_LINE");
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike whose journal is reversed is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "REVERSED_JOURNAL");
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike with two 1900 lines in one journal is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "TWO_LINES_IN_JOURNAL");
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike whose event idempotency key is not the per-bank late key is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "EVENT_KEY_MISMATCH");
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike whose accounting event belongs to another organization is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "EVENT_FOREIGN_ORG");
    await expectClassificationIneligible(s);
  });

  test("a late-opening look-alike with no accounting event at all is refused", async () => {
    const s = await seedClassifiable();
    await postLate(s);
    await seedSecondLateLine(s, "NO_EVENT");
    await expectClassificationIneligible(s);
  });

  test("a late opening whose journal is not POSTED is refused", async () => {
    const s = await seedClassifiable();
    const late = await postLate(s);
    await s.fx.t.run((ctx) => ctx.db.patch(late.journalEntryId, { status: "VALIDATED" }));
    await expectClassificationIneligible(s);
  });

  test("a late opening whose accounting event is not POSTED is refused", async () => {
    const s = await seedClassifiable();
    const late = await postLate(s);
    await s.fx.t.run((ctx) => ctx.db.patch(late.eventId, { status: "FAILED" }));
    await expectClassificationIneligible(s);
  });
});
