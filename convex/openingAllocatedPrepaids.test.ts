// @vitest-environment node
import { expect, test } from "vitest";
import type { FunctionArgs } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { settleOutbox, withFrozenScheduler } from "../test-utils/outboxWork";
import { api, internal } from "./_generated/api";
import { cancelPrepaidScheduleForExpense, catchUpPrepaidSchedule, createPrepaidScheduleForExpense } from "./prepaidExpenses";
import schema from "./schema";

// Synthetic amounts and the offset account establish only test arithmetic.
// They do not classify any actual dealer opening or authorize a balancing plug.
async function fixture(openingMonth = 0, openingYear = new Date().getUTCFullYear(), periodMonths = 12 - openingMonth) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST allocated prepaid", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "opening-prepaid-owner", email: "owner@example.test" });
    const approverId = await ctx.db.insert("users", { clerkId: "opening-prepaid-approver", email: "approver@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeRoleId = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId: financeRoleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId };
  });
  const owner = t.withIdentity({ subject: "opening-prepaid-owner" });
  const approver = t.withIdentity({ subject: "opening-prepaid-approver" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = openingYear;
  const asOfDate = Date.UTC(year, openingMonth, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, openingMonth + periodMonths, 0, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const period = (await owner.query(api.accountingPeriods.list, { orgId: ids.orgId }))[0];
  if (!period) throw new Error("Missing synthetic opening period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const prepaid = accounts.find((row) => row.systemKey === "PREPAID_EXPENSES");
  const offset = accounts.find((row) => row.systemKey === "RETAINED_EARNINGS");
  if (!prepaid || !offset) throw new Error("Missing synthetic control accounts");
  const allocation = { kind: "PREPAID_EXPENSE" as const, rowKey: "unexpired-service-a", accountId: prepaid._id,
    amountMinor: 100_001, title: "Synthetic unexpired service A", expenseSystemKey: "RENT_EXPENSE",
    startYearMonth: `${year}-${String(openingMonth + 1).padStart(2, "0")}`, termMonths: 3,
    attestedUnexpiredBenefit: true };
  // Before the new public validator exists this cast keeps the test typecheckable;
  // the public mutation's runtime validator must initially reject it.
  type Allocations = NonNullable<FunctionArgs<typeof api.accountingCutover.postOpeningBalanceDirect>["allocations"]>;
  const payload = { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate,
    lines: [{ accountId: prepaid._id, debitMinor: allocation.amountMinor, creditMinor: 0 },
      { accountId: offset._id, debitMinor: 0, creditMinor: allocation.amountMinor }],
    allocations: [allocation] as unknown as Allocations };
  return { t, owner, approver, ...ids, asOfDate, payload };
}

test("named attested unexpired opening creates one native prepaid asset and schedule without a fake expense", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const state = await seed.t.run(async (ctx) => ({
    drafts: await ctx.db.query("openingBalanceDrafts").collect(),
    schedules: await ctx.db.query("prepaidExpenseSchedules").collect(),
    expenses: await ctx.db.query("expenses").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
  }));
  expect(state.drafts).toHaveLength(1);
  expect(state.journals).toHaveLength(1);
  expect(state.schedules).toHaveLength(1);
  expect(state.schedules[0]).toMatchObject({ orgId: seed.orgId, currency: "JOD", totalMinor: 100_001,
    termMonths: 3, startYearMonth: `${new Date(seed.asOfDate).getUTCFullYear()}-01`, expenseSystemKey: "RENT_EXPENSE" });
  expect(state.expenses).toHaveLength(0);
  expect(state.events.filter((event) => event.eventType === "EXPENSE_POSTED")).toHaveLength(0);
  expect(state.lines).toHaveLength(2);
}));

test("independent review posts the same native prepaid asset and exposes its verified readback", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const [pending] = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(pending?.allocationDetails).toEqual(expect.arrayContaining([expect.objectContaining({
    kind: "PREPAID_EXPENSE", rowKey: "unexpired-service-a", partyName: "Synthetic unexpired service A",
    amountMinor: 100_001, termMonths: 3, attestedUnexpiredBenefit: true,
  })]));
  if (!pending) throw new Error("Missing pending synthetic prepaid opening");
  await seed.approver.mutation(api.accountingCutover.approveOpeningBalance, {
    orgId: seed.orgId, draftId: pending._id,
  });
  const readback = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(readback?.rows).toEqual([expect.objectContaining({ kind: "PREPAID_EXPENSE", rowKey: "unexpired-service-a",
    partyName: "Synthetic unexpired service A", recordAvailable: true })]);
  const state = await seed.t.run(async (ctx) => ({
    schedules: await ctx.db.query("prepaidExpenseSchedules").collect(),
    expenses: await ctx.db.query("expenses").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(state.schedules).toHaveLength(1);
  expect(state.expenses).toHaveLength(0);
  expect(state.journals).toHaveLength(1);
}));

test("opening prepaid releases native fair-share expense once without an EXPENSE_POSTED source", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const before = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!before) throw new Error("Missing synthetic opening schedule");
  const month = `${new Date(seed.asOfDate).getUTCFullYear()}-01`;
  const args = { orgId: seed.orgId, scheduleId: before._id, yearMonth: month,
    occurredAt: seed.asOfDate, systemActorId: seed.ownerId };
  expect(await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, args))
    .toMatchObject({ posted: true, amountMinor: 33_333 });
  const after = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(before._id),
    events: await ctx.db.query("accountingEvents").collect(),
    lines: await ctx.db.query("journalLines").collect(),
  }));
  expect(after.schedule).toMatchObject({ recognizedMinor: 33_333, monthsRecognized: 1, lastRecognizedYearMonth: month });
  expect(after.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED" && event.status === "POSTED")).toHaveLength(1);
  expect(after.events.filter((event) => event.eventType === "EXPENSE_POSTED")).toHaveLength(0);
  expect(after.lines.filter((line) => line.accountingDate === seed.asOfDate && line.creditMinor === 33_333)).toHaveLength(1);
  expect(await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, args))
    .toMatchObject({ posted: false });
}));

