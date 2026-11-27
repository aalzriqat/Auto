// @vitest-environment node
import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, codeOf, ledgerState, requestAndPreview, seedPrepaidReclass, type Seed, type SeedOptions,
} from "../test-utils/prepaidReclassificationFixture";
import schema from "./schema";

/**
 * SCRUM-961 coordinator follow-up. I12: the approval date and every recognition event being trued up must sit in the same
 * OPEN period. I14: a queued, failed, reversed or unreconciled recognition blocks the command. Each refusal test differs
 * from its passing twin in exactly one fact and must leave every table byte-identical.
 */
async function seed(options?: SeedOptions): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), options);
}

/** Runs `body` with the wall clock fixed, so "now" can sit on either side of a period boundary. */
async function atClock<T>(now: number, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now });
  try { return await body(); } finally { vi.useRealTimers(); }
}

async function refused(s: Seed, code: string, work: () => Promise<unknown>): Promise<void> {
  const before = await ledgerState(s);
  expect(await codeOf(work())).toBe(code);
  expect(await ledgerState(s)).toEqual(before);
}

// P1 = January to March, P2 = April to December; January is recognised in P1.
const SPLIT: SeedOptions = { splitAtMonth: 3 };
const inP1 = (s: Seed) => Date.UTC(s.year, 2, 31, 23, 59, 59, 999);
const inP2 = (s: Seed) => Date.UTC(s.year, 3, 1, 0, 0, 0, 0);

