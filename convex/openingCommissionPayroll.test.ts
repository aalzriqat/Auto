import { afterEach, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { beginInProgressReset, resetOrgToCompletion } from "../test-utils/orgResetFixtures";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { resolveOpeningCommissionBasis } from "./utils/openingCommissionBasis";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { postAccountingEvent, type PostCommand } from "./accounting/postingEngine";
import { getPostedLines } from "./accountingReports";
import { OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY, SUPPLIER_PAYABLES_RECON_DATE_WARNING } from "./utils/closeWarnings";

const postOpening = api.accountingCutover.postOpeningBalanceDirect;
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 0, 15));
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s")); registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST opening commission", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "opening-commission-owner", email: "owner@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "opening-commission-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const employeeRole = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:commissions"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    const membershipId = await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: employeeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId, employeeId, membershipId };
  });
  const owner = t.withIdentity({ subject: "opening-commission-owner" });
  const employee = t.withIdentity({ subject: "opening-commission-employee" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  await owner.mutation(api.chartOfAccounts.create, { orgId: ids.orgId, code: "1895", name: "Synthetic unused decoy control", type: "ASSET", normalBalance: "DEBIT", allowManualPosting: false });
  const accountId = await owner.mutation(api.chartOfAccounts.create, { orgId: ids.orgId, code: "2391", name: "Synthetic opening employee commissions", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, allowManualPosting: false, currencyRestriction: "JOD" });
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 0, 31, 23, 59, 59, 999), fiscalYear: 2026, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const cash = accounts.find((row) => row.systemKey === "CASH_ON_HAND");
  if (!cash) throw new Error("Missing synthetic cash account");
  const opening = { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate: Date.UTC(2026, 0, 1), lines: [
    { accountId: cash._id, debitMinor: 100003, creditMinor: 0 }, { accountId, debitMinor: 0, creditMinor: 100003 }],
    allocations: [{ kind: "EMPLOYEE_COMMISSION" as const, rowKey: "synthetic-employee-commission", accountId, userId: ids.employeeId, amountMinor: 100003 }] };
  return { t, owner, employee, accountId, cashId: cash._id, opening, period, ...ids };
}

test("opening employee commission pays its declared control once through native payroll without reaccrual", async () => {
  const seed = await fixture();
  await seed.owner.mutation(postOpening, seed.opening);
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  const beforeApproval = await seed.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect());
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  expect(await seed.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect())).toEqual(beforeApproval);
  const result = await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  expect(result.status).toBe("PAID");
  const [item] = await seed.owner.query(api.payroll.listRunItems, { orgId: seed.orgId, runId });
  expect(item.grossMinor).toBe(100003); expect(item.netMinor).toBe(100003);
  const lines = await seed.t.run((ctx) => ctx.db.query("journalLines").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect());
  const custom = lines.filter((line) => line.accountId === seed.accountId);
  expect(custom.map((line) => [line.debitMinor, line.creditMinor])).toEqual([[0, 100003], [100003, 0]]);
  await expect(seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" })).rejects.toThrow();
  vi.setSystemTime(Date.UTC(2026, 1, 1));
  await expect(seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 2 })).rejects.toThrow("Nothing to pay");
});


async function postedFixture() {
  const seed = await fixture();
  await seed.owner.mutation(postOpening, seed.opening);
  const liability = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").unique());
  const parent = await seed.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!liability || !parent) throw new Error("Missing synthetic opening source");
  return { ...seed, liability, parent };
}
async function financialState(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async ctx => Promise.all((["openingBalanceDrafts", "openingCommissionLiabilities", "payrollItems", "payrollRuns", "accountingEvents", "pendingAccountingEvents", "journalEntries", "journalLines", "accountBalanceSnapshots"] as const).map(table => ctx.db.query(table).collect())));
}

