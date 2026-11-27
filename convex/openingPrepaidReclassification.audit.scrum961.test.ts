// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, dismissReclass, requestAndPreview, requestArgs, requestReclass, seedPrepaidReclass, type Seed,
} from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * SCRUM-961 review round 1, H2. The request names people and their advance amounts and carries a free-text reason. The
 * audit log must show those only to a reader who could read them in the reclassification screen itself (finance and
 * payroll management); everyone else sees a withheld row. A payroll viewer can already list advances, but not the reason.
 */
async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}
const ACTIONS = ["REQUEST_PREPAID_RECLASSIFICATION", "APPROVE_PREPAID_RECLASSIFICATION", "DISMISS_PREPAID_RECLASSIFICATION"] as const;

async function produceAllThree(s: Seed) {
  const dismissed = await s.preparer.mutation(requestReclass, requestArgs(s, undefined, "Reason to dismiss"));
  await s.reviewer.mutation(dismissReclass, { orgId: s.orgId, reclassificationId: dismissed.reclassificationId as never });
  await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
}
const rowsFor = (s: Seed, reader: Seed["owner"]) => reader.query(api.financialAudit.listAuditLog, { orgId: s.orgId, limit: 200 })
  .then((rows) => rows.filter((row) => (ACTIONS as readonly string[]).includes(row.actionType)));

test("a reader with finance management and payroll viewing, but not payroll management, gets withheld rows with no lines or reason", () => withFrozenScheduler(async () => {
  const s = await seed();
  await produceAllThree(s);
  const rows = await rowsFor(s, s.payrollViewer);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row).toMatchObject({ detailsWithheld: true, resourceId: "WITHHELD" });
    expect(JSON.stringify(row)).not.toMatch(/amountMinor|Reason to dismiss|Employee advances recorded/);
  }
}));

test("twin: a payroll manager and the owner read the same rows in full", () => withFrozenScheduler(async () => {
  const s = await seed();
  await produceAllThree(s);
  for (const reader of [s.preparer, s.owner]) {
    const rows = await rowsFor(s, reader);
    expect(rows.every((row) => row.detailsWithheld !== true)).toBe(true);
    const request = rows.find((row) => row.actionType === "REQUEST_PREPAID_RECLASSIFICATION");
    expect(JSON.stringify(request?.after)).toContain("amountMinor");
  }
}));

test("a finance manager with no payroll authority at all gets withheld rows too", () => withFrozenScheduler(async () => {
  const s = await seed();
  await produceAllThree(s);
  const rows = await rowsFor(s, s.financeOnly);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.detailsWithheld === true)).toBe(true);
}));