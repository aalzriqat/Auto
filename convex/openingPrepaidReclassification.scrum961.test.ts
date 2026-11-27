// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, bloomLines, ledgerState, reclassStatus, requestAndPreview, requestArgs, requestReclass,
  seedPrepaidReclass, type SeedOptions,
} from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import schema from "./schema";

async function seed(options?: SeedOptions) {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), options);
}

async function gl(s: Awaited<ReturnType<typeof seed>>, systemKey: string): Promise<number> {
  const accountId = s.account(systemKey);
  const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
  return lines.filter((line) => line.accountId === accountId).reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
}

async function approveBloom(s: Awaited<ReturnType<typeof seed>>) {
  const request = await requestAndPreview(s);
  const result = await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  return { request, result };
}

test("Bloom fixture: 620 JOD leaves prepaid for two per-person advances and the recognised month is trued up", () => withFrozenScheduler(async () => {
  const s = await seed();
  const cash = await gl(s, "CASH_ON_HAND");
  const { request, result } = await approveBloom(s);
  // 7,748.000 over 6 months recognised 1,291.333 in month one; on 7,128.000 it is 1,188.000, so 103.333 is returned to expense.
  expect(request.expectedTrueUpMinor).toBe(103_333);
  expect(result.trueUpMinor).toBe(103_333);
  expect(result.advanceIds).toHaveLength(2);
  const lines = (await s.t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", result.journalEntryId)).collect()))
    .map((line) => ({ account: line.accountId, debit: line.debitMinor, credit: line.creditMinor }));
  expect(lines).toHaveLength(3);
  expect(lines).toEqual(expect.arrayContaining([
    { account: s.account("EMPLOYEE_ADVANCES"), debit: 620_000, credit: 0 },
    { account: s.account("PREPAID_EXPENSES"), debit: 0, credit: 516_667 },
    { account: s.account("GENERAL_EXPENSE"), debit: 0, credit: 103_333 },
  ]));
  expect(await gl(s, "CASH_ON_HAND")).toBe(cash);
  expect(await gl(s, "PREPAID_EXPENSES")).toBe(7_748_000 - 1_291_333 - 516_667);
  expect(await gl(s, "EMPLOYEE_ADVANCES")).toBe(620_000);
  const advances = await s.t.run((ctx) => ctx.db.query("employeeAdvances").collect());
  expect(advances.map((row) => [row.userId, row.amountMinor, row.recoveredMinor, row.status]).sort())
    .toEqual([[s.firstId, 470_000, 0, "OUTSTANDING"], [s.secondId, 150_000, 0, "OUTSTANDING"]].sort());
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(events.filter((row) => row.eventType === "PREPAID_RECLASSIFIED_TO_ADVANCES")).toHaveLength(1);
  const audit = await s.t.run((ctx) => ctx.db.query("financialAuditLog").collect());
  expect(audit.map((row) => row.actionType)).toEqual(expect.arrayContaining(["PREPAID_RECLASS_REQUESTED", "PREPAID_RECLASS_APPROVED"]));
}));

test("readers after approval: prepaid reconciles with no shortfall, advances reconcile AVAILABLE, schedule figures and next month are exact", () => withFrozenScheduler(async () => {
  const s = await seed();
  await approveBloom(s);
  const prepaid = await s.owner.query(api.accountingReports.prepaidExpensesReconciliation, { orgId: s.orgId });
  expect(prepaid.isReconciled).toBe(true);
  expect(prepaid.byCurrency.JOD?.discrepancyMinor).toBe(0);
  const advances = await s.owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId: s.orgId });
  expect(advances.status).toBe("AVAILABLE");
  expect(advances.isReconciled).toBe(true);
  expect(advances.byCurrency.JOD?.glBalanceMinor).toBe(620_000);
  const [schedule] = await s.owner.query(api.prepaidExpenses.listSchedules, { orgId: s.orgId });
  expect(schedule).toMatchObject({ totalMinor: 7_128_000, recognizedMinor: 1_188_000, monthsRecognized: 1 });
  await s.recognize(1);
  const after = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect(after?.recognizedMinor).toBe(1_188_000 + 1_188_000);
  const status = await s.owner.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(status.approved?.totalMinor).toBe(620_000);
  expect(status.reclassifiedMinor).toBe(620_000);
}));