test("opening prepaid correction doors refuse before an idempotency identity or financial write", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const before = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.query("prepaidExpenseSchedules").unique(),
    corrections: await ctx.db.query("prepaidScheduleCorrections").collect(),
    requests: await ctx.db.query("prepaidCorrectionRequests").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  if (!before.schedule) throw new Error("Missing synthetic opening schedule");
  for (const [change, inputs] of [
    ["refund", { refundMinor: 1, refundPaymentMethod: "CASH" as const }],
    ["writeoff", { writeOffMinor: 1 }],
    ["term", { newTermMonths: 2 }],
  ] as const) {
    await expect(seed.owner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId: seed.orgId, scheduleId: before.schedule._id, reason: `Synthetic ${change}`,
      idempotencyKey: `opening-prepaid-${change}`, ...inputs,
    })).rejects.toThrow("separate finance review");
  }
  await expect(seed.owner.query(api.prepaidExpenses.listRefundBankOptions, {
    orgId: seed.orgId, scheduleId: before.schedule._id,
  })).rejects.toThrow("separate finance review");
  expect(await seed.owner.query(api.prepaidExpenses.getRemainingRefundableTaxMinor, {
    orgId: seed.orgId, scheduleId: before.schedule._id,
  })).toBe(0);
  const after = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(before.schedule!._id),
    corrections: await ctx.db.query("prepaidScheduleCorrections").collect(),
    requests: await ctx.db.query("prepaidCorrectionRequests").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(after).toEqual(before);
}));

test("opening prepaid outbox holds a legacy queued write-off even with a posted asset basis", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const schedule = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  const queuedId = await seed.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", {
    orgId: seed.orgId, kind: "POST", status: "PENDING", attempts: 0,
    idempotencyKey: `prepaid_written_off_${schedule._id}_legacy`,
    eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
    sourceId: `${schedule._id}_legacy`, eventVersion: 1,
    accountingDate: seed.asOfDate, occurredAt: seed.asOfDate, currency: "JOD",
    actorId: seed.ownerId, createdAt: Date.now(),
    payload: { scheduleId: String(schedule._id), amountMinor: 1, currency: "JOD", expenseSystemKey: "RENT_EXPENSE" },
  }));
  await settleOutbox(seed.t, seed.orgId);
  const after = await seed.t.run(async (ctx) => ({
    queued: await ctx.db.get(queuedId),
    journals: await ctx.db.query("journalEntries").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
  }));
  expect(after.queued).toMatchObject({ status: "PENDING", attempts: 0 });
  expect(after.queued?.lastError).toMatch(/opening prepaid refunds and write-offs require a separate finance review/i);
  expect(after.journals).toHaveLength(1);
  expect(after.events.filter((event) => event.eventType === "PREPAID_EXPENSE_WRITTEN_OFF")).toHaveLength(0);
}));

