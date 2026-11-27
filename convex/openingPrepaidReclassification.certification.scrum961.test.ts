// @vitest-environment node
// SCRUM-961 certification rows. Each row calls the public door through the generated `api` reference, which is what the
// SCRUM-795 door inventory and the SCRUM-486 matrix bind to. The money detail lives in the other SCRUM-961 test files.
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { bloomLines, requestArgs, seedPrepaidReclass } from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import schema from "./schema";

async function seed() {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}

test("moves 620 JOD of opening prepaid into two employee advances and trues up the recognised month", () => withFrozenScheduler(async () => {
  const s = await seed();
  const preview = await s.reviewer.query(api.openingPrepaidReclassification.previewPrepaidReclassification, { orgId: s.orgId, scheduleId: s.scheduleId, totalMinor: 620_000 });
  const { reclassificationId } = await s.preparer.mutation(api.openingPrepaidReclassification.requestPrepaidReclassification, requestArgs(s, bloomLines(s)));
  expect(preview).toEqual({ ok: true, newTotalMinor: 7_128_000, newRecognizedMinor: 1_188_000, trueUpMinor: 103_333,
    remainingMonths: 5, regularMonthlyMinor: 1_188_000, finalMonthlyMinor: 1_188_000 });
  const result = await s.reviewer.mutation(api.openingPrepaidReclassification.approvePrepaidReclassification,
    { orgId: s.orgId, reclassificationId, expectedTotalMinor: 620_000, expectedTrueUpMinor: 103_333 });
  expect(result.trueUpMinor).toBe(103_333);
  expect(result.advanceIds).toHaveLength(2);
}));

test("a pending reclassification request can be dismissed and writes no journal", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { reclassificationId } = await s.preparer.mutation(api.openingPrepaidReclassification.requestPrepaidReclassification, requestArgs(s, bloomLines(s)));
  await s.reviewer.mutation(api.openingPrepaidReclassification.dismissPrepaidReclassification, { orgId: s.orgId, reclassificationId });
  const row = await s.t.run((ctx) => ctx.db.get(reclassificationId));
  expect(row?.status).toBe("DISMISSED");
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(events.filter((event) => event.eventType === "PREPAID_RECLASSIFIED_TO_ADVANCES")).toHaveLength(0);
}));
