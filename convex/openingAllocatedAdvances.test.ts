// @vitest-environment node
import { expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import schema from "./schema";

async function fixture() {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST allocated advance", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "opening-advance-owner", email: "owner@example.test" });
    const approverId = await ctx.db.insert("users", { clerkId: "opening-advance-reviewer", email: "reviewer@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "opening-advance-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance", "view:payroll", "manage:payroll"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId: financeRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: financeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId, approverId, employeeId, financeRole };
  });
  const owner = t.withIdentity({ subject: "opening-advance-owner" });
  const approver = t.withIdentity({ subject: "opening-advance-reviewer" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const period = (await owner.query(api.accountingPeriods.list, { orgId: ids.orgId }))[0];
  if (!period) throw new Error("Missing synthetic opening period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const advanceAccount = accounts.find((row) => row.systemKey === "EMPLOYEE_ADVANCES");
  const retained = accounts.find((row) => row.systemKey === "RETAINED_EARNINGS");
  if (!advanceAccount || !retained) throw new Error("Missing synthetic accounts");
  // The offset is a synthetic test input, not a classification of the real guide.
  const payload = { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate,
    lines: [{ accountId: advanceAccount._id, debitMinor: 100_000, creditMinor: 0 },
      { accountId: retained._id, debitMinor: 0, creditMinor: 100_000 }],
    allocations: [{ kind: "EMPLOYEE_ADVANCE" as const, rowKey: "historical-employee", accountId: advanceAccount._id,
      userId: ids.employeeId, amountMinor: 100_000, note: "Synthetic historical remaining debt" }] };
  await settleScheduledOnly(t, ids.orgId);
  return { t, owner, approver, ...ids, asOfDate, payload, advanceAccount };
}

test.each([false, true])("native payroll deducts the verified opening debt once (queued=%s)", async (queued) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const advance = (await state(seed)).advances[0];
  if (!advance) throw new Error("Missing synthetic opening advance");
  const today = new Date();
  const year = queued ? new Date(seed.asOfDate).getUTCFullYear() + 1 : today.getUTCFullYear();
  const month = queued ? 1 : today.getUTCMonth() + 1;
  const clock = queued ? vi.spyOn(Date, "now").mockReturnValue(Date.UTC(year, 0, 2)) : null;
  try {
    await seed.owner.mutation(api.payroll.setCompensation, { orgId: seed.orgId, userId: seed.employeeId, monthlySalary: 40 });
    const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: year, periodMonth: month });
    await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
    const items = await seed.owner.query(api.payroll.listRunItems, { orgId: seed.orgId, runId });
    const item = items.find((row) => row.userId === seed.employeeId);
    expect(item).toMatchObject({ baseSalaryMinor: 40_000, advanceDeductionMinor: 40_000, netMinor: 0 });
    await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
    if (queued) {
      expect((await state(seed)).lines).toHaveLength(2);
      await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(year, 0, 1),
        endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
      const period = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId })).find((row) => row.fiscalYear === year);
      if (!period) throw new Error("Missing synthetic payroll period");
      await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: period._id });
      await settleScheduledOnly(seed.t, seed.orgId);
    }
    const after = await state(seed);
    expect(after.advances[0]?.recoveredMinor).toBe(40_000);
    expect(after.recoveries).toHaveLength(1);
    expect(after.recoveries[0]).toMatchObject({ advanceId: advance._id, payrollItemId: item?._id, source: "PAYROLL", amountMinor: 40_000 });
    expect(after.events.map((row) => row.eventType).sort()).toEqual(["PAYROLL_ACCRUED", "PAYROLL_PAID"]);
    expect(after.lines.filter((row) => row.accountId === seed.advanceAccount._id)
      .reduce((sum, row) => sum + row.debitMinor - row.creditMinor, 0)).toBe(60_000);
    await expect(seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" }))
      .rejects.toThrow("Only an approved payroll run can be paid");
    expect(await state(seed)).toEqual(after);
  } finally { clock?.mockRestore(); }
}));

async function state(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async (ctx) => ({ advances: await ctx.db.query("employeeAdvances").collect(),
    recoveries: await ctx.db.query("employeeAdvanceRecoveries").collect(), drafts: await ctx.db.query("openingBalanceDrafts").collect(),
    journals: await ctx.db.query("journalEntries").collect(), lines: await ctx.db.query("journalLines").collect(),
    events: await ctx.db.query("accountingEvents").collect(), pending: await ctx.db.query("pendingAccountingEvents").collect(),
    commands: await ctx.db.query("commandIdempotency").collect() }));
}

