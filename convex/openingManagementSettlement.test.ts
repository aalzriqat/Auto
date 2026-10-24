import { expect, test, vi, afterEach } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { resetOrgToCompletion } from "../test-utils/orgResetFixtures";
import schema from "./schema";

const draft = api.openingManagementSettlement.draft;
const approve = api.openingManagementSettlement.approve;
const reject = api.openingManagementSettlement.reject;
const list = api.openingManagementSettlement.list;
const report = api.openingManagementSettlement.report;
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 15));
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST management settlement", createdAt: Date.now() });
    const otherOrg = await ctx.db.insert("organizations", { name: "QA TEST other management org", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "management-owner", email: "owner@example.test" });
    const approverId = await ctx.db.insert("users", { clerkId: "management-approver", email: "approver@example.test" });
    const outsiderId = await ctx.db.insert("users", { clerkId: "management-outsider", email: "outsider@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeId = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance"] });
    const outsiderRole = await ctx.db.insert("roles", { orgId: otherOrg, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId: financeId });
    await ctx.db.insert("memberships", { orgId: otherOrg, userId: outsiderId, roleId: outsiderRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, otherOrg, financeId };
  });
  const owner = t.withIdentity({ subject: "management-owner" });
  const approver = t.withIdentity({ subject: "management-approver" });
  const outsider = t.withIdentity({ subject: "management-outsider" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: Date.UTC(2026, 0, 1),
    endDate: Date.UTC(2026, 11, 31, 23, 59, 59, 999), fiscalYear: 2026, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const cash = accounts.find((row) => row.systemKey === "CASH_ON_HAND");
  const retained = accounts.find((row) => row.systemKey === "RETAINED_EARNINGS");
  if (!cash || !retained) throw new Error("Missing synthetic chart");
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { orgId: ids.orgId, expectedCurrency: "JOD",
    asOfDate: Date.UTC(2026, 0, 1), lines: [{ accountId: cash._id, debitMinor: 200_000, creditMinor: 0 },
      { accountId: retained._id, debitMinor: 0, creditMinor: 200_000 }] });
  const parent = await t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!parent) throw new Error("Missing synthetic posted opening");
  const args = { orgId: ids.orgId, openingDraftId: parent._id, totalMinor: 100_003,
    firstEffectiveMonth: Date.UTC(2026, 1, 1), supportingReference: "SYNTHETIC-CLASSIFICATION",
    classificationAttestation: "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL" as const, expectedCurrency: "JOD",
    idempotencyKey: "management-schedule-intent" };
  return { t, owner, approver, outsider, parent, args, period, ...ids };
}

async function books(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async (ctx) => ({ events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(), lines: await ctx.db.query("journalLines").collect(),
    movements: await ctx.db.query("partnerEquityTransactions").collect(), expenses: await ctx.db.query("expenses").collect(),
    prepaid: await ctx.db.query("prepaidExpenseSchedules").collect() }));
}

test("approved exact seven-part plan has no financial side effects and reads scheduled then recognised", async () => {
  const seed = await fixture();
  const before = await books(seed);
  const planId = await seed.owner.mutation(draft, seed.args);
  expect(await seed.owner.mutation(draft, seed.args)).toBe(planId);
  await expect(seed.owner.mutation(draft, { ...seed.args, totalMinor: 100_004 })).rejects.toThrow();
  await expect(seed.owner.mutation(approve, { orgId: seed.orgId, planId })).rejects.toThrow("must differ");
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  const [stored] = await seed.owner.query(list, { orgId: seed.orgId });
  expect(stored.installments.map((row: { amountMinor: number }) => row.amountMinor)).toEqual([14_286, 14_286, 14_286, 14_286, 14_286, 14_286, 14_287]);
  const early = await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.now() });
  expect(early.recognisedMinor).toBe(0);
  expect(early.installments.every((row: { recognition: string }) => row.recognition === "SCHEDULED")).toBe(true);
  vi.setSystemTime(Date.UTC(2026, 7, 2));
  const late = await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.now() });
  expect(late).toMatchObject({ recognisedMinor: 100_003, officialNetIncomeMinor: 0, managementProfitMinor: -100_003, distributionAvailable: false });
  expect(await books(seed)).toEqual(before);
  await expect(seed.approver.mutation(reject, { orgId: seed.orgId, planId })).rejects.toThrow();
});

