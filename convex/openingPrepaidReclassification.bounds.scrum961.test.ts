// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, codeOf, reclassStatus, requestAndPreview, requestArgs, requestReclass, seedPrepaidReclass, type Seed,
} from "../test-utils/prepaidReclassificationFixture";
import type { Id } from "./_generated/dataModel";
import { RECLASS_READ_BOUND } from "./accounting/prepaidReclassification";
import schema from "./schema";
import { reclassifiedAdvanceBasis, verifiedReclassification } from "./utils/prepaidReclassificationProof";

/**
 * SCRUM-961 coordinator follow-up 3. Convex's `.take(n)` returns the first n rows and says nothing when more exist, so a
 * bounded read that came back full could hide the very row that decides the answer. Every such read fails closed: a
 * result of RECLASS_READ_BOUND rows is "not provable". Each test seeds exactly the bound (real rows, no injection) and
 * has a twin one row short that behaves normally, so the bound is the only difference.
 */
const BOUND = RECLASS_READ_BOUND;
async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

async function outboxRows(s: Seed, count: number) {
  await s.t.run(async (ctx) => {
    for (const index of range(count)) {
      const key = `prepaid_amort_${s.scheduleId}_bulk${index}`;
      await ctx.db.insert("pendingAccountingEvents", { orgId: s.orgId, kind: "POST", status: "POSTED", idempotencyKey: key,
        accountingDate: Date.UTC(s.year, 1, 28), actorId: s.ownerId, attempts: 0, createdAt: Date.now(), sourceType: "prepaidExpenseSchedules", sourceId: key });
    }
  });
}
async function failureRows(s: Seed, count: number) {
  await s.t.run(async (ctx) => {
    for (const index of range(count)) {
      await ctx.db.insert("prepaidAmortizationFailures", { orgId: s.orgId, scheduleId: s.scheduleId, yearMonth: `old-${index}`, errorMessage: "resolved", createdAt: 1, resolvedAt: 2 });
    }
  });
}
async function eventRows(s: Seed, count: number) {
  await s.t.run(async (ctx) => {
    for (const index of range(count)) {
      const key = `prepaid_amort_${s.scheduleId}_other${index}`;
      await ctx.db.insert("accountingEvents", { orgId: s.orgId, eventType: "UNRELATED_EVENT", sourceType: "test", sourceId: key, eventVersion: 1,
        idempotencyKey: key, occurredAt: 1, accountingDate: 1, currency: "JOD", payload: {}, status: "POSTED", createdBy: s.ownerId, createdAt: 1 });
    }
  });
}
async function dismissedRows(s: Seed, count: number) {
  await s.t.run(async (ctx) => {
    for (const index of range(count)) {
      await ctx.db.insert("openingPrepaidReclassifications", { orgId: s.orgId, scheduleId: s.scheduleId, status: "DISMISSED",
        lines: [{ userId: s.firstId, amountMinor: 1 }], totalMinor: 1, reason: `old ${index}`, requestedBy: s.preparerId, requestedAt: 1 });
    }
  });
}
async function approve(s: Seed) {
  const request = await requestAndPreview(s);
  return () => s.reviewer.mutation(approveReclass, approveArgs(s, request));
}

// ---- recognitionSettled: three bounded reads ----
for (const [name, fill] of [["outbox entries", outboxRows], ["amortisation failures", failureRows], ["accounting events", eventRows]] as const) {
  // The seeded schedule already has one real amortisation event under the same prefix, so its twin sits two under.
  const twinCount = BOUND - (name === "accounting events" ? 2 : 1);
  test(`${name}: a full read cannot prove recognition is settled, so approval is refused`, () => withFrozenScheduler(async () => {
    const s = await seed();
    const work = await approve(s);
    await fill(s, BOUND);
    expect(await codeOf(work())).toBe("PREPAID_RECLASS_RECOGNITION");
  }));
  test(`${name} twin: one row under the bound does not block`, () => withFrozenScheduler(async () => {
    const s = await seed();
    const work = await approve(s);
    await fill(s, twinCount);
    expect(await codeOf(work())).toBeUndefined();
  }));
}

// ---- the schedule's own request rows ----
test("request rows: a full read of the schedule's rows is refused as ineligible, by request and by status", () => withFrozenScheduler(async () => {
  const s = await seed();
  await dismissedRows(s, BOUND);
  expect(await codeOf(s.preparer.mutation(requestReclass, requestArgs(s)))).toBe("PREPAID_RECLASS_INELIGIBLE");
  const status = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  expect(status).toMatchObject({ eligible: false, blockedReason: "PREPAID_RECLASS_INELIGIBLE", pending: null, approved: null });
}));
test("request rows twin: one row under the bound still requests and shows eligible", () => withFrozenScheduler(async () => {
  const s = await seed();
  await dismissedRows(s, BOUND - 1);
  expect((await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId })).eligible).toBe(true);
  expect(await codeOf(s.preparer.mutation(requestReclass, requestArgs(s)))).toBeUndefined();
}));

// ---- the proof module ----
async function approvedRow(s: Seed) {
  const result = await (await approve(s))();
  const row = await s.t.run((ctx) => ctx.db.query("openingPrepaidReclassifications").collect().then((rows) => rows.find((r) => r.status === "APPROVED")));
  if (!row) throw new Error("Missing approved row");
  return { row, result };
}
async function padJournalLines(s: Seed, journalEntryId: Id<"journalEntries">, total: number) {
  await s.t.run(async (ctx) => {
    const lines = (await ctx.db.query("journalLines").collect()).filter((line) => line.journalEntryId === journalEntryId);
    const [model] = lines;
    if (!model) throw new Error("Missing journal line");
    for (const index of range(total - lines.length)) {
      const { _id, _creationTime, ...rest } = model;
      await ctx.db.insert("journalLines", { ...rest, lineNumber: 1000 + index, debitMinor: 0, creditMinor: 0 });
    }
  });
}
test("proof: a journal whose lines fill the bound cannot be verified", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { row, result } = await approvedRow(s);
  await padJournalLines(s, result.journalEntryId, BOUND);
  expect(await s.t.run((ctx) => verifiedReclassification(ctx, s.orgId, row))).toBeNull();
}));
test("proof twin: one line under the bound still verifies", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { row, result } = await approvedRow(s);
  await padJournalLines(s, result.journalEntryId, BOUND - 1);
  expect(await s.t.run((ctx) => verifiedReclassification(ctx, s.orgId, row))).not.toBeNull();
}));

const anAdvance = (s: Seed) => s.firstId as unknown as Id<"employeeAdvances">;
test("advance basis: a full read of the organization's requests cannot clear an unmarked advance", () => withFrozenScheduler(async () => {
  const s = await seed();
  await dismissedRows(s, BOUND);
  expect(await s.t.run((ctx) => reclassifiedAdvanceBasis(ctx, s.orgId, null, anAdvance(s)))).toEqual({ kind: "INVALID" });
}));
test("advance basis twin: one request under the bound leaves an unmarked advance not reclassified", () => withFrozenScheduler(async () => {
  const s = await seed();
  await dismissedRows(s, BOUND - 1);
  expect(await s.t.run((ctx) => reclassifiedAdvanceBasis(ctx, s.orgId, null, anAdvance(s)))).toEqual({ kind: "NOT_RECLASSIFIED" });
}));