test.each(["PREPARE", "APPROVE"] as const)("finance-only authority cannot %s payroll debt", async (stage) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance"] }));
  if (stage === "PREPARE") {
    const before = await state(seed);
    await expect(seed.approver.mutation(api.accountingCutover.draftOpeningBalance, seed.payload))
      .rejects.toThrow("manage:payroll");
    expect(await state(seed)).toEqual(before);
  } else {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    const draft = (await state(seed)).drafts[0];
    if (!draft) throw new Error("Missing synthetic draft");
    const before = await state(seed);
    await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id }))
      .rejects.toThrow("manage:payroll");
    expect(await state(seed)).toEqual(before);
  }
}));

test("pending payroll allocations require payroll read authority", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance"] }));
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  expect(await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId })).toEqual([]);
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance", "view:payroll"] }));
  const visible = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(visible).toHaveLength(1);
  expect(visible[0]?.allocations).toEqual(seed.payload.allocations);
}));

test("finance-only viewer gets only a generic pending state and cannot reject payroll debt by id", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance"] }));
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const draft = (await state(seed)).drafts[0];
  if (!draft) throw new Error("Missing synthetic payroll-sensitive draft");
  const status = await seed.approver.query(api.accountingCutover.openingBalanceStatus, { orgId: seed.orgId });
  expect(status).toMatchObject({ pendingExists: true, pendingDraftId: null });
  const before = await state(seed);
  await expect(seed.approver.mutation(api.accountingCutover.rejectOpeningBalanceDraft, {
    orgId: seed.orgId, draftId: draft._id, rejectionReason: "Synthetic review refusal",
  })).rejects.toThrow("manage:payroll");
  expect(await state(seed)).toEqual(before);
}));

test("payroll manager may inspect a pending opening advance without separate payroll-view grant", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance", "manage:payroll"] }));
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const visible = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(visible).toHaveLength(1);
  expect(visible[0]?.allocations).toEqual(seed.payload.allocations);
}));

test("opening entry reports existing party-view grants without widening them", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance"] }));
  expect(await seed.approver.query(api.accountingCutover.openingBalanceStatus, { orgId: seed.orgId }))
    .toMatchObject({ canSelectCustomers: false, canSelectEmployees: false, canSelectPartners: true });
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: [
    "view:finance", "manage:finance", "view:customers", "view:users", "manage:payroll",
  ] }));
  expect(await seed.approver.query(api.accountingCutover.openingBalanceStatus, { orgId: seed.orgId }))
    .toMatchObject({ canSelectCustomers: true, canSelectEmployees: true, canSelectPartners: true });
}));

test("posted opening readback withholds payroll debt from finance-only viewers", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const ownerReadback = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(ownerReadback?.rows).toEqual([expect.objectContaining({ kind: "EMPLOYEE_ADVANCE",
    amountMinor: 100_000, partyId: seed.employeeId, recordAvailable: true })]);
  await seed.t.run((ctx) => ctx.db.patch(seed.financeRole, { permissions: ["view:finance", "manage:finance"] }));
  const financeReadback = await seed.approver.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(financeReadback?.rows).toEqual([{ kind: "EMPLOYEE_ADVANCE", restricted: true }]);
  expect(JSON.stringify(financeReadback)).not.toContain(seed.employeeId);
  expect(JSON.stringify(financeReadback)).not.toContain("100000");
}));

test("pending readiness and final posting agree when operational allocations disappear", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const draft = (await state(seed)).drafts[0];
  if (!draft) throw new Error("Missing synthetic draft");
  const [ready] = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(ready?.readiness).toMatchObject({ canApprove: true, blockerCodes: [] });
  await seed.t.run((ctx) => ctx.db.patch(draft._id, { allocations: undefined }));
  const [blocked] = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(blocked?.readiness).toMatchObject({ canApprove: false, blockerCodes: ["ALLOCATIONS"] });
  const before = await state(seed);
  await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id }))
    .rejects.toThrow("must match the advance control balance");
  expect(await state(seed)).toEqual(before);
}));

test.each(["PREPARE", "APPROVE"] as const)("non-owner cannot %s their own opening debt", async (stage) => withFrozenScheduler(async () => {
  const seed = await fixture();
  const payload = { ...seed.payload, allocations: seed.payload.allocations.map((row) => ({ ...row, userId: seed.approverId })) };
  if (stage === "PREPARE") {
    const before = await state(seed);
    await expect(seed.approver.mutation(api.accountingCutover.draftOpeningBalance, payload)).rejects.toThrow("independent actor");
    expect(await state(seed)).toEqual(before);
  } else {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, payload);
    const draft = (await state(seed)).drafts[0];
    if (!draft) throw new Error("Missing synthetic self-beneficiary draft");
    const before = await state(seed);
    await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id }))
      .rejects.toThrow("independent actor");
    expect(await state(seed)).toEqual(before);
  }
}));

