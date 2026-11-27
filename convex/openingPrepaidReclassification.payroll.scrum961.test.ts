// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { approveArgs, approveReclass, requestAndPreview, seedPrepaidReclass, type Seed } from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * SCRUM-961 review round 1, M1(a). The advances a reclassification creates must be recovered by the real payroll run
 * (PAYROLL_PAID posting, the outbox guard, the per-person outstanding-advance check), not only by a cash repayment.
 */
async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}
async function advanceBalance(s: Seed): Promise<number> {
  const accountId = s.account("EMPLOYEE_ADVANCES");
  const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
  return lines.filter((line) => line.accountId === accountId).reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
}
async function payrollState(s: Seed) {
  return s.t.run(async (ctx) => ({
    advances: await ctx.db.query("employeeAdvances").collect(), recoveries: await ctx.db.query("employeeAdvanceRecoveries").collect(),
    events: await ctx.db.query("accountingEvents").collect(), journals: await ctx.db.query("journalEntries").collect(),
    runs: await ctx.db.query("payrollRuns").collect(),
  }));
}
const today = () => ({ periodYear: new Date().getUTCFullYear(), periodMonth: new Date().getUTCMonth() + 1 });

test("a payroll run recovers both reclassified advances: recoveries, PAYROLL_PAID and the advances account all agree", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  for (const userId of [s.firstId, s.secondId]) await s.owner.mutation(api.payroll.setCompensation, { orgId: s.orgId, userId, monthlySalary: 1000 });
  const runId = await s.owner.mutation(api.payroll.createRun, { orgId: s.orgId, ...today() });
  await s.owner.mutation(api.payroll.approveRun, { orgId: s.orgId, runId });
  const items = await s.owner.query(api.payroll.listRunItems, { orgId: s.orgId, runId });
  expect(items.map((item) => [item.userId, item.advanceDeductionMinor]).sort()).toEqual([[s.firstId, 470_000], [s.secondId, 150_000]].sort());
  await s.owner.mutation(api.payroll.payRun, { orgId: s.orgId, runId, method: "CASH" });
  const after = await payrollState(s);
  expect(after.advances.map((row) => [row.userId, row.recoveredMinor, row.status]).sort())
    .toEqual([[s.firstId, 470_000, "RECOVERED"], [s.secondId, 150_000, "RECOVERED"]].sort());
  expect(after.recoveries.map((row) => [row.source, row.amountMinor]).sort()).toEqual([["PAYROLL", 150_000], ["PAYROLL", 470_000]]);
  // One payment posting per employee on the run, each clearing that person's own advance.
  expect(after.events.filter((row) => row.eventType === "PAYROLL_PAID")).toHaveLength(2);
  expect(await advanceBalance(s)).toBe(0);
  await expect(s.owner.mutation(api.payroll.payRun, { orgId: s.orgId, runId, method: "CASH" })).rejects.toThrow("Only an approved payroll run can be paid");
  expect(await payrollState(s)).toEqual(after);
}));

test("a reclassified advance whose marker was stripped cannot be recovered by payroll, and the run writes nothing", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { advanceIds } = await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  const [stripped] = advanceIds;
  if (!stripped) throw new Error("Missing advance");
  await s.t.run((ctx) => ctx.db.patch(stripped, { prepaidReclassificationId: undefined } as never));
  for (const userId of [s.firstId, s.secondId]) await s.owner.mutation(api.payroll.setCompensation, { orgId: s.orgId, userId, monthlySalary: 1000 });
  const before = await payrollState(s);
  await expect((async () => {
    const runId = await s.owner.mutation(api.payroll.createRun, { orgId: s.orgId, ...today() });
    await s.owner.mutation(api.payroll.approveRun, { orgId: s.orgId, runId });
    await s.owner.mutation(api.payroll.payRun, { orgId: s.orgId, runId, method: "CASH" });
  })()).rejects.toThrow("The opening advance basis cannot be verified");
  const after = await payrollState(s);
  expect(after.advances).toEqual(before.advances);
  expect(after.recoveries).toEqual([]);
  expect(await advanceBalance(s)).toBe(620_000);
}));