test("a reclassified advance is recovered through payroll end to end", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { result } = await approveBloom(s);
  const advanceId = result.advanceIds[0];
  if (!advanceId) throw new Error("Missing reclassified advance");
  const row = await s.t.run((ctx) => ctx.db.get(advanceId));
  const major = (row?.amountMinor ?? 0) / 1000;
  await s.owner.mutation(api.payroll.recoverAdvance, { orgId: s.orgId, advanceId, amount: major, method: "CASH", idempotencyKey: "s961-recover" });
  const recovered = await s.t.run((ctx) => ctx.db.get(advanceId));
  expect(recovered).toMatchObject({ recoveredMinor: row?.amountMinor, status: "RECOVERED" });
  expect(await gl(s, "EMPLOYEE_ADVANCES")).toBe(620_000 - (row?.amountMinor ?? 0));
}));

const TABLE: Array<{ name: string; options: SeedOptions; reclass: number; total: number; recognized: number; trueUp: number; next: number }> = [
  { name: "Bloom, term 6, one month", options: {}, reclass: 620_000, total: 7_128_000, recognized: 1_188_000, trueUp: 103_333, next: 1_188_000 },
  { name: "non-dividing, term 7, one month", options: { totalMinor: 1_000_000, termMonths: 7 }, reclass: 100_000, total: 900_000, recognized: 128_571, trueUp: 14_286, next: 128_571 },
  { name: "term 6, two months", options: { totalMinor: 1_200_000, recognizedMonths: 2 }, reclass: 120_000, total: 1_080_000, recognized: 360_000, trueUp: 40_000, next: 180_000 },
  { name: "non-dividing, term 12, three months", options: { totalMinor: 1_000_003, termMonths: 12, recognizedMonths: 3 }, reclass: 100_003, total: 900_000, recognized: 225_000, trueUp: 24_999, next: 75_000 },
];

test.each(TABLE)("numeric table: $name", ({ options, reclass, total, recognized, trueUp, next }) => withFrozenScheduler(async () => {
  const s = await seed(options);
  const lines = [{ userId: s.firstId, amountMinor: reclass }];
  const request = await requestAndPreview(s, lines);
  expect(request.expectedTrueUpMinor).toBe(trueUp);
  await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  const schedule = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect(schedule).toMatchObject({ totalMinor: total, recognizedMinor: recognized });
  await s.recognize(schedule?.monthsRecognized ?? 0);
  const afterNext = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect((afterNext?.recognizedMinor ?? 0) - recognized).toBe(next);
}));

test.each(Array.from({ length: 12 }, (_, index) => index + 1))("term %i: after the reclassification every remaining month recognises exactly the new total", (term) => withFrozenScheduler(async () => {
  const s = await seed({ totalMinor: 1_200_007, termMonths: term, recognizedMonths: 0 });
  const request = await requestAndPreview(s, [{ userId: s.firstId, amountMinor: 100_003 }]);
  expect(request.expectedTrueUpMinor).toBe(0);
  await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  for (let index = 0; index < term; index++) await s.recognize(index);
  const schedule = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect(schedule).toMatchObject({ totalMinor: 1_100_004, recognizedMinor: 1_100_004, status: "FULLY_AMORTIZED" });
  expect(await gl(s, "PREPAID_EXPENSES")).toBe(0);
}));

test("dismissal is available to the requester and nothing but the request row is written", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  const before = await ledgerState(s);
  await s.preparer.mutation((await import("../test-utils/prepaidReclassificationFixture")).dismissReclass, { orgId: s.orgId, reclassificationId: request.reclassificationId });
  const after = await ledgerState(s);
  for (const table of ["journalEntries", "journalLines", "accountingEvents", "employeeAdvances", "prepaidExpenseSchedules"] as const) expect(after[table]).toEqual(before[table]);
  expect((await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId })).pending).toBeNull();
  // A new request is possible again after a dismissal.
  await s.preparer.mutation(requestReclass, requestArgs(s, bloomLines(s)));
}));
