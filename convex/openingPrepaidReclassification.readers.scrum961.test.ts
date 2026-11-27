// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { approveArgs, approveReclass, requestAndPreview, seedPrepaidReclass, type Seed } from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import { computePrepaidRecognitionShortfall } from "./accountingReports";
import { cronRecognizedMinor } from "./accounting/prepaidReclassification";
import schema from "./schema";

/**
 * SCRUM-961 follow-up, item 3. After the approval, and after every later cron month to the end of the schedule, the
 * shortfall reader, the prepaid reconciliation and the GL must agree exactly, for every term, every number of months
 * already recognised and totals that do not divide evenly.
 */
const TOTALS = [1_200_007, 7_000_001, 1_000_003];
const SHARES = [{ name: "a third", pick: (remaining: number) => Math.floor(remaining / 3) }, { name: "just over half", pick: (remaining: number) => Math.floor(remaining / 2) + 1 }];

async function glBalance(s: Seed, systemKey: string): Promise<number> {
  const accountId = s.account(systemKey);
  const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
  return lines.filter((line) => line.accountId === accountId).reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
}

async function expectReadersAgree(s: Seed, asOf: number, label: string) {
  const schedule = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  if (!schedule) throw new Error("Missing schedule");
  const shortfall = await s.t.run((ctx) => computePrepaidRecognitionShortfall(ctx, s.orgId, asOf));
  expect({ label, hasShortfall: shortfall.hasShortfall }).toEqual({ label, hasShortfall: false });
  const reconciliation = await s.owner.query(api.accountingReports.prepaidExpensesReconciliation, { orgId: s.orgId });
  expect({ label, reconciled: reconciliation.isReconciled, difference: reconciliation.byCurrency.JOD?.discrepancyMinor ?? 0 })
    .toEqual({ label, reconciled: true, difference: 0 });
  expect({ label, prepaidGl: await glBalance(s, "PREPAID_EXPENSES") }).toEqual({ label, prepaidGl: schedule.totalMinor - schedule.recognizedMinor });
}

test.each(Array.from({ length: 12 }, (_, index) => index + 1))("term %i: shortfall, reconciliation and GL agree after approval and after every later month", (term) => withFrozenScheduler(async () => {
  await import("./accountingOutbox");
  for (const totalMinor of TOTALS) {
    for (let months = 0; months < term; months++) {
      for (const share of SHARES) {
        const remaining = totalMinor - cronRecognizedMinor(totalMinor, term, months);
        const reclass = share.pick(remaining);
        if (reclass < 1 || reclass >= remaining) continue;
        const label = `T=${totalMinor} n=${term} m=${months} R=${reclass} (${share.name})`;
        const s = await seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), { totalMinor, termMonths: term, recognizedMonths: months });
        const request = await requestAndPreview(s, [{ userId: s.firstId, amountMinor: reclass }]);
        await s.reviewer.mutation(approveReclass, approveArgs(s, request));
        const endOf = (index: number) => Date.UTC(s.year, index + 1, 0, 23, 59, 59, 999);
        await expectReadersAgree(s, endOf(months - 1), `${label} after approval`);
        for (let index = months; index < term; index++) {
          await s.recognize(index);
          await expectReadersAgree(s, endOf(index), `${label} after month ${index + 1}`);
        }
        const done = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
        expect({ label, total: done?.totalMinor, recognized: done?.recognizedMinor, status: done?.status })
          .toEqual({ label, total: totalMinor - reclass, recognized: totalMinor - reclass, status: "FULLY_AMORTIZED" });
        expect({ label, prepaidGl: await glBalance(s, "PREPAID_EXPENSES"), expense: await glBalance(s, "GENERAL_EXPENSE") })
          .toEqual({ label, prepaidGl: 0, expense: totalMinor - reclass });
      }
    }
  }
}), 600_000);