async function assertBeneficiaryRefused(stage: "DRAFT" | "APPROVE") {
  const seed = await fixture();
  await seed.t.run(async ctx => {
    const membership = await ctx.db.get(seed.membershipId);
    if (!membership) throw new Error("Missing synthetic employee membership");
    await ctx.db.patch(membership.roleId, { name: "FINANCE_PAYROLL", permissions: ["manage:finance", "manage:payroll", "view:finance", "view:payroll", "view:commissions"] });
  });
  const draft = stage === "APPROVE" ? await (async () => {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.opening);
    return seed.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  })() : null;
  if (stage === "APPROVE" && !draft) throw new Error("Missing synthetic commission draft");
  const before = await financialState(seed);
  await expect(draft ? seed.employee.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id }) :
    seed.employee.mutation(api.accountingCutover.draftOpeningBalance, seed.opening))
    .rejects.toThrow("An independent actor must prepare or approve your opening commission.");
  expect(await financialState(seed)).toEqual(before);
  if (draft) {
    const pending = await seed.employee.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
    expect(pending).toHaveLength(1);
    expect(pending[0].readiness).toMatchObject({ canApprove: false, blockerCodes: expect.arrayContaining(["ALLOCATIONS"]) });
  }
}

test("non-owner opening commission beneficiary cannot draft their own obligation", async () => {
  await assertBeneficiaryRefused("DRAFT");
});

test("non-owner opening commission beneficiary cannot approve their own obligation", async () => {
  await assertBeneficiaryRefused("APPROVE");
});

test("the system owner can post an opening commission owed to themselves", async () => {
  const seed = await fixture();
  await seed.owner.mutation(postOpening, { ...seed.opening, allocations: [{ ...seed.opening.allocations[0], userId: seed.ownerId }] });
  const liability = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").unique());
  expect(liability).toMatchObject({ userId: seed.ownerId, amountMinor: 100003, paidMinor: 0 });
});

test("an independent non-owner can prepare another employee's opening commission", async () => {
  const seed = await fixture();
  await seed.t.run(async ctx => {
    const userId = await ctx.db.insert("users", { clerkId: "opening-independent-finance", email: "finance@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: seed.orgId, name: "FINANCE_PAYROLL", permissions: ["manage:finance", "manage:payroll"] });
    await ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId });
  });
  const finance = seed.t.withIdentity({ subject: "opening-independent-finance" });
  await finance.mutation(api.accountingCutover.draftOpeningBalance, seed.opening);
  const draft = await seed.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing synthetic independent draft");
  await seed.owner.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id });
  const liability = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").unique());
  expect(liability).toMatchObject({ userId: seed.employeeId, amountMinor: 100003, paidMinor: 0 });
});

test.each(["RESULT", "SOURCE_KEY", "OPENING_JOURNAL", "ACCOUNT_BALANCE", "CURRENCY", "EMPLOYEE"] as const)("lost %s proof refuses approval and payment before financial writes", async (damage) => {
  for (const stage of ["APPROVAL", "PAYMENT"] as const) {
    const seed = await postedFixture();
    const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
    if (stage === "PAYMENT") await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
    await seed.t.run(async ctx => {
      if (damage === "RESULT") await ctx.db.patch(seed.parent._id, { allocationResults: [] });
      if (damage === "SOURCE_KEY") await ctx.db.patch(seed.liability._id, { sourceKey: "unbound-source" });
      if (damage === "OPENING_JOURNAL" && seed.parent.journalEntryId) await ctx.db.patch(seed.parent.journalEntryId, { status: "REVERSED" });
      if (damage === "ACCOUNT_BALANCE") await ctx.db.patch(seed.accountId, { normalBalance: "DEBIT" });
      if (damage === "CURRENCY") await ctx.db.patch(seed.liability._id, { currency: "USD" });
      if (damage === "EMPLOYEE") await ctx.db.patch(seed.liability._id, { userId: seed.ownerId });
    });
    const before = await financialState(seed);
    await expect(stage === "APPROVAL" ? seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId }) :
      seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" })).rejects.toThrow();
    expect(await financialState(seed)).toEqual(before);
  }
});

test("native voluntary offboarding refuses owed opening commission and leaves membership untouched", async () => {
  const seed = await postedFixture();
  const before = await seed.t.run(async ctx => ({ member: await ctx.db.get(seed.membershipId), jobs: await ctx.db.query("membershipOffboardingJobs").collect() }));
  await expect(seed.owner.action(api.memberships.remove, { orgId: seed.orgId, membershipId: seed.membershipId })).rejects.toThrow("outstanding opening commission");
  expect(await seed.t.run(async ctx => ({ member: await ctx.db.get(seed.membershipId), jobs: await ctx.db.query("membershipOffboardingJobs").collect() }))).toEqual(before);
});