test.each(["PREPARE", "APPROVE"] as const)("offboarding employee cannot receive an opening advance at %s", async (stage) => withFrozenScheduler(async () => {
  const seed = await fixture();
  if (stage === "APPROVE") {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  }
  await seed.t.run(async (ctx) => {
    const membership = await ctx.db.query("memberships").withIndex("by_org_user", (q) =>
      q.eq("orgId", seed.orgId).eq("userId", seed.employeeId)).unique();
    if (!membership) throw new Error("Missing synthetic employee membership");
    await ctx.db.patch(membership._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
  });
  const before = await state(seed);
  if (stage === "PREPARE") {
    await expect(seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload))
      .rejects.toThrow("Opening employee is unavailable");
  } else {
    const draft = before.drafts[0];
    if (!draft) throw new Error("Missing synthetic opening draft");
    await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id }))
      .rejects.toThrow("Opening employee is unavailable");
  }
  expect(await state(seed)).toEqual(before);
}));

test.each(["MEMBER_LOSS", "SUM", "CREDIT", "DUPLICATE_MAPPING", "EXISTING_ADVANCE"] as const)("invalid opening advance %s refuses before financial writes", async (kind) => withFrozenScheduler(async () => {
  const seed = await fixture();
  const payload = structuredClone(seed.payload);
  let reason = "";
  if (kind === "MEMBER_LOSS") {
    await seed.t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org_user", (q) => q.eq("orgId", seed.orgId).eq("userId", seed.employeeId)).unique();
      if (!member) throw new Error("Missing synthetic employee membership");
      await ctx.db.delete(member._id);
    });
    reason = "not a member";
  } else if (kind === "SUM") {
    payload.allocations[0]!.amountMinor--;
    reason = "must match the advance control balance";
  } else if (kind === "CREDIT") {
    payload.lines = payload.lines.map((line) => ({ ...line, debitMinor: line.creditMinor, creditMinor: line.debitMinor }));
    reason = "require a debit balance";
  } else if (kind === "DUPLICATE_MAPPING") {
    const duplicate = await seed.t.run(async (ctx) => {
      const original = await ctx.db.get(seed.advanceAccount._id);
      if (!original) throw new Error("Missing synthetic mapping");
      const { _id: _originalId, _creationTime: _originalTime, ...fields } = original;
      return ctx.db.insert("chartOfAccounts", { ...fields, code: "QA-DUPLICATE-ADVANCE" });
    });
    payload.lines[0]!.accountId = duplicate;
    payload.allocations[0]!.accountId = duplicate;
    reason = "account used by native payroll";
  } else {
    await seed.t.run((ctx) => ctx.db.insert("employeeAdvances", { orgId: seed.orgId, userId: seed.employeeId,
      amountMinor: 1_000, recoveredMinor: 0, currency: "JOD", date: seed.asOfDate, status: "OUTSTANDING",
      createdBy: seed.ownerId, createdAt: Date.now(), updatedAt: Date.now() }));
    reason = "Existing advance records require a finance review";
  }
  const before = await state(seed);
  await expect(seed.owner.mutation(api.accountingCutover.draftOpeningBalance, payload)).rejects.toThrow(reason);
  expect(await state(seed)).toEqual(before);
}));

test.each(["MARKER", "AMOUNT", "DATE", "CURRENCY", "DRAFT", "JOURNAL"] as const)("tampered opening advance %s refuses before financial writes", async (kind) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const original = await state(seed);
  const advance = original.advances[0];
  const draft = original.drafts[0];
  const journal = original.journals[0];
  if (!advance || !draft || !journal) throw new Error("Missing synthetic opening provenance");
  await seed.t.run(async (ctx) => {
    if (kind === "MARKER") await ctx.db.patch(advance._id, { openingBalanceDraftId: undefined });
    if (kind === "AMOUNT") await ctx.db.patch(advance._id, { amountMinor: 100_001 });
    if (kind === "DATE") await ctx.db.patch(advance._id, { date: advance.date + 1 });
    if (kind === "CURRENCY") await ctx.db.patch(advance._id, { currency: "USD" });
    if (kind === "DRAFT") await ctx.db.patch(draft._id, { status: "REJECTED" });
    if (kind === "JOURNAL") await ctx.db.patch(journal._id, { status: "REVERSED" });
  });
  const before = await state(seed);
  await expect(seed.owner.mutation(api.payroll.recoverAdvance, { orgId: seed.orgId, advanceId: advance._id,
    amount: 40, method: "CASH", idempotencyKey: "invalid-opening-basis" })).rejects.toThrow("opening advance basis cannot be verified");
  expect(await state(seed)).toEqual(before);
}));

