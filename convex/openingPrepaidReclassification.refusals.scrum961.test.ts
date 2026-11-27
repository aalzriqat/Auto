// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import {
  approveArgs, approveReclass, bloomLines, codeOf, dismissReclass, ledgerState, requestAndPreview, requestArgs, requestReclass,
  seedPrepaidReclass, type ReclassLine, type Seed, type SeedOptions,
} from "../test-utils/prepaidReclassificationFixture";
import { api } from "./_generated/api";
import { reverseAccountingEvent } from "./accounting/reversals";
import schema from "./schema";

async function seed(options?: SeedOptions): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")), options);
}

/** The refusal must carry its exact code and leave every table it could touch byte-identical. */
async function refused(s: Seed, code: string, work: () => Promise<unknown>): Promise<void> {
  const before = await ledgerState(s);
  expect(await codeOf(work())).toBe(code);
  expect(await ledgerState(s)).toEqual(before);
}

const one = (s: Seed, amountMinor: number, userId = s.firstId): ReclassLine[] => [{ userId, amountMinor }];

test("control: the passing request differs from every refusal below in exactly one fact", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.reviewer.mutation(approveReclass, approveArgs(s, request));
}));

// ---- request refusals ----
test("request: empty lines", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, [])));
}));
test("request: duplicate person in two lines", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, [...one(s, 1000), ...one(s, 2000)])));
}));
test("request: zero amount", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, 0))));
}));
test("request: negative amount", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, -5))));
}));
test("request: fractional minor units", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, 1000.5))));
}));
test("request: NaN amount", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_LINES", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, Number.NaN))));
}));
test("request: beyond the unrecognised remainder of the schedule", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_AMOUNT", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, s.totalMinor))));
}));
test("request: blank reason", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_REASON", () => s.preparer.mutation(requestReclass, requestArgs(s, bloomLines(s), "   ")));
}));
test("request: reason over 500 characters", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_REASON", () => s.preparer.mutation(requestReclass, requestArgs(s, bloomLines(s), "x".repeat(501))));
}));
test("request: beneficiary is not an employee of the organization", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_BENEFICIARY_INVALID", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, 1000, s.outsiderId))));
}));
test("request: requester is one of the beneficiaries", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_BENEFICIARY", () => s.first.mutation(requestReclass, requestArgs(s)));
}));
test("request: requester lacks payroll authority", () => withFrozenScheduler(async () => {
  const s = await seed();
  await refused(s, "PREPAID_RECLASS_AUTHORITY", () => s.financeOnly.mutation(requestReclass, requestArgs(s)));
}));
test("request: schedule belongs to another organization", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s); // control: the same request by an authorised member succeeds
  const before = await ledgerState(s);
  expect(await codeOf(s.outsider.mutation(requestReclass, { ...requestArgs(s), orgId: s.otherOrgId }))).toBeDefined();
  expect(await ledgerState(s)).toEqual(before);
}));
test("request: caller is not a member of the named organization", () => withFrozenScheduler(async () => {
  const s = await seed();
  await requestAndPreview(s); // control: the same request by an authorised member succeeds
  const before = await ledgerState(s);
  expect(await codeOf(s.outsider.mutation(requestReclass, requestArgs(s)))).toBeDefined();
  expect(await ledgerState(s)).toEqual(before);
}));
test("request: schedule is not an opening schedule", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.t.run(async (ctx) => { await ctx.db.patch(s.scheduleId, { status: "CANCELLED" }); });
  await refused(s, "PREPAID_RECLASS_INELIGIBLE", () => s.preparer.mutation(requestReclass, requestArgs(s)));
}));
test("request: opening journal no longer verifies", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.t.run(async (ctx) => {
    const journal = (await ctx.db.query("journalEntries").collect()).find((row) => row.category === "OPENING_BALANCE");
    if (journal) await ctx.db.patch(journal._id, { status: "REVERSED" });
  });
  await refused(s, "PREPAID_RECLASS_INELIGIBLE", () => s.preparer.mutation(requestReclass, requestArgs(s)));
}));
test("request: a request for this schedule is already pending", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.preparer.mutation(requestReclass, requestArgs(s));
  await refused(s, "PREPAID_RECLASS_PENDING", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, 1000, s.secondId))));
}));
test("request: the schedule was already reclassified", () => withFrozenScheduler(async () => {
  const s = await seed();
  await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  await refused(s, "PREPAID_RECLASS_ALREADY", () => s.preparer.mutation(requestReclass, requestArgs(s, one(s, 1000, s.secondId))));
}));