test("departed employee debt remains visible and source loss is unavailable rather than zero", async () => {
  const seed = await postedFixture();
  const listOpening = api.openingCommissionLiabilities.list;
  const own = await seed.employee.query(listOpening, { orgId: seed.orgId });
  expect(own).toHaveLength(1); expect(own[0]).toMatchObject({ source: "OPENING", remainingMinor: 100003, payrollAvailable: true });
  await seed.t.run(ctx => ctx.db.delete(seed.membershipId));
  const [departed] = await seed.owner.query(listOpening, { orgId: seed.orgId });
  expect(departed).toMatchObject({ remainingMinor: 100003, payrollAvailable: false });
  await expect(seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 })).rejects.toThrow("Nothing to pay");
  await seed.t.run(ctx => ctx.db.patch(seed.parent._id, { allocationResults: [] }));
  const [unavailable] = await seed.owner.query(listOpening, { orgId: seed.orgId });
  expect(unavailable).toMatchObject({ sourceStatus: "UNAVAILABLE", amountMinor: null, remainingMinor: null, payrollAvailable: false });
});

test("a second approved period must reapprove after the first period settles the same debt", async () => {
  const seed = await postedFixture();
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(2026, 1, 1), endDate: Date.UTC(2026, 1, 28, 23, 59, 59, 999), fiscalYear: 2026, periodNumber: 2 });
  const periods = await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId });
  const feb = periods.find(period => period.periodNumber === 2);
  if (!feb) throw new Error("Missing synthetic second period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: feb._id });
  const first = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId: first });
  vi.setSystemTime(Date.UTC(2026, 1, 15));
  const second = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 2 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId: second });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId: first, method: "CASH" });
  const before = await seed.t.run(ctx => ctx.db.query("journalEntries").collect());
  expect(await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId: second, method: "CASH" })).toEqual({ status: "NEEDS_REAPPROVAL" });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId: second });
  expect(await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId: second, method: "CASH" })).toEqual({ status: "PAID" });
  expect(await seed.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual(before);
});


test("commission reconciliation follows closed balance snapshots and preserves historical owed amounts", async () => {
  const seed = await postedFixture();
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  const historical = await seed.owner.query(api.accountingReports.commissionPayableReconciliation, { orgId: seed.orgId, toDate: Date.UTC(2026, 0, 10) });
  expect(historical.byCurrency.JOD).toMatchObject({ glBalanceMinor: 100003, subledgerBalanceMinor: 100003, isReconciled: true });
  const asOfDate = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
  vi.setSystemTime(Date.UTC(2026, 1, 1));
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.period._id });
  expect(checklist.blockers).toEqual([]);
  await seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id, acknowledgedWarnings: checklist.warnings });
  const balanceBefore = await seed.owner.query(api.accountingReports.balanceSheet, { orgId: seed.orgId, asOfDate });
  await seed.t.run(async ctx => {
    // Out-of-band corruption in a closed period: real source rows, no mocked GL math.
    // The closed balance consumer must still use the snapshots it actually reports.
    const journalEntryId = await ctx.db.insert("journalEntries", { orgId: seed.orgId, journalNumber: "QA-OUT-OF-BAND", accountingDate: asOfDate,
      periodId: seed.period._id, sourceType: "SYNTHETIC_CLOSED_COUNTEREXAMPLE", sourceId: "closed-control", category: "SYSTEM",
      memo: "Synthetic closed snapshot counterexample", status: "POSTED", currency: "JOD", postedBy: seed.ownerId, postedAt: Date.now(), createdAt: Date.now() });
    await ctx.db.insert("journalLines", { orgId: seed.orgId, journalEntryId, lineNumber: 1, accountId: seed.accountId,
      debitMinor: 0, creditMinor: 7, currency: "JOD", scale: 3, accountingDate: asOfDate });
  });
  const journalAlternative = await seed.t.run(async ctx => (await getPostedLines(ctx, seed.orgId, undefined, asOfDate))
    .filter(line => line.accountId === seed.accountId).reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0));
  expect(journalAlternative).toBe(7);
  const actual = await seed.owner.query(api.accountingReports.commissionPayableReconciliation, { orgId: seed.orgId, toDate: asOfDate });
  expect(actual.byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 0, isReconciled: true });
  expect(await seed.owner.query(api.accountingReports.balanceSheet, { orgId: seed.orgId, asOfDate })).toEqual(balanceBefore);
});


