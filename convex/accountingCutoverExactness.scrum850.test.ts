import { expect, test } from "vitest";
import type { FunctionArgs } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

type Route = "reviewed" | "direct";
type OpeningInput = FunctionArgs<typeof api.accountingCutover.draftOpeningBalance>;

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST cutover exactness", createdAt: Date.now() });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    for (const clerkId of ["cutover-preparer", "cutover-approver"]) {
      const userId = await ctx.db.insert("users", { clerkId, email: `${clerkId}@example.test` });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    }
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return orgId;
  });
  const preparer = t.withIdentity({ subject: "cutover-preparer" });
  const approver = t.withIdentity({ subject: "cutover-approver" });
  await preparer.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  const periodId = await preparer.mutation(api.accountingPeriods.create, {
    orgId, startDate: asOfDate, endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1,
  });
  await preparer.mutation(api.accountingPeriods.open, { orgId, periodId });
  const accounts = await preparer.query(api.chartOfAccounts.list, { orgId });
  const account = (key: string) => {
    const row = accounts.find(candidate => candidate.systemKey === key);
    if (!row) throw new Error(`Missing fixture account ${key}`);
    return row._id;
  };
  return { t, preparer, approver, orgId, asOfDate, account };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function post(s: Fixture, route: Route, amountMinor: number, replacement = false) {
  const input: OpeningInput = { orgId: s.orgId, asOfDate: s.asOfDate, expectedCurrency: "JOD", lines: [
    { accountId: s.account(replacement ? "VAT_RECEIVABLE" : "CASH_ON_HAND"), debitMinor: amountMinor, creditMinor: 0 },
    { accountId: s.account(replacement ? "SALES_TAX_PAYABLE" : "RETAINED_EARNINGS"), debitMinor: 0, creditMinor: amountMinor },
  ] };
  const posted = route === "direct"
    ? await s.preparer.mutation(api.accountingCutover.postOpeningBalanceDirect, input)
    : await s.preparer.mutation(api.accountingCutover.draftOpeningBalance, input);
  const draftId = posted.draftId as Id<"openingBalanceDrafts">;
  if (route === "reviewed") {
    await s.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId, expectedVersion: 0 });
  }
  return draftId;
}

async function cycle(s: Fixture, route: Route, original: number, replacement: number) {
  const draftId = await post(s, route, original);
  await s.preparer.mutation(api.openingBalanceMaintenance.requestVoid, { orgId: s.orgId, draftId, reason: "Synthetic opening correction" });
  await s.approver.mutation(api.openingBalanceMaintenance.approveVoid, { orgId: s.orgId, draftId });
  await post(s, route, replacement, true);
  // Direct posting is approved by the preparer; reviewed posting by the approver.
  return route === "direct" ? s.approver : s.preparer;
}

async function auditRows(s: Fixture) {
  return s.t.run(ctx => ctx.db.query("financialAuditLog").collect());
}

async function assertRefused(s: Fixture, signer: Fixture["preparer"]) {
  const before = await auditRows(s);
  await expect(signer.mutation(api.accountingCutover.signOffCutover, { orgId: s.orgId }))
    .rejects.toThrow(/CUTOVER_UNSAFE_TOTAL/);
  expect(await s.preparer.query(api.accountingCutover.listSignOffs, { orgId: s.orgId })).toEqual([]);
  expect(await s.t.run(ctx => ctx.db.query("accountingCutoverSignOffs").collect())).toEqual([]);
  expect(await auditRows(s)).toEqual(before);
}

async function unsafeCycle(route: Route) {
  const s = await fixture();
  const signer = await cycle(s, route, 9_007_199_254_740_991, 1);
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
  expect(lines.reduce((sum, line) => sum + BigInt(line.debitMinor), 0n)).toBe(18_014_398_509_481_983n);
  expect(lines.reduce((sum, line) => sum + BigInt(line.creditMinor), 0n)).toBe(18_014_398_509_481_983n);
  const snapshots = await s.t.run(ctx => ctx.db.query("accountBalanceSnapshots").collect());
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every(row => Number.isSafeInteger(row.runningDebitMinor) && Number.isSafeInteger(row.runningCreditMinor))).toBe(true);
  await assertRefused(s, signer);
}

async function exactCycle(route: Route, original: number, replacement: number, expected: number) {
  const s = await fixture();
  const signer = await cycle(s, route, original, replacement);
  const signed = await signer.mutation(api.accountingCutover.signOffCutover, { orgId: s.orgId });
  expect(signed.snapshot.trialBalanceByCurrency).toEqual([
    { currency: "JOD", totalDebitsMinor: expected, totalCreditsMinor: expected, isBalanced: true },
  ]);
  const [retained] = await s.preparer.query(api.accountingCutover.listSignOffs, { orgId: s.orgId });
  expect(retained?.snapshot).toEqual(signed.snapshot);
  const audits = (await auditRows(s)).filter(row => row.resourceType === "accountingCutoverSignOffs");
  expect(audits).toHaveLength(1);
  expect(audits[0].after).toEqual(retained.snapshot);
}