test.each(["employeeAdvances", "employeeAdvanceRecoveries"] as const)("raw data browser excludes %s from every mutation route", async (table) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const advance = (await state(seed)).advances[0];
  if (!advance) throw new Error("Missing synthetic advance");
  await seed.owner.mutation(api.payroll.recoverAdvance, { orgId: seed.orgId, advanceId: advance._id,
    amount: 40, method: "CASH", idempotencyKey: "admin-provenance-fixture" });
  const before = await state(seed);
  const record = table === "employeeAdvances" ? before.advances[0] : before.recoveries[0];
  if (!record) throw new Error("Missing synthetic target");
  const oldAllowlist = process.env.SUPER_ADMIN_EMAILS;
  process.env.SUPER_ADMIN_EMAILS = "owner@example.test";
  try {
    await expect(seed.owner.mutation(api.adminData.adminUpdateRecord, { table, id: record._id,
      patch: { amountMinor: 1 } })).rejects.toThrow("not a browsable admin table");
    await expect(seed.owner.mutation(api.adminData.adminRestoreRecords, { table, ids: [record._id] })).rejects.toThrow("not a browsable admin table");
    await expect(seed.owner.mutation(api.adminData.adminHardDelete, { table, id: record._id })).rejects.toThrow("not a browsable admin table");
    expect(await state(seed)).toEqual(before);
  } finally {
    if (oldAllowlist === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = oldAllowlist;
  }
}));

test.each(["DIRECT", "TWO_PERSON"] as const)("%s opening advance has one asset basis and native repayment without historical cash issuance", async (route) => withFrozenScheduler(async () => {
  const seed = await fixture();
  if (route === "DIRECT") {
    await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  } else {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    const draft = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
    if (!draft) throw new Error("Missing synthetic draft");
    await seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id });
  }
  const advance = (await seed.owner.query(api.payroll.listAdvances, { orgId: seed.orgId, onlyOutstanding: true }))[0];
  expect(advance).toMatchObject({ userId: seed.employeeId, amountMinor: 100_000, recoveredMinor: 0,
    currency: "JOD", date: seed.asOfDate });
  expect(advance?.method).toBeUndefined();
  expect(advance?.bankAccountId).toBeUndefined();
  expect(await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect())).toEqual([]);
  expect(await seed.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).toEqual([]);
  const before = await seed.t.run((ctx) => ctx.db.query("journalLines").collect());
  expect(before).toHaveLength(2);
  if (!advance) throw new Error("Opening advance not materialized");
  const args = { orgId: seed.orgId, advanceId: advance._id, amount: 40, method: "CASH" as const,
    idempotencyKey: "opening-advance-partial" };
  await seed.owner.mutation(api.payroll.recoverAdvance, args);
  await seed.owner.mutation(api.payroll.recoverAdvance, args);
  const readback = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(readback?.rows).toEqual([expect.objectContaining({ kind: "EMPLOYEE_ADVANCE",
    amountMinor: 100_000, documentId: advance._id, recordAvailable: true })]);
  const after = await seed.t.run((ctx) => ctx.db.query("journalLines").collect());
  expect(before.every((line) => after.some((row) => JSON.stringify(row) === JSON.stringify(line)))).toBe(true);
  expect(after).toHaveLength(4);
  expect(after.filter((row) => row.accountId === seed.advanceAccount._id)
    .reduce((sum, row) => sum + row.debitMinor - row.creditMinor, 0)).toBe(60_000);
  expect((await seed.owner.query(api.payroll.listAdvances, { orgId: seed.orgId, onlyOutstanding: true }))[0]?.recoveredMinor).toBe(40_000);
  expect((await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect())).map((row) => row.eventType))
    .toEqual(["EMPLOYEE_ADVANCE_RECOVERED"]);
}));

