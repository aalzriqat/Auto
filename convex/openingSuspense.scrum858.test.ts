// @vitest-environment node
// SCRUM-858 / SCRUM-852 owner ruling 2026-11-04 ("Suspense account"): when the opening balances do not
// balance, the difference is POSTED to a suspense account, never to owner's capital, and it stays there as
// an open item until someone classifies it. Nothing closes it to equity automatically.
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import schema from "./schema";
import { OPENING_SUSPENSE_OPEN_WARNING } from "./utils/closeWarnings";

async function setup() {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST opening suspense", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "suspense-owner", email: "owner@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return orgId;
  });
  const owner = t.withIdentity({ subject: "suspense-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const cash = accounts.find((account) => account.systemKey === "CASH_ON_HAND");
  const retained = accounts.find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!cash || !retained) throw new Error("Missing synthetic accounts");
  await settleScheduledOnly(t, orgId);
  return { t, owner, orgId, asOfDate, periodId: period._id, cash, retained };
}

/** Every journal line of the posted opening journal, with the account's system key and code. */
async function openingLines(seed: Awaited<ReturnType<typeof setup>>) {
  return seed.t.run(async (ctx) => {
    const journal = (await ctx.db.query("journalEntries").collect()).find((row) => row.category === "OPENING_BALANCE");
    if (!journal) throw new Error("Missing opening journal");
    const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).collect();
    const rows = [];
    for (const line of lines) {
      const account = await ctx.db.get(line.accountId);
      rows.push({ systemKey: account?.systemKey, debitMinor: line.debitMinor, creditMinor: line.creditMinor });
    }
    return rows;
  });
}

const post = (seed: Awaited<ReturnType<typeof setup>>, debitMinor: number, creditMinor: number) =>
  seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: seed.asOfDate,
    lines: [
      { accountId: seed.cash._id, debitMinor, creditMinor: 0 },
      { accountId: seed.retained._id, debitMinor: 0, creditMinor },
    ],
  });

test("credits short of debits: the difference is posted as a suspense credit, not to equity", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 100_000, 60_000);
  const lines = await openingLines(seed);
  expect(lines).toContainEqual({ systemKey: "OPENING_SUSPENSE", debitMinor: 0, creditMinor: 40_000 });
  // The equity line is exactly what the user entered: nothing was added to owner's capital.
  expect(lines.filter((line) => line.systemKey === "RETAINED_EARNINGS")).toEqual([
    { systemKey: "RETAINED_EARNINGS", debitMinor: 0, creditMinor: 60_000 },
  ]);
  expect(lines.reduce((sum, line) => sum + line.debitMinor, 0)).toBe(lines.reduce((sum, line) => sum + line.creditMinor, 0));
}));

test("debits short of credits: the difference is posted as a suspense debit", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 60_000, 100_000);
  const lines = await openingLines(seed);
  expect(lines).toContainEqual({ systemKey: "OPENING_SUSPENSE", debitMinor: 40_000, creditMinor: 0 });
  expect(lines.filter((line) => line.systemKey === "RETAINED_EARNINGS")).toEqual([
    { systemKey: "RETAINED_EARNINGS", debitMinor: 0, creditMinor: 100_000 },
  ]);
  expect(lines.reduce((sum, line) => sum + line.debitMinor, 0)).toBe(lines.reduce((sum, line) => sum + line.creditMinor, 0));
}));

test("a balanced opening set posts no suspense line", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 100_000, 100_000);
  expect((await openingLines(seed)).some((line) => line.systemKey === "OPENING_SUSPENSE")).toBe(false);
}));

test("the suspense balance stays an open item in the close checklist and is not moved to equity", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 100_000, 60_000);
  await settleScheduledOnly(seed.t, seed.orgId);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(checklist.warnings).toContain(OPENING_SUSPENSE_OPEN_WARNING);
  // Reading the checklist posts nothing: the opening journal is still the only journal.
  const journals = await seed.t.run((ctx) => ctx.db.query("journalEntries").collect());
  expect(journals.filter((journal) => journal.status === "POSTED")).toHaveLength(1);
}));

test("the suspense warning does not offer a route that is switched off during the pilot", () => {
  // R6 Seat 1: it used to say "classify it with a manual journal" while both manual-journal doors refuse.
  expect(OPENING_SUSPENSE_OPEN_WARNING).toMatch(/manual journals are turned off during the pilot/);
  expect(OPENING_SUSPENSE_OPEN_WARNING).not.toMatch(/^.*Classify it/);
});

test("no suspense warning when the opening set balanced", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 100_000, 100_000);
  await settleScheduledOnly(seed.t, seed.orgId);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(checklist.warnings).not.toContain(OPENING_SUSPENSE_OPEN_WARNING);
}));