test("batch-one reset clears paid reverse proof before deleting its item and never reopens debt", async () => {
  const seed = await fixture();
  const secondEmployee = await seed.t.run(async ctx => {
    const membership = await ctx.db.get(seed.membershipId);
    if (!membership) throw new Error("Missing synthetic employee");
    const userId = await ctx.db.insert("users", { clerkId: "second-opening-commission", email: "second@example.test" });
    await ctx.db.insert("memberships", { orgId: seed.orgId, roleId: membership.roleId, userId });
    return userId;
  });
  const opening = { ...seed.opening, lines: seed.opening.lines.map(line => ({ ...line, debitMinor: line.debitMinor * 2, creditMinor: line.creditMinor * 2 })),
    allocations: [...seed.opening.allocations, { ...seed.opening.allocations[0], rowKey: "second-opening-commission", userId: secondEmployee }] };
  await seed.owner.mutation(postOpening, opening);
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  const before = await seed.t.run(async ctx => ({ rows: await ctx.db.query("openingCommissionLiabilities").collect(), parent: await ctx.db.query("openingBalanceDrafts").first(),
    otherOrg: await ctx.db.insert("organizations", { name: "QA TEST untouched reset tenant", createdAt: Date.now() }) }));
  expect(before.rows).toHaveLength(2);
  await seed.t.run(ctx => ctx.db.patch(seed.orgId, { suspended: true }));
  await beginInProgressReset(seed.t, seed.orgId);
  const first = await seed.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId, dryRun: false, batchSize: 1 });
  expect(first.remaining).toBeGreaterThan(0);
  await seed.t.run(async ctx => {
    const rows = await ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect();
    expect(rows).toHaveLength(2);
    const cleared = rows.filter(row => row.paidPayrollItemId === undefined);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].paidMinor).toBe(100003);
    for (const row of rows) {
      if (row.paidPayrollItemId) expect(await ctx.db.get(row.paidPayrollItemId)).not.toBeNull();
      expect((await resolveOpeningCommissionBasis(ctx, seed.orgId, row._id)).kind).toBe("UNAVAILABLE");
    }
  });
  await resetOrgToCompletion(seed.t, seed.orgId, 1, 100);
  await seed.t.run(async ctx => {
    expect(await ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect()).toEqual([]);
    const parent = before.parent && await ctx.db.get(before.parent._id);
    expect(parent?.allocations).toEqual(before.parent?.allocations);
    expect(parent?.journalEntryId).toBe(before.parent?.journalEntryId);
    expect(parent?.allocationResults?.filter(row => row.kind === "EMPLOYEE_COMMISSION")).toEqual([]);
    expect(await ctx.db.get(before.otherOrg)).not.toBeNull();
  });
});


test("retained deletion cursor clears payroll reverse proof before deleting opening liabilities and parent", async () => {
  const seed = await postedFixture();
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  const [liability] = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").collect());
  const previous = process.env.SUPER_ADMIN_EMAILS;
  process.env.SUPER_ADMIN_EMAILS = "opening-commission-admin@example.test";
  try {
    await seed.t.run(ctx => ctx.db.insert("users", { clerkId: "opening-commission-admin", email: "opening-commission-admin@example.test" }));
    const admin = seed.t.withIdentity({ subject: "opening-commission-admin" });
    const request = await admin.mutation(api.adminOrgs.hardDeleteOrg, { orgId: seed.orgId, confirmName: "QA TEST opening commission" });
    await seed.t.run(ctx => ctx.db.patch(request.requestId, { currentStepIndex: ORGANIZATION_DELETION_STEPS.length - 1 }));
    await seed.t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request.requestId });
    await seed.t.run(async ctx => {
      const row = await ctx.db.get(liability._id);
      expect(row?.paidPayrollItemId).toBeUndefined();
      expect(row?.paidMinor).toBe(100003);
      expect(await ctx.db.get(liability.paidPayrollItemId!)).toBeNull();
      expect((await resolveOpeningCommissionBasis(ctx, seed.orgId, liability._id)).kind).toBe("UNAVAILABLE");
    });
    let completed = false;
    for (let pass = 0; pass < 100; pass += 1) {
      const current = await seed.t.run(ctx => ctx.db.get(request.requestId));
      if (current?.status !== "RUNNING") { completed = current?.status === "COMPLETED"; break; }
      await seed.t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request.requestId });
    }
    expect(completed).toBe(true);
    expect(await seed.t.run(ctx => ctx.db.get(liability._id))).toBeNull();
    expect(await seed.t.run(ctx => ctx.db.get(liability.openingDraftId))).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = previous;
  }
});


