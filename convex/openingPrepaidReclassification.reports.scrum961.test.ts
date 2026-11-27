// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { approveArgs, approveReclass, requestAndPreview, seedPrepaidReclass, type Seed, type SeedOptions } from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * SCRUM-961 review round 1, B1/B2. Invariant: after an approval, every reader of recognised prepaid expense agrees with
 * the general ledger. The ledger gives the true-up back as a credit to the expense account on the approval date, so the
 * operational expense report, the operational profit and loss and the schedule list must give it back in the same month.
 */
const JOD = 1000;

async function seed(options?: SeedOptions): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), options);
}

type Window = { label: string; from: number; to: number };

async function approvalMonth(s: Seed): Promise<Window> {
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  const date = events.find((row) => row.eventType === "PREPAID_RECLASSIFIED_TO_ADVANCES")?.accountingDate;
  if (date === undefined) throw new Error("Missing reclassification event");
  const at = new Date(date);
  return { label: "approval month", from: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1), to: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0, 23, 59, 59, 999) };
}

function windows(s: Seed): Window[] {
  return [
    { label: "whole year", from: Date.UTC(s.year, 0, 1), to: Date.UTC(s.year, 11, 31, 23, 59, 59, 999) },
    { label: "January", from: Date.UTC(s.year, 0, 1), to: Date.UTC(s.year, 0, 31, 23, 59, 59, 999) },
  ];
}

/** The ledger's expense for the window against the three operational readers, to the minor unit. */
async function expectReadersMatchLedger(s: Seed, window: Window) {
  const ledger = await s.owner.query(api.accountingReports.incomeStatement, { orgId: s.orgId, fromDate: window.from, toDate: window.to });
  const expected = ledger.totalExpenses / JOD;
  const expenses = await s.owner.query(api.reports.getExpensesReport, { orgId: s.orgId, startDate: window.from, endDate: window.to });
  const profit = await s.owner.query(api.reports.getProfitAndLoss, { orgId: s.orgId, startDate: window.from, endDate: window.to });
  if (!expenses || !profit) throw new Error("report withheld");
  expect({ window: window.label, expenseReport: expenses.totalExpenses }).toEqual({ window: window.label, expenseReport: expect.closeTo(expected, 6) });
  expect({ window: window.label, expenseReportPosted: expenses.totalPosted }).toEqual({ window: window.label, expenseReportPosted: expect.closeTo(expected, 6) });
  expect({ window: window.label, profitAndLoss: profit.operatingExpenses }).toEqual({ window: window.label, profitAndLoss: expect.closeTo(expected, 6) });
}

async function expectRowSelfConsistent(s: Seed) {
  const schedule = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  if (!schedule) throw new Error("Missing schedule");
  const [whole] = windows(s);
  const report = await s.owner.query(api.reports.getExpensesReport, { orgId: s.orgId, startDate: whole.from, endDate: whole.to });
  const row = report?.expenses.find((candidate) => candidate._id === s.scheduleId);
  if (!row) throw new Error("Missing opening row");
  expect(row.amount).toBeCloseTo(schedule.totalMinor / JOD, 6);
  expect(row.amortization?.recognizedToDateAmount ?? Number.NaN).toBeCloseTo(schedule.recognizedMinor / JOD, 6);
  expect(row.recognizedAmount).toBeCloseTo(schedule.recognizedMinor / JOD, 6);
}

test("Bloom: after approval the expense report and the profit and loss equal the ledger, and the row agrees with itself", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  const result = await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  expect(result.trueUpMinor).toBe(103_333);
  for (const window of [...windows(s), await approvalMonth(s)]) await expectReadersMatchLedger(s, window);
  await expectRowSelfConsistent(s);
}));

test("Bloom: through the last month the readers still equal the ledger and the schedule is not over-recognised", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  for (let index = 1; index < s.termMonths; index++) await s.recognize(index);
  const done = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect([done?.status, done?.totalMinor, done?.recognizedMinor]).toEqual(["FULLY_AMORTIZED", 7_128_000, 7_128_000]);
  for (const window of windows(s)) await expectReadersMatchLedger(s, window);
  await expectRowSelfConsistent(s);
  const whole = windows(s)[0];
  const profit = await s.owner.query(api.reports.getProfitAndLoss, { orgId: s.orgId, startDate: whole.from, endDate: whole.to });
  expect(profit?.operatingExpenses).toBeCloseTo(7_128, 6);
}));

test("twin with nothing to true up: the same readers equal the ledger", () => withFrozenScheduler(async () => {
  const s = await seed({ recognizedMonths: 0 });
  const result = await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  expect(result.trueUpMinor).toBe(0);
  for (let index = 0; index < s.termMonths; index++) await s.recognize(index);
  for (const window of windows(s)) await expectReadersMatchLedger(s, window);
  await expectRowSelfConsistent(s);
}));

test("the schedule list's posted amortisation is net of the true-up, so it equals the recognised figure it sits beside", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  const rows = await s.owner.query(api.prepaidExpenses.listSchedules, { orgId: s.orgId });
  const row = rows.find((candidate) => candidate._id === s.scheduleId);
  expect([row?.recognizedMinor, row?.postedMinor]).toEqual([1_188_000, 1_188_000]);
}));
