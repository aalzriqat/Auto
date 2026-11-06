// @vitest-environment node
// SCRUM-858 slice 3 — an opening prepaid whose amount does not divide evenly by its remaining term
// (for example 70.003 JOD over 3 months at scale 3) must recognise parts that sum EXACTLY to the
// allocated amount, with the leftover minor units landing in the final month. That is the general
// schedule's convention (floor of remaining / remaining months, last month takes the remainder), and
// the opening schedule runs through the same amortisation code, so it must not drift from it.
//
// Expected months are worked by hand from that convention, not read back from the implementation:
//   70_003 / 3 -> floor 23_334, then 46_669 / 2 -> 23_334, then the last month takes 23_335.
//   10_000 / 3 -> 3_333, 3_333, 3_334.
//   5 / 4      -> 1, 1, 1, 2.
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { api, internal } from "./_generated/api";
import schema from "./schema";

async function fixture(totalMinor: number, termMonths: number) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST opening prepaid rounding", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "rounding-owner", email: "owner@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId };
  });
  const owner = t.withIdentity({ subject: "rounding-owner" });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const prepaid = accounts.find((row) => row.systemKey === "PREPAID_EXPENSES");
  const expense = accounts.find((row) => row.systemKey === "RENT_EXPENSE");
  const offset = accounts.find((row) => row.systemKey === "RETAINED_EARNINGS");
  if (!prepaid || !expense || !offset) throw new Error("Missing synthetic accounts");
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate,
    lines: [
      { accountId: prepaid._id, debitMinor: totalMinor, creditMinor: 0 },
      { accountId: offset._id, debitMinor: 0, creditMinor: totalMinor },
    ],
    allocations: [{ kind: "PREPAID_EXPENSE" as const, rowKey: "rounding-service", accountId: prepaid._id, amountMinor: totalMinor,
      title: "Synthetic unexpired service", expenseSystemKey: "RENT_EXPENSE", startYearMonth: `${year}-01`, termMonths,
      attestedUnexpiredBenefit: true }] as never });
  const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  return { t, ...ids, year, scheduleId: schedule._id, prepaidId: prepaid._id, expenseId: expense._id };
}

async function expectRemainderInFinalMonth(totalMinor: number, termMonths: number, expected: number[]) {
  const seed = await fixture(totalMinor, termMonths);
  const posted: number[] = [];
  for (let month = 0; month < termMonths; month++) {
    const result = await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
      orgId: seed.orgId, scheduleId: seed.scheduleId, yearMonth: `${seed.year}-${String(month + 1).padStart(2, "0")}`,
      occurredAt: Date.UTC(seed.year, month, 28), systemActorId: seed.ownerId,
    });
    expect(result).toMatchObject({ posted: true });
    posted.push((result as { amountMinor: number }).amountMinor);
  }
  expect(posted).toEqual(expected);
  expect(posted.reduce((sum, amount) => sum + amount, 0)).toBe(totalMinor);
  const state = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(seed.scheduleId),
    lines: await ctx.db.query("journalLines").collect(),
  }));
  expect(state.schedule).toMatchObject({ recognizedMinor: totalMinor, monthsRecognized: termMonths, status: "FULLY_AMORTIZED" });
  const net = (accountId: string) => state.lines
    .filter((line) => line.accountId === accountId)
    .reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
  // The asset is fully released and the expense carries every minor unit of it: nothing is stranded or invented.
  expect(net(seed.prepaidId)).toBe(0);
  expect(net(seed.expenseId)).toBe(totalMinor);
}

// One literally named check per case so each regression-library record can bind an exact title.
test("opening prepaid 70.003 JOD over 3 months at scale 3 recognises exactly the allocated amount, remainder in the final month", () =>
  withFrozenScheduler(() => expectRemainderInFinalMonth(70_003, 3, [23_334, 23_334, 23_335])));

test("opening prepaid 10.000 JOD over 3 months recognises exactly the allocated amount, remainder in the final month", () =>
  withFrozenScheduler(() => expectRemainderInFinalMonth(10_000, 3, [3_333, 3_333, 3_334])));

test("opening prepaid 5 minor units over 4 months recognises exactly the allocated amount, remainder in the final month", () =>
  withFrozenScheduler(() => expectRemainderInFinalMonth(5, 4, [1, 1, 1, 2])));