test("draft cancellation preserves opening debt and a fresh native run can settle it", async () => {
  const seed = await postedFixture();
  const first = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.cancelRun, { orgId: seed.orgId, runId: first });
  const [owed] = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").collect());
  expect(owed.paidMinor).toBe(0);
  const second = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId: second });
  await expect(seed.owner.mutation(api.payroll.cancelRun, { orgId: seed.orgId, runId: second })).rejects.toThrow();
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId: second, method: "CASH" });
  expect((await seed.t.run(ctx => ctx.db.get(owed._id)))?.paidMinor).toBe(100003);
});

test("opening commission query preserves own-only, resolved manager and tenant permission boundaries", async () => {
  const seed = await postedFixture();
  const list = api.openingCommissionLiabilities.list;
  const actor = await seed.t.run(async ctx => {
    const userId = await ctx.db.insert("users", { clerkId: "opening-commission-impostor", email: "impostor@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: seed.orgId, name: "OWNER", permissions: ["view:commissions"] });
    await ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId });
    return { roleId };
  });
  const impostor = seed.t.withIdentity({ subject: "opening-commission-impostor" });
  expect(await impostor.query(list, { orgId: seed.orgId })).toEqual([]);
  expect(await seed.employee.query(list, { orgId: seed.orgId })).toHaveLength(1);
  await seed.t.run(ctx => ctx.db.patch(actor.roleId, { permissions: ["view:commissions", "manage:commissions"] }));
  expect(await impostor.query(list, { orgId: seed.orgId })).toHaveLength(1);
  await seed.t.run(ctx => ctx.db.patch(actor.roleId, { permissions: [] }));
  await expect(impostor.query(list, { orgId: seed.orgId })).rejects.toThrow();
  const foreign = await seed.t.run(ctx => ctx.db.insert("organizations", { name: "QA TEST foreign commission", createdAt: Date.now() }));
  await expect(seed.owner.query(list, { orgId: foreign })).rejects.toThrow();
});

test("queued native payroll keeps book debt until real posting and refuses a damaged source before journal writes", async () => {
  const seed = await postedFixture();
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  vi.setSystemTime(Date.UTC(2026, 1, 1));
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.period._id });
    expect(checklist.warnings).toEqual([SUPPLIER_PAYABLES_RECON_DATE_WARNING, ...Object.values(OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY)]);
  for (const reconciliation of [checklist.employeeAdvancesReconciliation, checklist.supplierRecoverablesReconciliation, checklist.partnerCapitalReconciliation]) {
    expect(reconciliation).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "AS_OF_DATE_UNSUPPORTED", isReconciled: false });
  }
  await expect(seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id })).rejects.toThrow("Review and acknowledge every warning before closing");
  await seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id, acknowledgedWarnings: checklist.warnings });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  const queued = await seed.t.run(ctx => ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", q => q.eq("orgId", seed.orgId)).collect());
  expect(queued.filter(row => row.eventType === "PAYROLL_PAID")).toHaveLength(1);
  const report = await seed.owner.query(api.accountingReports.commissionPayableReconciliation, { orgId: seed.orgId });
  expect(report.byCurrency.JOD).toMatchObject({ glBalanceMinor: 100003, subledgerBalanceMinor: 100003, isReconciled: true });
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(2026, 1, 1), endDate: Date.UTC(2026, 1, 28, 23, 59, 59, 999), fiscalYear: 2026, periodNumber: 2 });
  const periods = await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId });
  const february = periods.find(row => row.periodNumber === 2);
  if (!february) throw new Error("Missing synthetic period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: february._id });
  const parent = await seed.t.run(ctx => ctx.db.query("openingBalanceDrafts").first());
  if (!parent) throw new Error("Missing synthetic opening");
  await seed.t.run(ctx => ctx.db.patch(parent._id, { allocationResults: [] }));
  const journals = await seed.t.run(ctx => ctx.db.query("journalEntries").collect());
  const pending = queued.find(row => row.eventType === "PAYROLL_PAID");
  if (!pending) throw new Error("Missing queued payroll occurrence");
  await seed.t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId: pending._id });
  const claimed = await seed.t.run(ctx => ctx.db.get(pending._id));
  if (!claimed?.activeAttemptId || claimed.generation === undefined) throw new Error("Native outbox did not issue an attempt");
  const attempt = { rowId: pending._id, attemptId: claimed.activeAttemptId, generation: claimed.generation };
  expect(await seed.t.mutation(internal.accountingOutbox.postOutboxRow, attempt)).toEqual({ outcome: "REFUSED" });
  expect(await seed.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual(journals);
  await seed.t.run(ctx => ctx.db.patch(parent._id, { allocationResults: parent.allocationResults }));
  const refused = await seed.t.run(ctx => ctx.db.get(pending._id));
  expect(refused?.attempts).toBe(1);
  if (refused?.nextActionAt === undefined) throw new Error("Refused occurrence has no native backoff");
  vi.setSystemTime(refused.nextActionAt + 1);
  const retry = await seed.t.mutation(internal.accountingOutbox.claimOutboxRow, { rowId: pending._id });
  if (!retry.claimed) throw new Error("Native outbox did not issue retry");
  await seed.t.mutation(internal.accountingOutbox.postOutboxRow, { rowId: pending._id, attemptId: retry.attemptId, generation: retry.generation });
  const final = await seed.owner.query(api.accountingReports.commissionPayableReconciliation, { orgId: seed.orgId });
  expect(final.byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 0, isReconciled: true });
});


