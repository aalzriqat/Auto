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

test("no suspense warning when the opening set balanced", () => withFrozenScheduler(async () => {
  const seed = await setup();
  await post(seed, 100_000, 100_000);
  await settleScheduledOnly(seed.t, seed.orgId);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(checklist.warnings).not.toContain(OPENING_SUSPENSE_OPEN_WARNING);
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
