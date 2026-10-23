// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hookPrepaidExpenseAmortized } from "./accounting/workflowHooks";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
import { computePrepaidRecognitionShortfall } from "./accountingReports";

// Public opening plus native recognition-hook reader seam; this does not run
// the cron/amortizer or classify any real showroom costs.
async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST opening prepaid consumers", createdAt: Date.now() });
    const actorId = await ctx.db.insert("users", { clerkId: "prepaid-consumer-owner", email: "owner@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: actorId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, actorId };
  });
  const owner = t.withIdentity({ subject: "prepaid-consumer-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const openingDate = Date.UTC(year, 0, 1);
  const recognitionDate = Date.UTC(year, 0, 20);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: openingDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const period = (await owner.query(api.accountingPeriods.list, { orgId: ids.orgId }))[0];
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const prepaid = accounts.find((a) => a.systemKey === "PREPAID_EXPENSES");
  const offset = accounts.find((a) => a.systemKey === "RETAINED_EARNINGS");
  if (!prepaid || !offset) throw new Error("Missing synthetic accounts");
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId: ids.orgId, expectedCurrency: "JOD", asOfDate: openingDate,
    lines: [{ accountId: prepaid._id, debitMinor: 120_000, creditMinor: 0 },
      { accountId: offset._id, debitMinor: 0, creditMinor: 120_000 }],
    allocations: [{ kind: "PREPAID_EXPENSE", rowKey: "reader-service", accountId: prepaid._id,
      amountMinor: 120_000, title: "Synthetic unexpired service", expenseSystemKey: "RENT_EXPENSE",
      startYearMonth: `${year}-01`, termMonths: 3, attestedUnexpiredBenefit: true }],
  });
  const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing native opening schedule");
  await t.run(async (ctx) => {
    await ctx.db.patch(schedule._id, { recognizedMinor: 40_000, monthsRecognized: 1, lastRecognizedYearMonth: `${year}-01` });
    await hookPrepaidExpenseAmortized(ctx, { orgId: ids.orgId, scheduleId: schedule._id, yearMonth: `${year}-01`,
      amountMinor: 40_000, currency: "JOD", expenseSystemKey: "RENT_EXPENSE", actorId: ids.actorId, occurredAt: recognitionDate });
  });
  const opening = { scheduleId: schedule._id, journalId: await t.run(async (ctx) =>
    (await ctx.db.query("openingBalanceDrafts").unique())?.journalEntryId) };
  expect(await t.run((ctx) => resolvePrepaidScheduleSource(ctx, ids.orgId, opening.scheduleId))).toMatchObject({ kind: "OPENING" });
  return { t, owner, ...ids, ...opening, openingDate, recognitionDate, endDate: Date.UTC(year, 0, 31, 23, 59, 59, 999) };
}

test("opening recognition without an expense appears once in operational and GL P&L", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  expect(await seed.t.run((ctx) => ctx.db.query("expenses").collect())).toEqual([]);
  const report = await seed.owner.query(api.reports.getExpensesReport, { orgId: seed.orgId, startDate: seed.openingDate, endDate: seed.endDate });
  const gl = await seed.owner.query(api.accountingReports.incomeStatement, { orgId: seed.orgId, fromDate: seed.openingDate, toDate: seed.endDate });
  expect(report.totalExpenses).toBe(40);
  expect(report.totalPosted).toBe(40);
  expect(report.expenses).toEqual([expect.objectContaining({ sourceKind: "OPENING", _id: seed.scheduleId,
    title: "Synthetic unexpired service", recognizedAmount: 40, postedAmount: 40 })]);
  expect(gl.totalExpenses).toBe(40_000);
  const profit = await seed.owner.query(api.reports.getProfitAndLoss, { orgId: seed.orgId,
    startDate: seed.openingDate, endDate: seed.endDate });
  expect(profit.operatingExpenses).toBe(40);
  expect(profit.netProfit).toBe(-40);
  const diagnostic = await seed.t.query(internal.diagnosePrepaidLedgerIntegrity.surveyPrepaidLedgerIntegrity, {});
  expect(diagnostic.findings).toEqual([]);
}));


test("corrupt opening basis is unavailable to reports, reconciliation, close checks and diagnostic", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run(async (ctx) => {
    if (!seed.journalId) throw new Error("Missing opening journal");
    await ctx.db.patch(seed.journalId, { status: "REVERSED" });
  });
  await expect(seed.owner.query(api.reports.getExpensesReport, { orgId: seed.orgId,
    startDate: seed.openingDate, endDate: seed.endDate })).rejects.toThrow("prepaid asset source cannot be verified");
  await expect(seed.owner.query(api.accountingReports.prepaidExpensesReconciliation, { orgId: seed.orgId }))
    .rejects.toThrow("prepaid asset source cannot be verified");
  await expect(seed.t.run((ctx) => computePrepaidRecognitionShortfall(ctx, seed.orgId, seed.endDate)))
    .rejects.toThrow("prepaid asset source cannot be verified");
  const diagnostic = await seed.t.query(internal.diagnosePrepaidLedgerIntegrity.surveyPrepaidLedgerIntegrity, {});
  expect(diagnostic.sourcesAvailable).toBe(false);
  expect(diagnostic.unavailableSources).toEqual([expect.objectContaining({ scheduleId: seed.scheduleId })]);
}));


test("a source without recognition events cannot produce a complete clean diagnostic", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run(async (ctx) => {
    for (const event of await ctx.db.query("accountingEvents").collect()) await ctx.db.delete(event._id);
    if (!seed.journalId) throw new Error("Missing opening journal");
    await ctx.db.patch(seed.journalId, { status: "REVERSED" });
  });
  const page = await seed.t.query(internal.diagnosePrepaidLedgerIntegrity.surveyPrepaidLedgerIntegrity, {});
  expect(page.findings).toEqual([]);
  expect(page.sourcesAvailable).toBe(false);
  expect(page.unavailableSources).toEqual([expect.objectContaining({ scheduleId: seed.scheduleId })]);
  const survey = await seed.t.action(internal.diagnosePrepaidLedgerIntegrity.runPrepaidLedgerIntegritySurvey, {});
  expect(survey).toMatchObject({ complete: false, surveyComplete: true, sourcesAvailable: false });
}));