test("queued opening-advance repayment posts from the actual period-open scheduler without invented issuance", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const advance = (await seed.owner.query(api.payroll.listAdvances, { orgId: seed.orgId, onlyOutstanding: true }))[0];
  if (!advance) throw new Error("Opening advance not materialized");
  const year = new Date(seed.asOfDate).getUTCFullYear() + 1;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(year, 0, 2));
  try {
    const args = { orgId: seed.orgId, advanceId: advance._id, amount: 40, method: "CASH" as const,
      idempotencyKey: "opening-advance-queued" };
    await seed.owner.mutation(api.payroll.recoverAdvance, args);
    expect(await seed.t.run((ctx) => ctx.db.query("journalLines").collect())).toHaveLength(2);
    await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
    const period = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId })).find((row) => row.fiscalYear === year);
    if (!period) throw new Error("Missing synthetic next-year period");
    await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: period._id });
    await settleScheduledOnly(seed.t, seed.orgId);
    const events = await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    expect(events.map((row) => row.eventType)).toEqual(["EMPLOYEE_ADVANCE_RECOVERED"]);
    expect((await seed.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).every((row) => row.status === "POSTED")).toBe(true);
    const lines = await seed.t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(lines).toHaveLength(4);
    await seed.owner.mutation(api.payroll.recoverAdvance, args);
    expect(await seed.t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual(lines);
  } finally { clock.mockRestore(); }
}));

test("opening advance refuses repayment before its posted basis date", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const futureYear = new Date(seed.asOfDate).getUTCFullYear() + 1;
  const futureDate = Date.UTC(futureYear, 0, 1);
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId,
    startDate: futureDate, endDate: Date.UTC(futureYear, 11, 31, 23, 59, 59, 999),
    fiscalYear: futureYear, periodNumber: 1 });
  const futurePeriod = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId }))
    .find((period) => period.fiscalYear === futureYear);
  if (!futurePeriod) throw new Error("Missing synthetic future period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: futurePeriod._id });
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect,
    { ...seed.payload, asOfDate: futureDate });
  const [advance] = await seed.owner.query(api.payroll.listAdvances, { orgId: seed.orgId, onlyOutstanding: true });
  if (!advance) throw new Error("Missing synthetic opening advance");
  const early = { orgId: seed.orgId, advanceId: advance._id, amount: 40,
    method: "CASH" as const, idempotencyKey: "future-opening-early-recovery" };
  const before = await state(seed);
  await expect(seed.owner.mutation(api.payroll.recoverAdvance, early)).rejects.toThrow("cannot precede");
  await expect(seed.owner.mutation(api.payroll.recoverAdvance, early)).rejects.toThrow("cannot precede");
  expect(await state(seed)).toEqual(before);
  const current = await seed.owner.query(api.accountingReports.trialBalance,
    { orgId: seed.orgId, toDate: futureDate - 1 });
  expect(current.rows.find((row) => row.accountId === seed.advanceAccount._id)?.netMinor ?? 0).toBe(0);
  const clock = vi.spyOn(Date, "now").mockReturnValue(futureDate);
  try {
    await seed.owner.mutation(api.payroll.recoverAdvance,
      { ...early, idempotencyKey: "future-opening-on-basis-recovery" });
    await settleScheduledOnly(seed.t, seed.orgId);
  } finally { clock.mockRestore(); }
  expect((await state(seed)).recoveries).toHaveLength(1);
}));

test("payroll run cannot recover a future opening advance before its basis", async () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const futureYear = new Date(seed.asOfDate).getUTCFullYear() + 1;
  const futureDate = Date.UTC(futureYear, 0, 1);
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId,
    startDate: futureDate, endDate: Date.UTC(futureYear, 11, 31, 23, 59, 59, 999),
    fiscalYear: futureYear, periodNumber: 1 });
  const futurePeriod = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId }))
    .find((period) => period.fiscalYear === futureYear);
  if (!futurePeriod) throw new Error("Missing synthetic future period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: futurePeriod._id });
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect,
    { ...seed.payload, asOfDate: futureDate });
  await seed.owner.mutation(api.payroll.setCompensation,
    { orgId: seed.orgId, userId: seed.employeeId, monthlySalary: 40 });
  const now = new Date();
  const runId = await seed.owner.mutation(api.payroll.createRun,
    { orgId: seed.orgId, periodYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  const before = await state(seed);
  await expect(seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId,
    method: "CASH" })).rejects.toThrow("before its posted opening date");
  expect(await state(seed)).toEqual(before);
  const snapshot = await seed.owner.query(api.accountingReports.trialBalance,
    { orgId: seed.orgId, toDate: futureDate - 1 });
  expect(snapshot.rows.find((row) => row.accountId === seed.advanceAccount._id)?.netMinor ?? 0).toBe(0);
}));
