// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, bloomLines, codeOf, ledgerState, previewReclass, reclassStatus, requestAndPreview, requestArgs,
  requestReclass, seedPrepaidReclass, type Seed, type SeedOptions,
} from "../test-utils/prepaidReclassificationFixture";
import schema from "./schema";

/**
 * SCRUM-961 follow-up B and C. The approver must see what they approve, from the same function the approval compares
 * against; and a retried identical request replays instead of being refused as a second pending request.
 */
async function seed(options?: SeedOptions): Promise<Seed> {
  await import("./accountingOutbox");
  const s = await seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), options);
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.firstId, { name: "QA First" });
    await ctx.db.patch(s.secondId, { name: "QA Second" });
    await ctx.db.patch(s.preparerId, { name: "QA Preparer" });
    await ctx.db.patch(s.reviewerId, { name: "QA Reviewer" });
  });
  return s;
}

test("pending view: requester, time, reason, named lines, total and the figures the approval will compare", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  const { pending } = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  if (!pending) throw new Error("Missing pending view");
  expect(pending).toMatchObject({
    reclassificationId: request.reclassificationId, requestedByMe: false, totalMinor: 620_000, trueUpMinor: 103_333,
    reason: "Employee advances recorded inside the opening prepaid schedule",
    requestedBy: { userId: s.preparerId, name: "QA Preparer" },
  });
  expect(pending.requestedAt).toBeGreaterThan(0);
  expect(pending.lines).toEqual([{ userId: s.firstId, name: "QA First", amountMinor: 470_000 }, { userId: s.secondId, name: "QA Second", amountMinor: 150_000 }]);
  // 7,128,000 over 6 months, one recognised (1,188,000): five months of 1,188,000 remain.
  expect(pending.figures).toEqual({ ok: true, trueUpMinor: 103_333, newTotalMinor: 7_128_000, newRecognizedMinor: 1_188_000,
    remainingMonths: 5, regularMonthlyMinor: 1_188_000, finalMonthlyMinor: 1_188_000 });
}));

test("the pending figures are exactly what approval posts and what the cron then recognises, with a remainder in the last months", () => withFrozenScheduler(async () => {
  const s = await seed({ totalMinor: 1_000_003, termMonths: 12, recognizedMonths: 3 });
  const request = await requestAndPreview(s, [{ userId: s.firstId, amountMinor: 100_003 }]);
  const { pending } = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  if (pending?.figures.ok !== true) throw new Error("Missing figures");
  const figures = pending.figures;
  const result = await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  expect(result.trueUpMinor).toBe(figures.trueUpMinor);
  const after = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
  expect([after?.totalMinor, after?.recognizedMinor]).toEqual([figures.newTotalMinor, figures.newRecognizedMinor]);
  expect(figures.remainingMonths).toBe(9);
  const increments: number[] = [];
  let previous = after?.recognizedMinor ?? 0;
  for (let index = 3; index < 12; index++) {
    await s.recognize(index);
    const row = await s.t.run((ctx) => ctx.db.get(s.scheduleId));
    increments.push((row?.recognizedMinor ?? 0) - previous);
    previous = row?.recognizedMinor ?? 0;
  }
  expect(increments[0]).toBe(figures.regularMonthlyMinor);
  expect(increments[increments.length - 1]).toBe(figures.finalMonthlyMinor);
  expect(figures.finalMonthlyMinor).toBeGreaterThanOrEqual(figures.regularMonthlyMinor);
}));

test("preview returns remaining months and both monthly amounts from the same figures", () => withFrozenScheduler(async () => {
  const s = await seed({ totalMinor: 1_000_003, termMonths: 12, recognizedMonths: 3 });
  const preview = await s.preparer.query(previewReclass, { orgId: s.orgId, scheduleId: s.scheduleId, totalMinor: 100_003 });
  const request = await requestAndPreview(s, [{ userId: s.firstId, amountMinor: 100_003 }]);
  const { pending } = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(preview.ok).toBe(true);
  expect(pending?.figures).toEqual(preview);
  expect(request.expectedTrueUpMinor).toBe(preview.ok ? preview.trueUpMinor : -1);
}));