test("generic ledger reversal refuses an opening prepaid recognition before writes", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const schedule = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  const month = `${new Date(seed.asOfDate).getUTCFullYear()}-01`;
  await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
    orgId: seed.orgId, scheduleId: schedule._id, yearMonth: month,
    occurredAt: seed.asOfDate, systemActorId: seed.ownerId,
  });
  const before = await seed.t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
  }));
  const amortization = before.events.find((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED");
  if (!amortization) throw new Error("Missing synthetic opening recognition event");
  await expect(seed.owner.mutation(internal.accountingLedger.reverse, {
    orgId: seed.orgId, originalEventId: amortization._id, reversalDate: seed.asOfDate,
    reason: "Synthetic forbidden reversal", idempotencyKey: "opening-prepaid-generic-reverse",
  })).rejects.toThrow("separate finance review");
  const after = await seed.t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
  }));
  expect(after).toEqual(before);
}));

test("a stale maker-checker request cannot correct an opening prepaid after approval", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const before = await seed.t.run(async (ctx) => {
    const schedule = await ctx.db.query("prepaidExpenseSchedules").unique();
    if (!schedule) throw new Error("Missing synthetic opening schedule");
    const makerId = await ctx.db.insert("users", { clerkId: "opening-prepaid-maker", email: "maker@example.test" });
    const requestId = await ctx.db.insert("prepaidCorrectionRequests", {
      orgId: seed.orgId, scheduleId: schedule._id, refundMinor: 0, writeOffMinor: 1,
      newTermMonths: schedule.termMonths, reason: "Synthetic stale request", status: "PENDING",
      requestedBy: makerId, createdAt: Date.now(),
    });
    return { schedule, requestId, events: await ctx.db.query("accountingEvents").collect(),
      journals: await ctx.db.query("journalEntries").collect() };
  });
  await expect(seed.owner.mutation(api.prepaidExpenses.approveCorrectionRequest, {
    orgId: seed.orgId, requestId: before.requestId,
  })).rejects.toThrow("separate finance review");
  const after = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(before.schedule._id),
    request: await ctx.db.get(before.requestId),
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(after.schedule).toEqual(before.schedule);
  expect(after.request).toMatchObject({ status: "PENDING" });
  expect(after.events).toEqual(before.events);
  expect(after.journals).toEqual(before.journals);
}));

test("lost immutable opening result blocks catch-up without clearing the source failure", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const before = await seed.t.run(async (ctx) => {
    const schedule = await ctx.db.query("prepaidExpenseSchedules").unique();
    const draft = await ctx.db.query("openingBalanceDrafts").unique();
    if (!schedule || !draft) throw new Error("Missing synthetic opening basis");
    await ctx.db.patch(draft._id, { allocationResults: [] });
    return { schedule, events: await ctx.db.query("accountingEvents").collect(),
      journals: await ctx.db.query("journalEntries").collect() };
  });
  const month = `${new Date(seed.asOfDate).getUTCFullYear()}-01`;
  expect(await seed.t.run((ctx) => catchUpPrepaidSchedule(ctx, before.schedule, {
    throughYearMonth: month, now: seed.asOfDate, systemActorId: seed.ownerId,
  }))).toEqual({ monthsPosted: 0, stoppedReason: "source_unavailable" });
  const after = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(before.schedule._id),
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(after.schedule).toEqual(before.schedule);
  expect(after.events).toEqual(before.events);
  expect(after.journals).toEqual(before.journals);
}));