test("SCRUM-850 R4 reviewed opening unsafe gross sign-off refuses without writes", () => withFrozenScheduler(() => unsafeCycle("reviewed")));
test("SCRUM-850 R4 direct opening unsafe gross sign-off refuses without writes", () => withFrozenScheduler(() => unsafeCycle("direct")));
test("SCRUM-850 R4 reviewed ordinary sign-off persists exact gross history", () => withFrozenScheduler(() => exactCycle("reviewed", 200_003, 200_002, 600_008)));
test("SCRUM-850 R4 direct ordinary sign-off persists exact gross history", () => withFrozenScheduler(() => exactCycle("direct", 200_003, 200_002, 600_008)));
test("SCRUM-850 R4 reviewed safe boundary sign-off remains exact", () => withFrozenScheduler(() => exactCycle("reviewed", 4_503_599_627_370_494, 2, 9_007_199_254_740_990)));
test("SCRUM-850 R4 direct safe boundary sign-off remains exact", () => withFrozenScheduler(() => exactCycle("direct", 4_503_599_627_370_494, 2, 9_007_199_254_740_990)));

async function separateCurrencies(route: Route) {
  const s = await fixture();
  const signer = await cycle(s, route, 4_503_599_627_370_495, 2);
  // A retained pre-currency-change ledger: opening and reversal are USD, replacement JOD.
  // Seed history directly because currency configuration is locked after posting today.
  await s.t.run(async ctx => {
    const lines = await ctx.db.query("journalLines").collect();
    for (const line of lines) {
      if (line.accountId === s.account("CASH_ON_HAND") || line.accountId === s.account("RETAINED_EARNINGS")) {
        await ctx.db.patch(line._id, { currency: "USD" });
      }
    }
  });
  const signed = await signer.mutation(api.accountingCutover.signOffCutover, { orgId: s.orgId });
  expect(signed.snapshot.trialBalanceByCurrency).toEqual([
    { currency: "USD", totalDebitsMinor: 9_007_199_254_740_990, totalCreditsMinor: 9_007_199_254_740_990, isBalanced: true },
    { currency: "JOD", totalDebitsMinor: 2, totalCreditsMinor: 2, isBalanced: true },
  ]);
  const [retained] = await s.preparer.query(api.accountingCutover.listSignOffs, { orgId: s.orgId });
  expect(retained.snapshot).toEqual(signed.snapshot);
}

test("SCRUM-850 R4 reviewed sign-off keeps historical currencies separate", () => withFrozenScheduler(() => separateCurrencies("reviewed")));
test("SCRUM-850 R4 direct sign-off keeps historical currencies separate", () => withFrozenScheduler(() => separateCurrencies("direct")));

async function oneUnsafeSide(side: "debitMinor" | "creditMinor") {
  const s = await fixture();
  const signer = await cycle(s, "reviewed", 9_007_199_254_740_991, 1);
  // Corrupt historical counterpart, not a supported posting route. Isolate each gross
  // guard: a balanced overflow would still refuse if just one side were unchecked.
  await s.t.run(async ctx => {
    for (const line of await ctx.db.query("journalLines").collect()) {
      await ctx.db.patch(line._id, side === "debitMinor" ? { creditMinor: 0 } : { debitMinor: 0 });
    }
  });
  await assertRefused(s, signer);
}

test("SCRUM-850 R4 unsafe debit history refuses with the arithmetic code", () => withFrozenScheduler(() => oneUnsafeSide("debitMinor")));
test("SCRUM-850 R4 unsafe credit history refuses with the arithmetic code", () => withFrozenScheduler(() => oneUnsafeSide("creditMinor")));

async function unsafeLegacyComparison(side: "debitMinor" | "creditMinor") {
  const s = await fixture();
  await post(s, "reviewed", 200_003);
  // Retained migrated history, not a new transactions-source posting (that door is retired).
  await s.t.run(async ctx => {
    const journal = await ctx.db.query("journalEntries").unique();
    if (!journal?.postedBy) throw new Error("Missing fixture journal");
    const lines = await ctx.db.query("journalLines").collect();
    for (const line of lines) {
      await ctx.db.patch(line._id, { debitMinor: 0, creditMinor: 0, [side]: 4_503_599_627_370_497 });
    }
    await ctx.db.insert("accountingEvents", {
      orgId: s.orgId, eventType: "EXPENSE_POSTED", sourceType: "transactions", sourceId: "retained-legacy",
      eventVersion: 1, idempotencyKey: "retained-legacy", occurredAt: s.asOfDate, accountingDate: s.asOfDate,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: journal.postedBy, createdAt: s.asOfDate, journalEntryId: journal._id,
    });
  });
  await expect(s.preparer.query(api.accountingCutover.compareLegacyToGL, {
    orgId: s.orgId, fromDate: s.asOfDate, toDate: s.asOfDate,
  })).rejects.toThrow(/CUTOVER_UNSAFE_TOTAL/);
}

test("SCRUM-850 R4 legacy comparison refuses unsafe gross debit", () => withFrozenScheduler(() => unsafeLegacyComparison("debitMinor")));
test("SCRUM-850 R4 legacy comparison refuses unsafe gross credit", () => withFrozenScheduler(() => unsafeLegacyComparison("creditMinor")));