test.each(["STRIPPED_PAYLOAD_AND_ITEM", "REVERSE_REFERENCE", "SOURCE_RESULT"] as const)("cached posting success cannot bypass %s opening commission proof", async damage => {
  const seed = await postedFixture();
  const runId = await seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 });
  await seed.owner.mutation(api.payroll.approveRun, { orgId: seed.orgId, runId });
  await seed.owner.mutation(api.payroll.payRun, { orgId: seed.orgId, runId, method: "CASH" });
  const event = await seed.t.run(async ctx => (await ctx.db.query("accountingEvents").collect()).find(row => row.eventType === "PAYROLL_PAID"));
  if (!event) throw new Error("Missing actual payroll event");
  const command: PostCommand = { orgId: seed.orgId, eventType: event.eventType, sourceType: event.sourceType, sourceId: event.sourceId,
    eventVersion: event.eventVersion, accountingDate: event.accountingDate, occurredAt: event.occurredAt, currency: event.currency,
    idempotencyKey: event.idempotencyKey, payload: { ...event.payload }, actorId: event.createdBy };
  const paid = await financialState(seed);
  await seed.t.run(ctx => postAccountingEvent(ctx, command));
  expect(await financialState(seed)).toEqual(paid);
  await seed.t.run(async ctx => {
    const row = await ctx.db.get(seed.liability._id);
    if (!row?.paidPayrollItemId) throw new Error("Missing paid source");
    if (damage === "STRIPPED_PAYLOAD_AND_ITEM") {
      delete command.payload.openingCommissionSettlements;
      await ctx.db.patch(row.paidPayrollItemId, { openingCommissionLiabilityIds: undefined, openingCommissionMinor: undefined });
    }
    if (damage === "REVERSE_REFERENCE") await ctx.db.patch(row._id, { paidPayrollItemId: undefined });
    if (damage === "SOURCE_RESULT") await ctx.db.patch(seed.parent._id, { allocationResults: [] });
  });
  const before = await financialState(seed);
  await expect(seed.t.run(ctx => postAccountingEvent(ctx, command))).rejects.toThrow();
  expect(await financialState(seed)).toEqual(before);
});


test("a future opening commission remains not-yet-effective rather than falsely settled", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(2026, 1, 1), endDate: Date.UTC(2026, 1, 28, 23, 59, 59, 999), fiscalYear: 2026, periodNumber: 2 });
  const periods = await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId });
  const february = periods.find(row => row.periodNumber === 2);
  if (!february) throw new Error("Missing synthetic future period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: february._id });
  await seed.owner.mutation(postOpening, { ...seed.opening, asOfDate: Date.UTC(2026, 1, 1) });
  const [row] = await seed.owner.query(api.openingCommissionLiabilities.list, { orgId: seed.orgId });
  expect(row).toMatchObject({ sourceStatus: "AVAILABLE", amountMinor: 100003, remainingMinor: 0, notYetEffective: true, payrollAvailable: false });
  const [source] = await seed.t.run(ctx => ctx.db.query("openingCommissionLiabilities").collect());
  expect(source.paidMinor).toBe(0);
  await expect(seed.owner.mutation(api.payroll.createRun, { orgId: seed.orgId, periodYear: 2026, periodMonth: 1 })).rejects.toThrow("Nothing to pay");
});