async function approveAt(s: Seed, now: number) {
  const request = await requestAndPreview(s);
  return atClock(now, () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}

// ---- I12: one open period for the approval and all recognition being trued up ----
test("I12: recognition in P1, approval in P2 is refused with a code and nothing is written", () => withFrozenScheduler(async () => {
  const s = await seed(SPLIT);
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_CROSS_PERIOD", () => atClock(Date.UTC(s.year, 5, 15), () => s.reviewer.mutation(approveReclass, approveArgs(s, request))));
}));
test("I12 twin: recognition and approval both in P1 posts, dated at the approval instant", () => withFrozenScheduler(async () => {
  const s = await seed(SPLIT);
  const result = await approveAt(s, inP1(s));
  expect(result.trueUpMinor).toBe(103_333);
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(events.find((row) => row.eventType === "PREPAID_RECLASSIFIED_TO_ADVANCES")?.accountingDate).toBe(inP1(s));
  const advances = await s.t.run((ctx) => ctx.db.query("employeeAdvances").collect());
  expect(advances.every((row) => row.date === inP1(s))).toBe(true);
}));
test("I12 boundary: the first millisecond of P2 is refused; the last millisecond of P1 posts (one clock read decides both)", () => withFrozenScheduler(async () => {
  const s = await seed(SPLIT);
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_CROSS_PERIOD", () => atClock(inP2(s), () => s.reviewer.mutation(approveReclass, approveArgs(s, request))));
  await atClock(inP1(s), () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("I12: the recognition period closed after posting, approval in open P2, is refused", () => withFrozenScheduler(async () => {
  const s = await seed(SPLIT);
  const request = await requestAndPreview(s);
  const first = s.periods.find((row) => row.startDate === s.asOfDate);
  if (!first) throw new Error("Missing P1");
  await s.t.run(async (ctx) => { await ctx.db.patch(first._id, { status: "CLOSED" }); });
  await refused(s, "PREPAID_RECLASS_CROSS_PERIOD", () => atClock(inP2(s), () => s.reviewer.mutation(approveReclass, approveArgs(s, request))));
}));
test("I12: with nothing recognised yet there is no true-up, so any open period posts and the journal has two lines", () => withFrozenScheduler(async () => {
  const s = await seed({ ...SPLIT, recognizedMonths: 0 });
  const result = await approveAt(s, inP2(s));
  expect(result.trueUpMinor).toBe(0);
  const lines = (await s.t.run((ctx) => ctx.db.query("journalLines").collect())).filter((line) => line.journalEntryId === result.journalEntryId);
  expect(lines.map((line) => [line.debitMinor, line.creditMinor]).sort()).toEqual([[0, 620_000], [620_000, 0]]);
}));

// ---- I14: recognition must be settled ----
async function amortizationEvent(s: Seed) {
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  const event = events.find((row) => row.eventType === "PREPAID_EXPENSE_AMORTIZED");
  if (!event) throw new Error("Missing amortization event");
  return event;
}
async function queue(s: Seed, status: "PENDING" | "POSTED" | "FAILED") {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("pendingAccountingEvents", { orgId: s.orgId, kind: "POST", status, idempotencyKey: `prepaid_amort_${s.scheduleId}_${s.month(1)}`,
      accountingDate: Date.UTC(s.year, 1, 28), actorId: s.ownerId, attempts: 0, createdAt: Date.now(),
      sourceType: "prepaidExpenseSchedules", sourceId: `prepaid_amort_${s.scheduleId}_${s.month(1)}` });
  });
}
async function approveBare(s: Seed) {
  const request = await requestAndPreview(s);
  return () => s.reviewer.mutation(approveReclass, approveArgs(s, request));
}

test("I14 twin: a POSTED outbox row for the schedule does not block", () => withFrozenScheduler(async () => {
  const s = await seed();
  await queue(s, "POSTED");
  const result = await (await approveBare(s))();
  expect(result.trueUpMinor).toBeGreaterThan(0);
  const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(events.some((row) => row.eventType === "PREPAID_RECLASSIFIED_TO_ADVANCES" && row._id === result.eventId)).toBe(true);
}));
test("I14: a PENDING outbox row for the schedule blocks", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  await queue(s, "PENDING");
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
}));
test("I14: a FAILED outbox row for the schedule blocks", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  await queue(s, "FAILED");
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
}));
test("I14: an open amortisation failure blocks; the same failure resolved does not", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  const failureId = await s.t.run((ctx) => ctx.db.insert("prepaidAmortizationFailures",
    { orgId: s.orgId, scheduleId: s.scheduleId, yearMonth: s.month(1), errorMessage: "synthetic", createdAt: Date.now() }));
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
  await s.t.run((ctx) => ctx.db.patch(failureId, { resolvedAt: Date.now() }));
  await approve();
}));
test("I14: posted amortisation that does not add up to the schedule's recognised amount blocks", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  const event = await amortizationEvent(s);
  await s.t.run((ctx) => ctx.db.patch(event._id, { payload: { ...(event.payload as object), amountMinor: (event.payload as { amountMinor: number }).amountMinor + 1 } }));
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
}));
test("I14: a posted amortisation count that differs from months recognised blocks", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  const event = await amortizationEvent(s);
  const { _id, _creationTime, ...rest } = event;
  void _id; void _creationTime;
  const key = `prepaid_amort_${s.scheduleId}_${s.month(1)}`;
  await s.t.run((ctx) => ctx.db.insert("accountingEvents", { ...rest, idempotencyKey: key, sourceId: key,
    payload: { ...(event.payload as object), amountMinor: 0, yearMonth: s.month(1) } }));
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
}));
test("I14: a reversed amortisation event blocks", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  const event = await amortizationEvent(s);
  await s.t.run((ctx) => ctx.db.patch(event._id, { status: "REVERSED" }));
  await refused(s, "PREPAID_RECLASS_RECOGNITION", approve);
}));

// ---- (c) a beneficiary offboarded after the request ----
test("approve: a beneficiary whose offboarding has started is refused and nothing is written", () => withFrozenScheduler(async () => {
  const s = await seed();
  const approve = await approveBare(s);
  await s.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").collect()).find((row) => row.userId === s.secondId);
    if (membership) await ctx.db.patch(membership._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
  });
  await refused(s, "PREPAID_RECLASS_BENEFICIARY_INVALID", approve);
}));