test.each(["FOREIGN_ORG", "SOURCE_DELETED", "CURRENCY_CHANGED", "RESET", "LOST_PERMISSION"] as const)(
  "%s refuses management approval before changing books", async (damage) => {
    const seed = await fixture();
    const planId = await seed.owner.mutation(draft, seed.args);
    if (damage === "SOURCE_DELETED") await seed.t.run((ctx) => ctx.db.delete(seed.parent._id));
    if (damage === "CURRENCY_CHANGED") await seed.t.run(async (ctx) => {
      const settings = await ctx.db.query("orgSettings").unique();
      if (settings) await ctx.db.patch(settings._id, { currency: "USD" });
    });
    if (damage === "RESET") await seed.t.run((ctx) => ctx.db.patch(seed.orgId, { financialResetGeneration: 1, financialResetCompletedGeneration: 1 }));
    if (damage === "LOST_PERMISSION") await seed.t.run((ctx) => ctx.db.patch(seed.financeId, { permissions: ["view:finance"] }));
    const before = await books(seed);
    await expect((damage === "FOREIGN_ORG" ? seed.outsider : seed.approver).mutation(approve, {
      orgId: damage === "FOREIGN_ORG" ? seed.otherOrg : seed.orgId, planId,
    })).rejects.toThrow();
    expect(await books(seed)).toEqual(before);
  });

test.each([NaN, Infinity, -1, 0, 1.1, Number.MAX_SAFE_INTEGER + 1])("unsafe management total %s refuses before storing a plan", async (totalMinor) => {
  const seed = await fixture();
  await expect(seed.owner.mutation(draft, { ...seed.args, totalMinor })).rejects.toThrow();
  expect(await seed.owner.query(list, { orgId: seed.orgId })).toEqual([]);
});
test("management uses the native GL debit-credit flow unchanged through close and reopen", async () => {
  const seed = await fixture();
  const expenseId = await seed.owner.mutation(api.expenses.create, { orgId: seed.orgId, title: "Synthetic native expense",
    amount: 10, date: Date.now(), category: "OFFICE", paymentMethod: "CASH", idempotencyKey: "management-flow-expense" });
  const planId = await seed.owner.mutation(draft, seed.args);
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  const throughDate = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  vi.setSystemTime(throughDate);
  const args = { orgId: seed.orgId, fromDate: seed.parent.asOfDate, toDate: throughDate };
  const before = await seed.owner.query(api.accountingReports.incomeStatement, args);
  expect(before.netIncome).toBe(-10_000);
  const balanceBefore = await seed.owner.query(api.accountingReports.balanceSheet, { orgId: seed.orgId, asOfDate: throughDate });
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.period._id });
  expect(checklist.blockers).toEqual([]);
  await seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id, acknowledgedWarnings: checklist.warnings });
  const closed = await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate });
  expect(closed).toMatchObject({ officialNetIncomeMinor: -10_000, recognisedMinor: 100_003, managementProfitMinor: -110_003 });
  expect(await seed.owner.query(api.accountingReports.incomeStatement, args)).toEqual(before);
  expect(await seed.owner.query(api.accountingReports.balanceSheet, { orgId: seed.orgId, asOfDate: throughDate })).toEqual(balanceBefore);
  await seed.owner.mutation(api.accountingPeriods.reopen, { orgId: seed.orgId, periodId: seed.period._id, reason: "Synthetic native flow parity" });
  expect(await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate })).toEqual(closed);
  await seed.owner.mutation(api.expenses.reverseExpense, { orgId: seed.orgId, expenseId, reason: "Synthetic expense credit reversal" });
  const reversed = await seed.owner.query(api.accountingReports.incomeStatement, args);
  expect(reversed.netIncome).toBe(0);
  expect(await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate })).toMatchObject({ officialNetIncomeMinor: 0, recognisedMinor: 100_003, managementProfitMinor: -100_003 });
});

test("only a different authorized actor can read or approve the same opening plan", async () => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  await expect(seed.owner.mutation(draft, { ...seed.args, idempotencyKey: "second-intent" })).rejects.toThrow("already has");
  await expect(seed.outsider.query(list, { orgId: seed.orgId })).rejects.toThrow();
  await expect(seed.outsider.mutation(draft, { ...seed.args, orgId: seed.otherOrg })).rejects.toThrow();
  vi.setSystemTime(Date.UTC(2026, 3, 15));
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  const historical = await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.UTC(2026, 2, 31) });
  expect(historical.recognisedMinor).toBe(0);
  expect(historical.installments.every((row: { recognition: string }) => row.recognition === "SCHEDULED")).toBe(true);
  const current = await seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.now() });
  expect(current.recognisedMinor).toBe(42_858);
  expect(current.installments.slice(0, 3).map((row: { recognitionMonth: number }) => row.recognitionMonth)).toEqual(Array(3).fill(Date.UTC(2026, 3, 1)));
  await expect(seed.outsider.query(report, { orgId: seed.otherOrg, planId, throughDate: Date.now() })).rejects.toThrow();
  await expect(seed.approver.mutation(approve, { orgId: seed.orgId, planId })).rejects.toThrow("already been resolved");
});