// R6 Seat 2: the totals were summed in a double. 9_007_199_254_740_991 + 2 against 9_007_199_254_740_991 has an
// exact gap of 2 but rounds to 1, so the suspense line was one minor unit short and the journal one unit out.
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const hugeLines = (seed: Awaited<ReturnType<typeof setup>>) => [
  { accountId: seed.cash._id, debitMinor: SAFE_MAX, creditMinor: 0 },
  { accountId: seed.cash._id, debitMinor: 2, creditMinor: 0 },
  { accountId: seed.retained._id, debitMinor: 0, creditMinor: SAFE_MAX },
];

test("direct post: a total above the safe-integer range is refused with a coded error and posts nothing", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: seed.asOfDate, lines: hugeLines(seed),
  })).rejects.toThrow(/OPENING_TOTAL_TOO_LARGE/);
  const journals = await seed.t.run((ctx) => ctx.db.query("journalEntries").collect());
  expect(journals.filter((journal) => journal.category === "OPENING_BALANCE")).toHaveLength(0);
}));

test("draft path: a total above the safe-integer range is refused with a coded error and saves no draft", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await expect(seed.owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: seed.asOfDate, lines: hugeLines(seed),
  })).rejects.toThrow(/OPENING_TOTAL_TOO_LARGE/);
  expect(await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").first())).toBeNull();
}));

// R11 Seat 2: a draft prepared by the earlier float arithmetic is already stored. Approval re-runs a shared
// preflight, which compared doubles, so this one-unit-out set (debit SAFE_MAX + 2, credit SAFE_MAX + suspense 1)
// posted. The exact check must refuse it before any write and must not rewrite the reviewed lines.
test("approving a stored draft that is a minor unit out is refused before any write and the draft is left as reviewed", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: seed.asOfDate,
    lines: [
      { accountId: seed.cash._id, debitMinor: 100_000, creditMinor: 0 },
      { accountId: seed.retained._id, debitMinor: 0, creditMinor: 60_000 },
    ],
  });
  const stored = await seed.t.run(async (ctx) => {
    const draft = await ctx.db.query("openingBalanceDrafts").first();
    const suspense = (await ctx.db.query("chartOfAccounts").collect()).find((a) => a.systemKey === "OPENING_SUSPENSE");
    const preparer = await ctx.db.insert("users", { clerkId: "suspense-preparer", email: "preparer@example.test" });
    if (!draft || !suspense) throw new Error("Missing draft or suspense account");
    const lines = [
      { accountId: seed.cash._id, debitMinor: SAFE_MAX, creditMinor: 0 },
      { accountId: seed.cash._id, debitMinor: 2, creditMinor: 0 },
      { accountId: seed.retained._id, debitMinor: 0, creditMinor: SAFE_MAX },
      { accountId: suspense._id, debitMinor: 0, creditMinor: 1 },
    ];
    await ctx.db.patch(draft._id, { lines, createdBy: preparer });
    return { draftId: draft._id, lines };
  });
  await expect(seed.owner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0,
    orgId: seed.orgId, draftId: stored.draftId,
  })).rejects.toThrow(/OPENING_TOTAL_TOO_LARGE/);
  const after = await seed.t.run(async (ctx) => ({
    draft: await ctx.db.get(stored.draftId),
    journals: (await ctx.db.query("journalEntries").collect()).filter((j) => j.category === "OPENING_BALANCE"),
  }));
  expect(after.journals).toHaveLength(0);
  expect(after.draft?.status).toBe("PENDING_APPROVAL");
  expect(after.draft?.lines).toEqual(stored.lines);
}));

test("the largest exactly representable gap still balances to the unit",() => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, SAFE_MAX, SAFE_MAX - 2);
  const lines = await openingLines(seed);
  expect(lines).toContainEqual({ systemKey: "OPENING_SUSPENSE", debitMinor: 0, creditMinor: 2 });
}));

test("the saved-for-approval path stores the suspense line in the draft the approver sees", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: seed.asOfDate,
    lines: [
      { accountId: seed.cash._id, debitMinor: 100_000, creditMinor: 0 },
      { accountId: seed.retained._id, debitMinor: 0, creditMinor: 60_000 },
    ],
  });
  const draft = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").first());
  const suspense = await seed.t.run(async (ctx) =>
    (await ctx.db.query("chartOfAccounts").collect()).find((account) => account.systemKey === "OPENING_SUSPENSE"));
  expect(draft?.lines).toContainEqual(expect.objectContaining({ accountId: suspense?._id, debitMinor: 0, creditMinor: 40_000 }));
}));