test("stripping the opening marker cannot downgrade a posted opening schedule into a legacy expense", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const { scheduleId, fakeExpenseId } = await seed.t.run(async (ctx) => {
    const schedule = await ctx.db.query("prepaidExpenseSchedules").unique();
    if (!schedule) throw new Error("Missing synthetic opening schedule");
    const fakeExpenseId = await ctx.db.insert("expenses", {
      orgId: seed.orgId, title: "Synthetic unrelated expense", amount: 1,
      date: seed.asOfDate, category: "RENT",
    });
    await ctx.db.replace(schedule._id, {
      orgId: seed.orgId, expenseId: fakeExpenseId, currency: schedule.currency,
      totalMinor: schedule.totalMinor, termMonths: schedule.termMonths,
      expenseSystemKey: schedule.expenseSystemKey, startYearMonth: schedule.startYearMonth,
      recognizedMinor: schedule.recognizedMinor, monthsRecognized: schedule.monthsRecognized,
      lastRecognizedYearMonth: schedule.lastRecognizedYearMonth, status: schedule.status,
      createdAt: schedule.createdAt,
    });
    return { scheduleId: schedule._id, fakeExpenseId };
  });
  const month = `${new Date(seed.asOfDate).getUTCFullYear()}-01`;
  expect(await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
    orgId: seed.orgId, scheduleId, yearMonth: month,
    occurredAt: seed.asOfDate, systemActorId: seed.ownerId,
  })).toEqual({ posted: false, reason: "source_unavailable" });
  const state = await seed.t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(state.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED")).toHaveLength(0);
  expect(state.journals).toHaveLength(1);
  await expect(seed.t.run((ctx) => cancelPrepaidScheduleForExpense(ctx, seed.orgId, fakeExpenseId)))
    .rejects.toThrow("source");
  await expect(seed.t.run((ctx) => createPrepaidScheduleForExpense(ctx, {
    orgId: seed.orgId, expenseId: fakeExpenseId, currency: "JOD", totalMinor: 1,
    termMonths: 1, expenseSystemKey: "RENT_EXPENSE", startDate: seed.asOfDate,
  }))).rejects.toThrow("source");
}));

test("future-dated opening basis cannot recognize or report catch-up success today", async () => withFrozenScheduler(async () => {
  const now = new Date();
  const nextMonth = (now.getUTCMonth() + 1) % 12;
  const nextYear = now.getUTCFullYear() + (nextMonth === 0 ? 1 : 0);
  const seed = await fixture(nextMonth, nextYear);
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const schedule = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  const target = schedule.startYearMonth;
  expect(await seed.t.run((ctx) => catchUpPrepaidSchedule(ctx, schedule, {
    throughYearMonth: target, now: Date.now(), systemActorId: seed.ownerId,
  }))).toEqual({ monthsPosted: 0, stoppedReason: "opening_basis_in_future" });
  const state = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(schedule._id),
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(state.schedule).toEqual(schedule);
  expect(state.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED")).toHaveLength(0);
  expect(state.journals).toHaveLength(1);
}));

test("prepaid opening rejects invented, expired or mismatched allocation data before writes", async () => withFrozenScheduler(async () => {
  const seed = await fixture(1);
  type Allocations = NonNullable<FunctionArgs<typeof api.accountingCutover.postOpeningBalanceDirect>["allocations"]>;
  const basis = seed.payload.allocations[0];
  for (const patch of [
    { attestedUnexpiredBenefit: false }, { title: " " },
    { startYearMonth: `${new Date(seed.asOfDate).getUTCFullYear()}-01` },
    { termMonths: 0 }, { expenseSystemKey: "SALES_REVENUE" },
    { amountMinor: 100_000 },
  ]) {
    await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      ...seed.payload, allocations: [{ ...basis, ...patch }] as unknown as Allocations,
    })).rejects.toThrow();
  }
  const state = await seed.t.run(async (ctx) => ({
    drafts: await ctx.db.query("openingBalanceDrafts").collect(),
    schedules: await ctx.db.query("prepaidExpenseSchedules").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(state).toEqual({ drafts: [], schedules: [], events: [], journals: [] });
}));

test("a queued later-month opening recognition posts only after its period opens", async () => withFrozenScheduler(async () => {
  const seed = await fixture(0, new Date().getUTCFullYear(), 1);
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const schedule = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  const year = new Date(seed.asOfDate).getUTCFullYear();
  const january = { orgId: seed.orgId, scheduleId: schedule._id, yearMonth: `${year}-01`,
    occurredAt: seed.asOfDate, systemActorId: seed.ownerId };
  expect(await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, january))
    .toMatchObject({ posted: true, amountMinor: 33_333 });
  const february = { ...january, yearMonth: `${year}-02`, occurredAt: Date.UTC(year, 1, 28) };
  expect(await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, february))
    .toMatchObject({ posted: true, amountMinor: 33_334 });
  const queued = await seed.t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(queued.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED" && event.status === "POSTED")).toHaveLength(1);
  expect(queued.pending.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED" && event.status === "PENDING")).toHaveLength(1);
  expect(queued.journals).toHaveLength(2);
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId,
    startDate: Date.UTC(year, 1, 1), endDate: Date.UTC(year, 2, 0, 23, 59, 59, 999),
    fiscalYear: year, periodNumber: 2 });
  const periods = await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId });
  const februaryPeriod = periods.find((period) => period.periodNumber === 2);
  if (!februaryPeriod) throw new Error("Missing synthetic February period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: februaryPeriod._id });
  await settleOutbox(seed.t, seed.orgId);
  const posted = await seed.t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  expect(posted.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED" && event.status === "POSTED")).toHaveLength(2);
  expect(posted.pending.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED" && event.status === "PENDING")).toHaveLength(0);
  expect(posted.journals).toHaveLength(3);
}));