test.each(["JOURNAL", "LINE", "RESET"] as const)("approved report refuses lost %s source instead of reporting profit", async (damage) => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  await seed.t.run(async (ctx) => {
    if (damage === "JOURNAL" && seed.parent.journalEntryId) await ctx.db.delete(seed.parent.journalEntryId);
    if (damage === "LINE") {
      const line = await ctx.db.query("journalLines").first();
      if (!line) throw new Error("Missing synthetic posted line");
      await ctx.db.patch(line._id, { debitMinor: line.debitMinor + 1 });
    }
    if (damage === "RESET") await ctx.db.patch(seed.orgId, { financialResetGeneration: 1, financialResetCompletedGeneration: 1 });
  });
  const before = await books(seed);
  await expect(seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.now() })).rejects.toThrow();
  expect(await books(seed)).toEqual(before);
});


test("approved report refuses a redistributed schedule even when its total is unchanged", async () => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  await seed.t.run(async (ctx) => {
    const plan = await ctx.db.get(planId);
    if (!plan || !("installments" in plan)) throw new Error("Missing synthetic management plan");
    const installments = plan.installments.map((row, index) => ({ ...row, amountMinor: row.amountMinor + (index === 0 ? 1 : index === 1 ? -1 : 0) }));
    await ctx.db.patch(planId, { installments });
  });
  await expect(seed.owner.query(report, { orgId: seed.orgId, planId, throughDate: Date.now() })).rejects.toThrow("schedule");
});


test("retained organization deletion cursor drains management proof before its opening", async () => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  const originalAllowlist = process.env.SUPER_ADMIN_EMAILS;
  process.env.SUPER_ADMIN_EMAILS = "management-admin@example.test";
  try {
    await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "management-admin", email: "management-admin@example.test" }));
    const admin = seed.t.withIdentity({ subject: "management-admin" });
    const request = await admin.mutation(api.adminOrgs.hardDeleteOrg, { orgId: seed.orgId, confirmName: "QA TEST management settlement" });
    await seed.t.run((ctx) => ctx.db.patch(request.requestId, { currentStepIndex: ORGANIZATION_DELETION_STEPS.length - 1 }));
    let completed = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await seed.t.run((ctx) => ctx.db.get(request.requestId));
      if (current?.status !== "RUNNING") { completed = current?.status === "COMPLETED"; break; }
      await seed.t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request.requestId });
    }
    expect(completed).toBe(true);
    expect(await seed.t.run((ctx) => ctx.db.get(planId))).toBeNull();
    expect(await seed.t.run((ctx) => ctx.db.get(seed.parent._id))).toBeNull();
    expect(await seed.t.run((ctx) => ctx.db.get(seed.otherOrg))).not.toBeNull();
  } finally {
    if (originalAllowlist === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = originalAllowlist;
  }
});


test("existing suspended reset continuation drains management plans and invalidates retained opening proof", async () => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  await seed.approver.mutation(approve, { orgId: seed.orgId, planId });
  await seed.t.run((ctx) => ctx.db.patch(seed.orgId, { suspended: true }));
  const result = await resetOrgToCompletion(seed.t, seed.orgId, 100);
  expect(result.remaining).toBe(0);
  expect(await seed.t.run((ctx) => ctx.db.get(planId))).toBeNull();
  // Existing reset preserves historical opening drafts but removes their journal basis.
  await seed.t.run((ctx) => ctx.db.patch(seed.orgId, { suspended: false }));
  await expect(seed.owner.mutation(draft, { ...seed.args, idempotencyKey: "after-reset" })).rejects.toThrow("opening basis");
  expect(await seed.t.run((ctx) => ctx.db.get(seed.otherOrg))).not.toBeNull();
});


test("generic allowlisted administration cannot rewrite or delete the immutable management plan", async () => {
  const seed = await fixture();
  const planId = await seed.owner.mutation(draft, seed.args);
  const originalAllowlist = process.env.SUPER_ADMIN_EMAILS;
  process.env.SUPER_ADMIN_EMAILS = "management-edit-admin@example.test";
  try {
    await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "management-edit-admin", email: "management-edit-admin@example.test" }));
    const admin = seed.t.withIdentity({ subject: "management-edit-admin" });
    const before = await seed.owner.query(list, { orgId: seed.orgId });
    await expect(admin.mutation(api.adminData.adminUpdateRecord, { table: "openingManagementSettlementPlans", id: planId, patch: { totalMinor: 1 } })).rejects.toThrow(/not a browsable admin table/i);
    await expect(admin.mutation(api.adminData.adminHardDelete, { table: "openingManagementSettlementPlans", id: planId })).rejects.toThrow(/not a browsable admin table/i);
    expect(await seed.owner.query(list, { orgId: seed.orgId })).toEqual(before);
  } finally {
    if (originalAllowlist === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = originalAllowlist;
  }
});


test("a representable first month cannot store unrepresentable later installments", async () => {
  const seed = await fixture();
  await expect(seed.owner.mutation(draft, { ...seed.args, firstEffectiveMonth: Date.UTC(275760, 7, 1) })).rejects.toThrow("date");
  expect(await seed.owner.query(list, { orgId: seed.orgId })).toEqual([]);
});