// ---- approval refusals ----
test("approve: approver is the requester", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_SECOND_PERSON", () => s.preparer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: approver is a beneficiary", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_BENEFICIARY", () => s.first.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: approver lacks payroll authority", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_AUTHORITY", () => s.financeOnly.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: approver confirmed a different total", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_FIGURES", () => s.reviewer.mutation(approveReclass, { ...approveArgs(s, request), expectedTotalMinor: 619_999 }));
}));
test("approve: approver confirmed a different true-up", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_FIGURES", () => s.reviewer.mutation(approveReclass, { ...approveArgs(s, request), expectedTrueUpMinor: request.expectedTrueUpMinor + 1 }));
}));
test("approve: the schedule recognised another month after the request, so the true-up changed", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.recognize(1);
  await refused(s, "PREPAID_RECLASS_FIGURES", () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: request was already approved", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  await refused(s, "PREPAID_RECLASS_STATE", () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: request was dismissed", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.preparer.mutation(dismissReclass, { orgId: s.orgId, reclassificationId: request.reclassificationId });
  await refused(s, "PREPAID_RECLASS_STATE", () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: the posting period is closed", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.t.run(async (ctx) => { await ctx.db.patch(s.period._id, { status: "CLOSED" }); });
  await refused(s, "PREPAID_RECLASS_PERIOD", () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: a beneficiary left the organization after the request", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").collect()).find((row) => row.userId === s.secondId);
    if (membership) await ctx.db.delete(membership._id);
  });
  await refused(s, "PREPAID_RECLASS_BENEFICIARY_INVALID", () => s.reviewer.mutation(approveReclass, approveArgs(s, request)));
}));
test("approve: the request names a request id from another organization", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  const before = await ledgerState(s);
  expect(await codeOf(s.outsider.mutation(approveReclass, { ...approveArgs(s, request), orgId: s.otherOrgId }))).toBeDefined();
  expect(await ledgerState(s)).toEqual(before);
}));

// ---- dismissal refusals ----
test("dismiss: request was already approved", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await s.reviewer.mutation(approveReclass, approveArgs(s, request));
  await refused(s, "PREPAID_RECLASS_STATE", () => s.preparer.mutation(dismissReclass, { orgId: s.orgId, reclassificationId: request.reclassificationId }));
}));
test("dismiss: caller lacks payroll authority", () => withFrozenScheduler(async () => {
  const s = await seed();
  const request = await requestAndPreview(s);
  await refused(s, "PREPAID_RECLASS_AUTHORITY", () => s.financeOnly.mutation(dismissReclass, { orgId: s.orgId, reclassificationId: request.reclassificationId }));
}));

// ---- generic reversal and the marker ----
test("reversal: the generic reversal path refuses the event with its own code", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { eventId } = await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  const event = await s.t.run((ctx) => ctx.db.get(eventId));
  expect(event?.eventType).toBe("PREPAID_RECLASSIFIED_TO_ADVANCES");
  await refused(s, "PREPAID_RECLASS_REVERSAL", () => s.t.run((ctx) => reverseAccountingEvent(ctx, {
    orgId: s.orgId, originalEventId: eventId, reversalDate: Date.now(), reason: "undo", actorId: s.ownerId, idempotencyKey: "reverse-prepaid-reclass",
  })));
}));
test("recovery: removing the reclassification marker from an advance does not make it ordinary", () => withFrozenScheduler(async () => {
  const s = await seed();
  const { advanceIds } = await s.reviewer.mutation(approveReclass, approveArgs(s, await requestAndPreview(s)));
  const advanceId = advanceIds[0];
  if (!advanceId) throw new Error("Missing advance");
  await s.t.run(async (ctx) => { await ctx.db.patch(advanceId, { prepaidReclassificationId: undefined } as never); });
  const before = await ledgerState(s);
  await expect(s.owner.mutation(api.payroll.recoverAdvance, { orgId: s.orgId, advanceId, amount: 1, method: "CASH", idempotencyKey: "s961-unmarked" }))
    .rejects.toThrow(/cannot be verified/);
  expect(await ledgerState(s)).toEqual(before);
}));