test("an already-running financial reset leaves no spendable or clean-looking opening prepaid", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const schedule = await seed.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic posted opening schedule");
  await seed.t.run((ctx) => ctx.db.patch(seed.orgId, {
    suspended: true, financialResetGeneration: 1, financialResetCompletedGeneration: 0,
  }));
  let remaining = 1;
  for (let pass = 0; pass < 10 && remaining > 0; pass++) {
    const result = await seed.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId: seed.orgId, dryRun: false, batchSize: 100,
    });
    remaining = result.remaining;
  }
  expect(remaining).toBe(0);
  await seed.t.run((ctx) => ctx.db.patch(seed.orgId, { suspended: false }));
  const result = await seed.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
    orgId: seed.orgId, scheduleId: schedule._id, yearMonth: schedule.startYearMonth,
    occurredAt: seed.asOfDate, systemActorId: seed.ownerId,
  });
  expect(result).toEqual({ posted: false, reason: "source_unavailable" });
  const after = await seed.t.run(async (ctx) => ({
    schedule: await ctx.db.get(schedule._id),
    drafts: await ctx.db.query("openingBalanceDrafts").collect(),
    journals: await ctx.db.query("journalEntries").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
  }));
  expect(after.schedule).toEqual(schedule);
  expect(after.drafts).toHaveLength(1);
  expect(after.journals).toHaveLength(0);
  expect(after.events.filter((event) => event.eventType === "PREPAID_EXPENSE_AMORTIZED")).toHaveLength(0);
  const listed = await seed.owner.query(api.prepaidExpenses.listSchedules, { orgId: seed.orgId });
  expect(listed).toMatchObject([{ sourceKind: "UNAVAILABLE", correctionAllowed: false,
    remainingMinor: null, dueMinor: null }]);
  const status = await seed.owner.query(api.accountingCutover.openingBalanceStatus, { orgId: seed.orgId });
  expect(status.posted).toBe(false);
  await seed.owner.mutation(api.chartOfAccounts.initialize, { orgId: seed.orgId });
  const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true });
  const prepaid = accounts.find((account) => account.systemKey === "PREPAID_EXPENSES");
  const offset = accounts.find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!prepaid || !offset) throw new Error("Missing synthetic reset chart controls");
  type Allocations = NonNullable<FunctionArgs<typeof api.accountingCutover.postOpeningBalanceDirect>["allocations"]>;
  const replacement = { ...seed.payload,
    lines: [{ accountId: prepaid._id, debitMinor: 100_001, creditMinor: 0 },
      { accountId: offset._id, debitMinor: 0, creditMinor: 100_001 }],
    allocations: [{ ...seed.payload.allocations[0], accountId: prepaid._id }] as unknown as Allocations,
  };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, replacement))
    .rejects.toThrow("Existing prepaid schedules require a finance review");
}));
