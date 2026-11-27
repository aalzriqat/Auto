// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveReclass, dismissReclass, previewReclass, reclassStatus, requestAndPreview, requestArgs, requestReclass, seedPrepaidReclass, ledgerState,
  codeOf, type Seed,
} from "../test-utils/prepaidReclassificationFixture";
import schema from "./schema";

/**
 * Row ownership, and nothing else: the caller is fully authorised (finance and payroll management) in ANOTHER
 * organization and names that organization, so the permission check passes and only `requireOwnedRow` can refuse the
 * foreign schedule or request id. The refusal is the helper's generic "not found" message: it is the same for a missing
 * and a foreign row, so it does not reveal that the row exists. Each refusal leaves every reclassification table and the
 * ledger byte-identical.
 */
async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}

const NOT_FOUND = /^UNCODED:.*Record not found in this organization\./;

async function refusedAsForeign(s: Seed, work: () => Promise<unknown>): Promise<void> {
  const before = await ledgerState(s);
  expect(await codeOf(work())).toMatch(NOT_FOUND);
  expect(await ledgerState(s)).toEqual(before);
}

test("ownership: a fully authorised member of another organization cannot request against this organization's schedule", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s); // control: an authorised member of this organization succeeds on the same ids
  await refusedAsForeign(s, () => s.crossOrgAdmin.mutation(requestReclass, { ...requestArgs(s), orgId: s.otherOrgId }));
}));

test("ownership: a fully authorised member of another organization cannot approve this organization's request", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refusedAsForeign(s, () => s.crossOrgAdmin.mutation(approveReclass, { orgId: s.otherOrgId, reclassificationId: request.reclassificationId,
    expectedTotalMinor: 620_000, expectedTrueUpMinor: 103_333 }));
}));

test("ownership: a fully authorised member of another organization cannot dismiss this organization's request", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refusedAsForeign(s, () => s.crossOrgAdmin.mutation(dismissReclass, { orgId: s.otherOrgId, reclassificationId: request.reclassificationId }));
}));

test("ownership: a fully authorised member of another organization cannot preview this organization's schedule", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refusedAsForeign(s, () => s.crossOrgAdmin.query(previewReclass, { orgId: s.otherOrgId, scheduleId: s.scheduleId, totalMinor: 1000 }));
}));

test("ownership: a fully authorised member of another organization cannot read this organization's schedule status", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refusedAsForeign(s, () => s.crossOrgAdmin.query(reclassStatus, { orgId: s.otherOrgId, scheduleId: s.scheduleId }));
}));