test("pending view: unsettled recognition returns the refusal code instead of figures and no true-up", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s);
  await s.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", { orgId: s.orgId, kind: "POST", status: "PENDING",
    idempotencyKey: `prepaid_amort_${s.scheduleId}_${s.month(1)}`, accountingDate: Date.UTC(s.year, 1, 28), actorId: s.ownerId, attempts: 0,
    createdAt: Date.now(), sourceType: "prepaidExpenseSchedules", sourceId: `prepaid_amort_${s.scheduleId}_${s.month(1)}` }));
  const { pending } = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(pending?.figures).toEqual({ ok: false, code: "PREPAID_RECLASS_RECOGNITION" });
  expect(pending?.trueUpMinor).toBeNull();
  expect(pending?.lines).toHaveLength(2);
}));

test("approved view: when, by whom, the journal, the lines and the true-up", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  const result = await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  const { approved } = await s.preparer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  if (!approved) throw new Error("Missing approved view");
  const journal = await s.t.run((ctx) => ctx.db.get(result.journalEntryId));
  expect(approved).toMatchObject({ reclassificationId: request.reclassificationId, totalMinor: 620_000, trueUpMinor: 103_333,
    approvedBy: { userId: s.reviewerId, name: "QA Reviewer" }, journalEntryId: result.journalEntryId, journalNumber: journal?.journalNumber,
    eventId: result.eventId, advanceIds: result.advanceIds });
  expect(approved.approvedAt).toBe(journal?.accountingDate);
  expect(approved.lines).toEqual([{ userId: s.firstId, name: "QA First", amountMinor: 470_000 }, { userId: s.secondId, name: "QA Second", amountMinor: 150_000 }]);
}));

test("names only for people who belong to this organization", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s);
  await s.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").collect()).find((row) => row.userId === s.preparerId);
    if (membership) await ctx.db.delete(membership._id);
  });
  const { pending } = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(pending?.requestedBy.name).toBe("Unknown");
  expect(JSON.stringify(pending)).not.toContain("QA Preparer");
  expect(JSON.stringify(pending)).not.toContain("example.test");
}));

test("permissions: without finance and payroll management the status carries nothing extra, and another organization is refused", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s);
  const restricted = await s.financeOnly.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(restricted).toEqual({ eligible: false, blockedReason: "PREPAID_RECLASS_AUTHORITY", reclassifiedMinor: null, pending: null, approved: null });
  expect(await codeOf(s.outsider.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId }))).toBeDefined();
  expect(await codeOf(s.financeOnly.query(previewReclass, { orgId: s.orgId, scheduleId: s.scheduleId, totalMinor: 1000 }))).toBe("PREPAID_RECLASS_AUTHORITY");
}));

// ---- C: retry safety ----
test("retry: the identical request by the same requester replays the pending id and writes nothing", () => withFrozenScheduler(async () => {
  const s = await seed();
  const first = await s.preparer.mutation(requestReclass, requestArgs(s));
  const before = await ledgerState(s);
  const replay = await s.preparer.mutation(requestReclass, requestArgs(s, [...bloomLines(s)].reverse()));
  expect(replay).toEqual(first);
  expect(await ledgerState(s)).toEqual(before);
}));
test("retry: a different amount, reason or requester still gets the pending refusal", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.preparer.mutation(requestReclass, requestArgs(s));
  const before = await ledgerState(s);
  const changed = bloomLines(s).map((line, index) => (index === 0 ? { ...line, amountMinor: line.amountMinor - 1000 } : line));
  expect(await codeOf(s.preparer.mutation(requestReclass, requestArgs(s, changed)))).toBe("PREPAID_RECLASS_PENDING");
  expect(await codeOf(s.preparer.mutation(requestReclass, requestArgs(s, bloomLines(s), "A different reason")))).toBe("PREPAID_RECLASS_PENDING");
  expect(await codeOf(s.owner.mutation(requestReclass, requestArgs(s)))).toBe("PREPAID_RECLASS_PENDING");
  expect(await ledgerState(s)).toEqual(before);
}));
test("retry: after the request was dismissed the same request creates a new one", () => withFrozenScheduler(async () => {
  const s = await seed();
  const first = await s.preparer.mutation(requestReclass, requestArgs(s));
  const { dismissReclass } = await import("../test-utils/prepaidReclassificationFixture");
  await s.preparer.mutation(dismissReclass, { orgId: s.orgId, reclassificationId: first.reclassificationId });
  const again = await s.preparer.mutation(requestReclass, requestArgs(s));
  expect(again.reclassificationId).not.toBe(first.reclassificationId);
}));
