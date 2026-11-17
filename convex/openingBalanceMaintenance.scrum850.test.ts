import { expect, test, vi } from "vitest";
import { makeFunctionReference, type FunctionArgs } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { inTurn } from "./utils/transactionReadHeadroom";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { restoreOpeningAllocation, buildOpeningAllocationPayload } from "../components/accounting/setup/openingAllocationForm";

// Real registered-function references allow the failing-first commit to compile
// before these public commands exist. No handler or business helper is mocked.
type OpeningInput = FunctionArgs<typeof api.accountingCutover.draftOpeningBalance>;
const edit = makeFunctionReference<"mutation", OpeningInput & { draftId: Id<"openingBalanceDrafts"> }, { draftId: string }>("accountingCutover:editOpeningBalanceDraft");
const requestVoid = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">; reason: string }, null>("openingBalanceMaintenance:requestVoid");
const approveVoid = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts"> }, { reversalJournalId: Id<"journalEntries"> }>("openingBalanceMaintenance:approveVoid");
const requestSuspenseClassification = makeFunctionReference<"mutation", {
  orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">;
  accountId: Id<"chartOfAccounts">; reason: string;
}, { version: number }>("openingBalanceMaintenance:requestSuspenseClassification");
const approveSuspenseClassification = makeFunctionReference<"mutation", {
  orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">; expectedVersion: number;
}, { journalId: Id<"journalEntries"> }>("openingBalanceMaintenance:approveSuspenseClassification");

async function fixture(allFamilies = false) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST SCRUM-850", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "s850-owner", email: "owner@example.test" });
    const reviewerId = await ctx.db.insert("users", { clerkId: "s850-reviewer", email: "reviewer@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "s850-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const reviewerRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance", "view:payroll", "manage:payroll", "view:cost_price", "view:reports"] });
    const employeeRole = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId: reviewerRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: employeeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Customer" });
    return { orgId, ownerId, reviewerId, employeeId, reviewerRole, customerId };
  });
  const owner = t.withIdentity({ subject: "s850-owner" });
  const reviewer = t.withIdentity({ subject: "s850-reviewer" });
  const employee = t.withIdentity({ subject: "s850-employee" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  if (!period) throw new Error("Missing period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId });
  function account(key: string) {
    const row = accounts.find((candidate) => candidate.systemKey === key);
    if (!row) throw new Error(`Missing system account ${key}`);
    return row._id;
  }
  const simple: OpeningInput = { orgId: ids.orgId, asOfDate, expectedCurrency: "JOD", lines: [
    { accountId: account("CASH_ON_HAND"), debitMinor: 200_003, creditMinor: 0 },
    { accountId: account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 200_003 },
  ] };
  if (!allFamilies) return { t, owner, reviewer, employee, ...ids, period, asOfDate, account, payload: simple };

  const bankId = await owner.mutation(api.bankAccounts.create, { orgId: ids.orgId, name: "Synthetic bank", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: asOfDate, isReconciliationTarget: true });
  const partnerId = await owner.mutation(api.partnerEquity.add, { orgId: ids.orgId, partnerName: "Synthetic partner", idempotencyKey: "s850-partner" });
  await owner.mutation(api.vehicles.importBulk, { orgId: ids.orgId, acquisitionPosting: "OPENING_STOCK", importId: "s850-stock",
    vehicles: [{ rowId: 1, make: "Synthetic", model: "Opening", year: 2024, mileage: 0, color: "Gray", fuelType: "Petrol", transmission: "Automatic", sellingPrice: 2000, purchasePrice: 1000, sourceType: "STOCK", vin: "S850STOCK000001" }] });
  const vehicle = await t.run((ctx) => ctx.db.query("vehicles").withIndex("by_org", q => q.eq("orgId", ids.orgId)).unique());
  if (!vehicle) throw new Error("Missing imported stock");
  const otherAccount = await owner.mutation(api.chartOfAccounts.create, { orgId: ids.orgId, code: "S850-OTHER", name: "Synthetic other payable", type: "LIABILITY", normalBalance: "CREDIT" });
  const poolAccount = await owner.mutation(api.chartOfAccounts.create, { orgId: ids.orgId, code: "S850-POOL", name: "Synthetic unidentified pool", type: "LIABILITY", normalBalance: "CREDIT" });
  const payload: OpeningInput = { ...simple, lines: [
    { accountId: account("CASH_ON_HAND"), debitMinor: 200_003, creditMinor: 0 },
    { accountId: account("BANK_ACCOUNT"), bankAccountId: bankId, debitMinor: 300_003, creditMinor: 0 },
    { accountId: account("VEHICLE_INVENTORY"), debitMinor: 1_000_000, creditMinor: 0 },
    { accountId: account("ACCOUNTS_RECEIVABLE_CUSTOMERS"), debitMinor: 100_003, creditMinor: 0 },
    { accountId: account("EMPLOYEE_ADVANCES"), debitMinor: 110_003, creditMinor: 0 },
    { accountId: account("PREPAID_EXPENSES"), debitMinor: 120_003, creditMinor: 0 },
    { accountId: account("RECEIVABLE_FROM_SUPPLIERS"), debitMinor: 130_003, creditMinor: 0 },
    { accountId: account("ACCOUNTS_PAYABLE_SUPPLIERS"), debitMinor: 0, creditMinor: 140_003 },
    { accountId: otherAccount, debitMinor: 0, creditMinor: 150_003 },
    { accountId: account("COMMISSION_PAYABLE"), debitMinor: 0, creditMinor: 160_003 },
    { accountId: poolAccount, debitMinor: 0, creditMinor: 170_003 },
    { accountId: account("CUSTOMER_DEPOSITS_LIABILITY"), debitMinor: 0, creditMinor: 180_003 },
    { accountId: account("PARTNER_CAPITAL"), debitMinor: 0, creditMinor: 1_160_003 },
  ], allocations: [
    { kind: "VEHICLE_INVENTORY", rowKey: "stock", accountId: account("VEHICLE_INVENTORY"), vehicleId: vehicle._id, amountMinor: 1_000_000 },
    { kind: "CUSTOMER_RECEIVABLE", rowKey: "ar", accountId: account("ACCOUNTS_RECEIVABLE_CUSTOMERS"), customerId: ids.customerId, amountMinor: 100_003, title: "Synthetic receivable", dueDate: asOfDate },
    { kind: "EMPLOYEE_ADVANCE", rowKey: "advance", accountId: account("EMPLOYEE_ADVANCES"), userId: ids.employeeId, amountMinor: 110_003 },
    { kind: "PREPAID_EXPENSE", rowKey: "prepaid", accountId: account("PREPAID_EXPENSES"), amountMinor: 120_003, title: "Synthetic benefit", startYearMonth: `${year}-01`, termMonths: 12, expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true },
    { kind: "SUPPLIER_RECOVERABLE", rowKey: "claim", accountId: account("RECEIVABLE_FROM_SUPPLIERS"), amountMinor: 130_003, counterpartyName: "Synthetic supplier", supplierId: await supplierIdFor(t, ids.orgId, "Synthetic supplier"), title: "Synthetic claim", purpose: "CLAIM" },
    { kind: "SUPPLIER_PAYABLE", rowKey: "ap", accountId: account("ACCOUNTS_PAYABLE_SUPPLIERS"), amountMinor: 140_003, counterpartyName: "Synthetic supplier", supplierId: await supplierIdFor(t, ids.orgId, "Synthetic supplier"), title: "Synthetic payable" },
    { kind: "OTHER_PAYABLE", rowKey: "other", accountId: otherAccount, amountMinor: 150_003, counterpartyName: "Synthetic creditor", title: "Synthetic other debt" },
    { kind: "EMPLOYEE_COMMISSION", rowKey: "commission", accountId: account("COMMISSION_PAYABLE"), userId: ids.employeeId, amountMinor: 160_003 },
    { kind: "UNALLOCATED_LIABILITY", rowKey: "pool", accountId: poolAccount, amountMinor: 170_003, purpose: "UNIDENTIFIED_RECEIPT", title: "Synthetic unknown pool" },
    { kind: "CUSTOMER_DEPOSIT", rowKey: "deposit", accountId: account("CUSTOMER_DEPOSITS_LIABILITY"), amountMinor: 180_003, customerId: ids.customerId, depositKind: "SECURITY", title: "Synthetic security" },
    { kind: "PARTNER_CAPITAL", rowKey: "capital", accountId: account("PARTNER_CAPITAL"), amountMinor: 1_160_003, partnerId },
  ] };
  return { t, owner, reviewer, employee, ...ids, period, asOfDate, account, payload };
}
type Seed = Awaited<ReturnType<typeof fixture>>;

async function postUnbalancedOpening(s: Seed, lines: OpeningInput["lines"] = [
  { accountId: s.account("CASH_ON_HAND"), debitMinor: 150_000, creditMinor: 0 },
  { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_000 },
], allocations?: OpeningInput["allocations"]) {
  await s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    ...s.payload,
    lines,
    ...(allocations === undefined ? {} : { allocations }),
  });
  const draft = await s.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft?.journalEntryId) throw new Error("The active opening journal is missing");
  const suspense = await s.t.run((ctx) => ctx.db.query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "OPENING_SUSPENSE")).first());
  if (!suspense) throw new Error("The opening suspense account is missing");
  return { draftId: draft._id, suspenseId: suspense._id, originalId: draft.journalEntryId };
}

function readClassificationState(s: Seed, draftId: Id<"openingBalanceDrafts">) {
  return s.t.run(async (ctx) => ({
    draft: await ctx.db.get(draftId),
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
    snapshots: await ctx.db.query("accountBalanceSnapshots").collect(),
    audit: await ctx.db.query("financialAuditLog").collect(),
  }));
}

test("SCRUM-961 independently classifies an untouched opening suspense balance exactly once", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const { draftId, suspenseId, originalId } = await postUnbalancedOpening(s);
  const accountId = s.account("MISCELLANEOUS_INCOME");
  const statusOf = (actor: Seed["owner"]) => actor.query(api.openingBalanceMaintenance.status, { orgId: s.orgId });
  const available = (await statusOf(s.owner)).suspenseClassification;
  expect(available).toMatchObject({ signedBalanceMinor: -50_000, pending: null });
  expect(available?.targets).toContainEqual(expect.objectContaining({ accountId }));
  const request = { orgId: s.orgId, draftId, accountId, reason: "Classify the documented opening difference." };
  await s.owner.mutation(requestVoid, { orgId: s.orgId, draftId, reason: "Review the original opening." });
  const { version } = await s.owner.mutation(requestSuspenseClassification, request);
  expect((await statusOf(s.owner)).suspenseClassification?.pending).toMatchObject({ version, canApprove: false });
  expect((await statusOf(s.reviewer)).suspenseClassification?.pending).toMatchObject({
    version, canApprove: true, target: { accountId },
  });
  const approval = { orgId: s.orgId, draftId, expectedVersion: version };
  await expect(s.owner.mutation(approveSuspenseClassification, approval)).rejects.toThrow(/SECOND_PERSON/);
  expect(await s.t.run((ctx) => ctx.db.query("journalEntries").collect())).toHaveLength(1);
  const result = await s.reviewer.mutation(approveSuspenseClassification, approval);
  const anotherApprover = await financeOnlyReader(s);
  const posted = await readClassificationState(s, draftId);
  expect(await s.reviewer.mutation(approveSuspenseClassification, approval)).toEqual(result);
  expect(await anotherApprover.mutation(approveSuspenseClassification, approval)).toEqual(result);
  await expect(s.owner.mutation(requestVoid, { orgId: s.orgId, draftId, reason: "Review the original opening." }))
    .rejects.toThrow(/OPENING_VOID_ACTIVITY/);
  await expect(s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId })).rejects.toThrow(/OPENING_VOID_ACTIVITY/);
  expect(await readClassificationState(s, draftId)).toEqual(posted);
  const ledger = await s.t.run(async (ctx) => ({
    original: await ctx.db.get(originalId),
    journal: await ctx.db.get(result.journalId),
    lines: await ctx.db.query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", result.journalId)).take(3),
    count: (await ctx.db.query("journalEntries").take(3)).length,
  }));
  expect(ledger.original?.status).toBe("POSTED");
  expect(ledger.journal).toMatchObject({ accountingDate: s.asOfDate, periodId: s.period._id, category: "ADJUSTMENT", status: "POSTED" });
  expect(ledger.lines).toEqual([
    expect.objectContaining({ accountId: suspenseId, debitMinor: 50_000, creditMinor: 0 }),
    expect.objectContaining({ accountId, debitMinor: 0, creditMinor: 50_000 }),
  ]);
  expect(ledger.count).toBe(2);
  const balance = await s.reviewer.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(balance.isBalanced).toBe(true);
  expect(balance.rows.find(row => row.accountId === suspenseId)?.netMinor ?? 0).toBe(0);
  expect(balance.rows.find(row => row.accountId === accountId)).toMatchObject({ creditMinor: 50_000 });
}));

test("SCRUM-961 corrects an existing opening expense without allowing unsupported counterpart accounts", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const accountId = s.account("GENERAL_EXPENSE");
  const { draftId, suspenseId } = await postUnbalancedOpening(s, [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 80_000, creditMinor: 0 },
    { accountId, debitMinor: 70_000, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_000 },
  ]);
  const capability = (await s.owner.query(api.openingBalanceMaintenance.status, { orgId: s.orgId })).suspenseClassification;
  expect(capability?.targets).toContainEqual(expect.objectContaining({ accountId }));
  for (const unsupported of [s.account("VAT_RECEIVABLE"), s.account("CASH_ON_HAND"), s.account("BANK_ACCOUNT"), suspenseId]) {
    expect(capability?.targets).not.toContainEqual(expect.objectContaining({ accountId: unsupported }));
    await expect(s.owner.mutation(requestSuspenseClassification, {
      orgId: s.orgId, draftId, accountId: unsupported, reason: "Classify the documented opening difference.",
    })).rejects.toThrow(/OPENING_SUSPENSE_INELIGIBLE/);
  }
  expect(await s.t.run(ctx => ctx.db.query("journalEntries").take(2))).toHaveLength(1);
  expect((await s.t.run(ctx => ctx.db.get(draftId)))?.suspenseClassification).toBeUndefined();

  const { version } = await s.owner.mutation(requestSuspenseClassification, {
    orgId: s.orgId, draftId, accountId, reason: "Correct the overstated opening expense.",
  });
  await s.reviewer.mutation(approveSuspenseClassification, { orgId: s.orgId, draftId, expectedVersion: version });
  const balance = await s.reviewer.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(balance.isBalanced).toBe(true);
  expect(balance.rows.find(row => row.accountId === suspenseId)?.netMinor ?? 0).toBe(0);
  expect(balance.rows.find(row => row.accountId === accountId)).toMatchObject({
    debitMinor: 70_000, creditMinor: 50_000, netMinor: 20_000,
  });
}));

test("SCRUM-961 classifies a debit suspense balance to a supported expense", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const accountId = s.account("GENERAL_EXPENSE");
  const { draftId, suspenseId } = await postUnbalancedOpening(s, [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 50_000, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_000 },
  ]);
  const { version } = await s.owner.mutation(requestSuspenseClassification, {
    orgId: s.orgId, draftId, accountId, reason: "Classify the documented opening expense.",
  });
  await s.reviewer.mutation(approveSuspenseClassification, { orgId: s.orgId, draftId, expectedVersion: version });
  const balance = await s.reviewer.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(balance.isBalanced).toBe(true);
  expect(balance.rows.find(row => row.accountId === suspenseId)?.netMinor ?? 0).toBe(0);
  expect(balance.rows.find(row => row.accountId === accountId)).toMatchObject({ debitMinor: 50_000, creditMinor: 0 });
}));

test("SCRUM-961 financial reset refuses to delete a retained classification's journals or accounts", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const { draftId, suspenseId, originalId } = await postUnbalancedOpening(s);
  const accountId = s.account("MISCELLANEOUS_INCOME");
  const { version } = await s.owner.mutation(requestSuspenseClassification, {
    orgId: s.orgId, draftId, accountId, reason: "Classify the documented opening difference.",
  });
  const { journalId } = await s.reviewer.mutation(approveSuspenseClassification, {
    orgId: s.orgId, draftId, expectedVersion: version,
  });
  await s.t.run(ctx => ctx.db.patch(s.orgId, { suspended: true }));
  const readProof = () => s.t.run(async ctx => ({
    draft: await ctx.db.get(draftId), original: await ctx.db.get(originalId), adjustment: await ctx.db.get(journalId),
    source: await ctx.db.get(suspenseId), destination: await ctx.db.get(accountId),
  }));
  const before = await readProof();
  await expect(s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId: s.orgId, dryRun: false,
  })).rejects.toThrow(/REFUSED:.*openingBalanceDrafts count 1/);
  expect(await readProof()).toEqual(before);
}));

async function expectLaterBackdatedPostingRefused(touch: "SOURCE" | "DESTINATION") {
  const s = await fixture();
  const { draftId, suspenseId } = await postUnbalancedOpening(s);
  const accountId = s.account("MISCELLANEOUS_INCOME");
  const { version } = await s.owner.mutation(requestSuspenseClassification, {
    orgId: s.orgId, draftId, accountId, reason: "Classify the opening difference.",
  });
  await s.t.run(async (ctx) => {
    const accountingDate = s.asOfDate - 1;
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: "Backdated test posting", accountingDate,
      periodId: s.period._id, sourceType: "fixture", sourceId: "later-entry", category: "SYSTEM",
      memo: "Fixture for a posting entered later with an earlier accounting date", status: "POSTED",
      currency: "JOD", postedBy: s.ownerId, postedAt: Date.now(), createdAt: Date.now(),
    });
    await ctx.db.insert("journalLines", {
      orgId: s.orgId, journalEntryId, accountingDate, lineNumber: 1,
      accountId: touch === "SOURCE" ? suspenseId : accountId,
      debitMinor: 0, creditMinor: 100, currency: "JOD", scale: 3,
    });
    await ctx.db.insert("journalLines", {
      orgId: s.orgId, journalEntryId, accountingDate, lineNumber: 2, accountId: s.account("GENERAL_EXPENSE"),
      debitMinor: 100, creditMinor: 0, currency: "JOD", scale: 3,
    });
  });
  const status = await s.reviewer.query(api.openingBalanceMaintenance.status, { orgId: s.orgId });
  if (touch === "DESTINATION") {
    expect(status.suspenseClassification?.pending).toMatchObject({ version, canApprove: false });
  } else {
    expect(status.suspenseClassification?.pending?.canApprove ?? false).toBe(false);
  }
  const before = await readClassificationState(s, draftId);
  await expect(s.reviewer.mutation(approveSuspenseClassification, {
    orgId: s.orgId, draftId, expectedVersion: version,
  })).rejects.toThrow(/OPENING_SUSPENSE_INELIGIBLE/);
  expect(await readClassificationState(s, draftId)).toEqual(before);
}

test("SCRUM-961 approval refuses a later backdated posting to the selected account", async () =>
  withFrozenScheduler(() => expectLaterBackdatedPostingRefused("DESTINATION")));

test("SCRUM-961 approval refuses a later backdated posting to opening suspense", async () =>
  withFrozenScheduler(() => expectLaterBackdatedPostingRefused("SOURCE")));

test("SCRUM-961 approval leaves the opening journal and snapshots alone after the period closes", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const { draftId, originalId } = await postUnbalancedOpening(s);
  const { version } = await s.owner.mutation(requestSuspenseClassification, {
    orgId: s.orgId, draftId, accountId: s.account("MISCELLANEOUS_INCOME"), reason: "Classify the opening difference.",
  });
  await s.t.run((ctx) => ctx.db.patch(s.period._id, { status: "CLOSED" }));
  const readLedgerState = () => s.t.run(async (ctx) => ({
    original: await ctx.db.get(originalId),
    journals: await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).take(3),
    snapshots: await ctx.db.query("accountBalanceSnapshots")
      .withIndex("by_org_period", (q) => q.eq("orgId", s.orgId).eq("periodId", s.period._id)).collect(),
  }));
  const before = await readLedgerState();
  await expect(s.reviewer.mutation(approveSuspenseClassification, {
    orgId: s.orgId, draftId, expectedVersion: version,
  })).rejects.toThrow(/OPENING_SUSPENSE_INELIGIBLE/);
  expect(await readLedgerState()).toEqual(before);
}));

test("SCRUM-961 dismissing an opening correction fences stale approval and permits a fresh request", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const { draftId } = await postUnbalancedOpening(s);
  const selection = {
    orgId: s.orgId, draftId, accountId: s.account("MISCELLANEOUS_INCOME"), reason: "Classify the opening difference.",
  };
  const { version } = await s.owner.mutation(requestSuspenseClassification, selection);
  const priorDecision = { orgId: s.orgId, draftId, expectedVersion: version };
  await s.reviewer.mutation(api.openingBalanceMaintenance.dismissSuspenseClassification, priorDecision);
  const replacement = await s.reviewer.mutation(requestSuspenseClassification, selection);
  expect(replacement.version).toBe(version + 1);
  await expect(s.reviewer.mutation(approveSuspenseClassification, priorDecision)).rejects.toThrow(/OPENING_DRAFT_CHANGED/);
  expect(await s.t.run((ctx) => ctx.db.query("journalEntries").take(2))).toHaveLength(1);

  const { journalId } = await s.owner.mutation(approveSuspenseClassification, { ...priorDecision, expectedVersion: replacement.version });
  const actions = ["REQUEST_OPENING_SUSPENSE_CLASSIFICATION", "DISMISS_OPENING_SUSPENSE_CLASSIFICATION",
    "APPROVE_OPENING_SUSPENSE_CLASSIFICATION"];
  const observer = await financeOnlyReader(s);
  const loadAudits = async (actor: Seed["owner"]) =>
    (await actor.query(api.financialAudit.listAuditLog, { orgId: s.orgId })).filter(row => actions.includes(row.actionType));
  const audit = await loadAudits(s.reviewer);
  expect(audit).toHaveLength(4);
  expect(audit).toEqual(expect.arrayContaining([
    expect.objectContaining({ actionType: actions[0], actorId: s.ownerId, resourceId: draftId, after: { version } }),
    expect.objectContaining({ actionType: actions[1], actorId: s.reviewerId, resourceId: draftId, after: { version } }),
    expect.objectContaining({ actionType: actions[0], actorId: s.reviewerId, resourceId: draftId, after: { version: replacement.version } }),
    expect.objectContaining({ actionType: actions[2], actorId: s.ownerId, resourceId: draftId, after: { version: replacement.version, journalId } }),
  ]));
  const withheld = await loadAudits(observer);
  expect(withheld.map(row => row._id).sort()).toEqual(audit.map(row => row._id).sort());
  for (const row of withheld) {
    expect(row).toMatchObject({ resourceId: "WITHHELD", detailsWithheld: true });
    expect(row.after).toBeUndefined();
  }
}));

test("SCRUM-961 classification refuses employee, impersonated and foreign commands without writes", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const { draftId } = await postUnbalancedOpening(s);
  const args = { orgId: s.orgId, draftId, accountId: s.account("MISCELLANEOUS_INCOME"), reason: "Classify the opening difference." };
  const foreign = await s.t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST Foreign", createdAt: Date.now() });
    const draft = await ctx.db.get(draftId);
    const account = await ctx.db.get(args.accountId);
    const membership = await ctx.db.query("memberships").withIndex("by_org_user", q =>
      q.eq("orgId", s.orgId).eq("userId", s.reviewerId)).unique();
    if (!draft || !account || !membership) throw new Error("Missing authorization fixture");
    const { _id: _draftId, _creationTime: _draftTime, ...foreignDraft } = draft;
    const { _id: _accountId, _creationTime: _accountTime, ...foreignAccount } = account;
    const grantId = await ctx.db.insert("impersonationGrants", {
      actorUserId: s.reviewerId, targetUserId: s.ownerId, orgId: s.orgId, membershipId: membership._id,
      reason: "Synthetic support session", grantedAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    await ctx.db.patch(membership._id, { impersonationGrantId: grantId });
    return {
      draftId: await ctx.db.insert("openingBalanceDrafts", { ...foreignDraft, orgId }),
      accountId: await ctx.db.insert("chartOfAccounts", { ...foreignAccount, orgId }),
    };
  });
  // No request is pending, so only the active support session blocks this finance reviewer.
  const beforeRequest = await readClassificationState(s, draftId);
  await expect(s.reviewer.mutation(requestSuspenseClassification, args))
    .rejects.toThrow(/OPENING_SUSPENSE_INELIGIBLE/);
  expect(await readClassificationState(s, draftId)).toEqual(beforeRequest);

  const { version } = await s.owner.mutation(requestSuspenseClassification, args);
  const decision = { orgId: s.orgId, draftId, expectedVersion: version };
  const before = await readClassificationState(s, draftId);
  await expect(s.reviewer.mutation(approveSuspenseClassification, decision))
    .rejects.toThrow(/OPENING_SUSPENSE_SECOND_PERSON/);
  await expect(s.reviewer.mutation(api.openingBalanceMaintenance.dismissSuspenseClassification, decision))
    .rejects.toThrow(/OPENING_DRAFT_CHANGED/);
  await expect(s.employee.mutation(requestSuspenseClassification, args)).rejects.toThrow(/manage:finance/);
  await expect(s.employee.mutation(approveSuspenseClassification, decision)).rejects.toThrow(/manage:finance/);
  await expect(s.employee.mutation(api.openingBalanceMaintenance.dismissSuspenseClassification, decision))
    .rejects.toThrow(/manage:finance/);

  await expect(s.owner.mutation(requestSuspenseClassification, { ...args, accountId: foreign.accountId }))
    .rejects.toThrow(/Record not found in this organization/);
  const foreignDecision = { ...decision, draftId: foreign.draftId };
  await expect(s.owner.mutation(requestSuspenseClassification, { ...args, draftId: foreign.draftId }))
    .rejects.toThrow(/Record not found in this organization/);
  await expect(s.owner.mutation(approveSuspenseClassification, foreignDecision))
    .rejects.toThrow(/Record not found in this organization/);
  await expect(s.owner.mutation(api.openingBalanceMaintenance.dismissSuspenseClassification, foreignDecision))
    .rejects.toThrow(/Record not found in this organization/);
  expect(await readClassificationState(s, draftId)).toEqual(before);
}));

test("SCRUM-961 a finance user without payroll cannot change classification of an opening with an advance", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const advances = s.account("EMPLOYEE_ADVANCES");
  const { draftId } = await postUnbalancedOpening(s, [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 150_000, creditMinor: 0 },
    { accountId: advances, debitMinor: 110_003, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 210_003 },
  ], [{ kind: "EMPLOYEE_ADVANCE", rowKey: "advance", accountId: advances, userId: s.employeeId, amountMinor: 110_003 }]);
  const args = { orgId: s.orgId, draftId, accountId: s.account("MISCELLANEOUS_INCOME"), reason: "Classify the opening difference." };
  const { version } = await s.owner.mutation(requestSuspenseClassification, args);
  const decision = { orgId: s.orgId, draftId, expectedVersion: version };
  const finance = await financeOnlyReader(s);
  const before = await readClassificationState(s, draftId);
  await expect(finance.mutation(requestSuspenseClassification, args)).rejects.toThrow(/manage:payroll/);
  await expect(finance.mutation(approveSuspenseClassification, decision)).rejects.toThrow(/manage:payroll/);
  await expect(finance.mutation(api.openingBalanceMaintenance.dismissSuspenseClassification, decision)).rejects.toThrow(/manage:payroll/);
  expect(await readClassificationState(s, draftId)).toEqual(before);
}));

async function financeOnlyReader(s: Seed) {
  await s.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId: "s850-audit-reader", email: "audit@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "FINANCE_ONLY", permissions: ["view:finance", "manage:finance"] });
    await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
  });
  return s.t.withIdentity({ subject: "s850-audit-reader" });
}

function expectNoAuditAmounts(rows: unknown, amounts: readonly number[]) {
  const serialized = JSON.stringify(rows);
  for (const amount of amounts) expect(serialized).not.toContain(String(amount));
  // Reject monetary keys even if a future writer uses an unfamiliar amount.
  expect(serialized).not.toMatch(/"[^"\n]*(?:amount|debit|credit|cost|price|balance|total)[^"\n]*":/i);
}

async function singletonAuditConfidentiality(kind: "EMPLOYEE_ADVANCE" | "VEHICLE_INVENTORY") {
  return withFrozenScheduler(async () => {
    const s = await fixture(kind === "VEHICLE_INVENTORY");
    const finance = await financeOnlyReader(s);
    const allocation = kind === "EMPLOYEE_ADVANCE"
      ? { kind, rowKey: "only-advance", accountId: s.account("EMPLOYEE_ADVANCES"), userId: s.employeeId, amountMinor: 110_003 }
      : s.payload.allocations?.find(row => row.kind === "VEHICLE_INVENTORY");
    if (!allocation) throw new Error("Missing singleton allocation");
    const input: OpeningInput = { orgId: s.orgId, asOfDate: s.asOfDate, expectedCurrency: "JOD", lines: [
      { accountId: allocation.accountId, debitMinor: allocation.amountMinor, creditMinor: 0 },
      { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: allocation.amountMinor },
    ], allocations: [allocation] };
    await s.owner.mutation(api.accountingCutover.draftOpeningBalance, input);
    const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
    if (!draft) throw new Error("Missing singleton draft");
    const status = await finance.query(api.accountingCutover.openingBalanceStatus, { orgId: s.orgId });
    expect(status.canReadOpeningStockCost).toBe(false);
    expect(JSON.stringify(status)).not.toContain(String(allocation.amountMinor));
    if (kind === "EMPLOYEE_ADVANCE") expect(status.pendingDraftId).toBeNull();
    expect(await finance.query(api.openingBalanceMaintenance.status, { orgId: s.orgId })).toMatchObject({ editable: null });
    await expect(finance.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/permission/i);
    await expect(finance.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(/permission/i);
    await expect(finance.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow(/permission/i);
    const baseline = await finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId });
    expectNoAuditAmounts(baseline, [allocation.amountMinor]);
    expect(baseline.filter(row => row.actionType === "EDIT_OPENING_DRAFT")).toEqual([]);

    await s.owner.mutation(edit, { ...input, draftId: draft._id, memo: "Memo-edit" });
    for (const filter of [{}, { actionType: "EDIT_OPENING_DRAFT" }, { actorId: s.ownerId }, { fromDate: 1 }]) {
      const rows = await finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId, ...filter });
      expectNoAuditAmounts(rows, [allocation.amountMinor]);
      const edits = rows.filter(row => row.actionType === "EDIT_OPENING_DRAFT");
      expect(edits).toHaveLength(1);
      const metadata = { lineCount: 2, allocationCount: 1, allocationKinds: [kind], asOfDate: s.asOfDate, currency: "JOD" };
      expect(edits[0]).toMatchObject({ actorId: s.ownerId, resourceId: "WITHHELD" });
      expect(JSON.stringify(edits[0])).not.toContain(String(draft._id));
      expect(edits[0].before).toEqual({ ...metadata, version: 0 });
      expect(edits[0].after).toEqual({ ...metadata, version: 1, memoChanged: true });
    }
    expect(await s.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual([]);
  });
}

// The scenario library requires literal, non-parameterized registrations.
test("SCRUM-850 R7 singleton employee advance edit audit withholds pending amounts", async () =>
  singletonAuditConfidentiality("EMPLOYEE_ADVANCE"), 30_000);
test("SCRUM-850 R7 singleton vehicle inventory edit audit withholds pending amounts", async () =>
  singletonAuditConfidentiality("VEHICLE_INVENTORY"), 30_000);

test("SCRUM-850 R7 mixed draft edit audit contains metadata without protected amounts or totals", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  const finance = await financeOnlyReader(s);
  const stock = s.payload.allocations?.find(row => row.kind === "VEHICLE_INVENTORY");
  const advance = s.payload.allocations?.find(row => row.kind === "EMPLOYEE_ADVANCE");
  if (stock?.kind !== "VEHICLE_INVENTORY" || advance?.kind !== "EMPLOYEE_ADVANCE") throw new Error("Missing sensitive allocations");
  const input: OpeningInput = { ...s.payload, memo: "private-before-memo", lines: [
    { accountId: stock.accountId, debitMinor: 1_000_000, creditMinor: 0, description: "private-line-description" },
    { accountId: advance.accountId, debitMinor: 110_003, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_310_006 },
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 200_003, creditMinor: 0 },
  ], allocations: [stock, advance] };
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, input);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing opening draft");
  // The dedicated readers withhold this exact draft from this exact identity.
  await expect(finance.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/permission/i);
  expect(await finance.query(api.accountingCutover.openingBalanceStatus, { orgId: s.orgId })).toMatchObject({ pendingDraftId: null });
  const readAudit = () => finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId, limit: 200 });
  const before = JSON.stringify(await readAudit());
  expect(before).not.toContain(String(stock.vehicleId));
  expect(before).not.toContain(String(advance.userId));

  await s.owner.mutation(edit, { ...input, draftId: draft._id, memo: "private-after-memo", lines: [
    input.lines[0], { ...input.lines[1], debitMinor: 110_007 },
    { ...input.lines[2], creditMinor: 1_310_010 }, input.lines[3],
  ], allocations: [stock, { ...advance, amountMinor: 110_007 }] });
  const rows = await readAudit();
  expectNoAuditAmounts(rows, [1_000_000, 110_003, 110_007, 200_003, 1_310_006, 1_310_010]);
  const serialized = JSON.stringify(rows);
  for (const forbidden of [String(stock.vehicleId), String(advance.userId), "1000000", "110003", "110007",
    "private-before-memo", "private-after-memo", "private-line-description"]) {
    expect(serialized).not.toContain(forbidden);
  }
  const edits = rows.filter(row => row.actionType === "EDIT_OPENING_DRAFT");
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({
    before: { version: 0, lineCount: 4, allocationCount: 2, allocationKinds: ["VEHICLE_INVENTORY", "EMPLOYEE_ADVANCE"], asOfDate: s.asOfDate, currency: "JOD" },
    after: { version: 1, lineCount: 4, allocationCount: 2, allocationKinds: ["VEHICLE_INVENTORY", "EMPLOYEE_ADVANCE"], asOfDate: s.asOfDate, currency: "JOD", memoChanged: true },
  });
}), 30_000);

test("SCRUM-850 R7 amount-only successive edits reveal versions and counts without amount deltas", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const finance = await financeOnlyReader(s);
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing opening draft");
  for (const amount of [200_007, 200_011]) {
    await s.owner.mutation(edit, { ...s.payload, draftId: draft._id, lines: [
      { ...s.payload.lines[0], debitMinor: amount },
      { ...s.payload.lines[1], creditMinor: amount },
    ] });
  }
  const rows = await finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId, actionType: "EDIT_OPENING_DRAFT" });
  expect(rows).toHaveLength(2);
  expectNoAuditAmounts(rows, [200_003, 200_007, 200_011]);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ before: { version: 0, lineCount: 2, allocationCount: 0, allocationKinds: [], asOfDate: s.asOfDate, currency: "JOD" },
      after: { version: 1, lineCount: 2, allocationCount: 0, allocationKinds: [], asOfDate: s.asOfDate, currency: "JOD", memoChanged: false } }),
    expect.objectContaining({ before: { version: 1, lineCount: 2, allocationCount: 0, allocationKinds: [], asOfDate: s.asOfDate, currency: "JOD" },
      after: { version: 2, lineCount: 2, allocationCount: 0, allocationKinds: [], asOfDate: s.asOfDate, currency: "JOD", memoChanged: false } }),
  ]));
}), 20_000);

test("SCRUM-850 R7 correcting an unsafe retained draft omits historical and replacement audit amounts", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing opening draft");
  // Retained malformed history, not an amount today's public writer admits.
  await s.t.run(ctx => ctx.db.patch(draft._id, { lines: [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 4_503_599_627_370_496, creditMinor: 0 },
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 4_503_599_627_370_497, creditMinor: 0 },
  ] }));
  await s.owner.mutation(edit, { ...s.payload, draftId: draft._id });
  const rows = await s.owner.query(api.financialAudit.listAuditLog, { orgId: s.orgId, actionType: "EDIT_OPENING_DRAFT" });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ before: { version: 0, lineCount: 2, allocationCount: 0 }, after: { version: 1, lineCount: 2, allocationCount: 0, memoChanged: false } });
  expectNoAuditAmounts(rows, [4_503_599_627_370_496, 4_503_599_627_370_497, 9_007_199_254_740_992, 200_003]);
}), 20_000);

function openingAmount(s: Seed, minor: number) {
  s.payload.lines = [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: minor, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: minor },
  ];
}

test("SCRUM-850 R3 cross-account statement totals refuse and retained unsafe operands never cancel into a figure", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.t.run(async ctx => {
    for (const key of ["CASH_ON_HAND", "BANK_ACCOUNT"]) {
      await ctx.db.insert("accountBalanceSnapshots", { orgId: s.orgId, accountId: s.account(key), currency: "JOD", periodId: s.period._id,
        shard: 0, runningDebitMinor: 4_503_599_627_370_497, runningCreditMinor: 0, updatedAt: Date.now() });
    }
  });
  await expect(s.owner.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: s.period.endDate })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
  await expect(s.owner.query(api.accountingReports.trialBalance, { orgId: s.orgId, toDate: s.period.endDate })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
  await s.t.run(async ctx => {
    const snapshots = await ctx.db.query("accountBalanceSnapshots").collect();
    for (const row of snapshots) await ctx.db.delete(row._id);
    await ctx.db.insert("accountBalanceSnapshots", { orgId: s.orgId, accountId: s.account("CASH_ON_HAND"), currency: "JOD", periodId: s.period._id,
      shard: 0, runningDebitMinor: 9_007_199_254_740_992, runningCreditMinor: 1, updatedAt: Date.now() });
  });
  await expect(s.owner.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: s.period.endDate })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
}), 20_000);

test("SCRUM-850 R3 snapshot overflow preserves existing reconciliation unavailable contracts", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.t.run(async ctx => {
    for (const key of ["CASH_ON_HAND", "RECEIVABLE_FROM_SUPPLIERS"]) {
      for (const shard of [0, 1]) {
        await ctx.db.insert("accountBalanceSnapshots", { orgId: s.orgId, accountId: s.account(key), currency: "JOD", periodId: s.period._id,
          shard, runningDebitMinor: 4_503_599_627_370_497, runningCreditMinor: 0, updatedAt: Date.now() });
      }
    }
  });
  const cutoff = s.period.endDate;
  expect(await s.owner.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId, toDate: cutoff })).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "OVER_LIMIT", isReconciled: false, currencies: [] });
  expect(await s.owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId: s.orgId, toDate: cutoff })).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "OVER_LIMIT", isReconciled: false, currencies: [] });
  expect(await s.owner.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId, toDate: cutoff })).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "OVER_LIMIT", complete: false });
  expect(await s.owner.query(api.accountingReports.customerDepositsReconciliation, { orgId: s.orgId, toDate: cutoff })).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "OPENING_SOURCE_UNAVAILABLE", isReconciled: false });
  await expect(s.owner.query(api.vatReport.generateVatSummary, { orgId: s.orgId, toDate: cutoff })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
}), 20_000);

test("SCRUM-850 R3 replacement gross snapshots refuse rounded trial and balance sheet figures", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  let shard = 0;
  const rng = vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(shard);
    return array;
  });
  try {
    openingAmount(s, 9_007_199_254_740_991);
    const draftId = await posted(s);
    await request(s, draftId);
    await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
    shard = 1; // Both shards remain safe; their gross sum does not.
    openingAmount(s, 9_007_199_254_740_990);
    await posted(s);
    await expect(s.owner.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
    for (const asOfDate of [s.asOfDate, s.period.endDate]) {
      await expect(s.owner.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
    }
  } finally { rng.mockRestore(); }
}), 20_000);

test("SCRUM-850 R3 unsafe snapshot write refuses replacement atomically including scheduled work", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const rng = vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  });
  try {
    openingAmount(s, 9_007_199_254_740_991);
    const draftId = await posted(s);
    await request(s, draftId);
    await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
    openingAmount(s, 9_007_199_254_740_990);
    const pending = await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
    const id = await s.t.run(async ctx => ctx.db.normalizeId("openingBalanceDrafts", pending.draftId));
    if (!id) throw new Error("Missing replacement");
    const before = await entireDatabase(s);
    await expect(s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId: id, expectedVersion: 0 })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
    expect(await entireDatabase(s)).toEqual(before);
  } finally { rng.mockRestore(); }
}), 20_000);

test("SCRUM-850 R3 elapsed periods with unsafe gross totals refuse public snapshot reports", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.t.run(async ctx => {
    const prior = await ctx.db.insert("accountingPeriods", { orgId: s.orgId, startDate: s.asOfDate - 1000,
      endDate: s.asOfDate - 1, fiscalYear: 2025, periodNumber: 12, status: "CLOSED", createdAt: Date.now(), createdBy: s.ownerId });
    for (const [periodId, minor] of [[prior, 9_007_199_254_740_991], [s.period._id, 2]] as const) {
      await ctx.db.insert("accountBalanceSnapshots", { orgId: s.orgId, accountId: s.account("CASH_ON_HAND"), currency: "JOD", periodId,
        shard: 0, runningDebitMinor: minor, runningCreditMinor: 0, updatedAt: Date.now() });
    }
  });
  await expect(s.owner.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: s.period.endDate })).rejects.toThrow(/ACCOUNT_SNAPSHOT_UNSAFE_TOTAL/);
}), 20_000);

test("SCRUM-850 R3 ordinary replacement preserves exact trial balance and balance sheet", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  openingAmount(s, 200_003);
  const draftId = await posted(s);
  await request(s, draftId);
  await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  openingAmount(s, 200_002);
  await posted(s);
  expect(await s.owner.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: s.period.endDate })).toMatchObject({ totalAssets: 200_002, isBalanced: true });
  const trial = await s.owner.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(trial.rows.find(row => row.accountId === s.account("CASH_ON_HAND"))).toMatchObject({ netMinor: 200_002 });
}), 20_000);

test("SCRUM-850 R1 unchanged large allocation survives registered edit approval and posting", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const amountMinor = 9_007_199_254_740_812;
  const input: OpeningInput = { ...s.payload, lines: [
    { accountId: s.account("EMPLOYEE_ADVANCES"), debitMinor: amountMinor, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: amountMinor },
  ], allocations: [{ kind: "EMPLOYEE_ADVANCE", rowKey: "large", accountId: s.account("EMPLOYEE_ADVANCES"), userId: s.employeeId, amountMinor }] };
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, input);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft?.allocations) throw new Error("Missing draft");
  const allocations = buildOpeningAllocationPayload(draft.allocations.map(row => restoreOpeningAllocation(row, "JOD")), "JOD");
  expect(allocations?.[0].amountMinor).toBe(9_007_199_254_740_812);
  await s.owner.mutation(edit, { ...input, draftId: draft._id, allocations: allocations ?? undefined });
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 1, orgId: s.orgId, draftId: draft._id });
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
  expect(lines.map(row => [row.debitMinor, row.creditMinor])).toEqual([[9_007_199_254_740_812, 0], [0, 9_007_199_254_740_812]]);
}));

async function reconciliationReaders(s: Seed) {
  return {
    advances: await s.owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId: s.orgId }),
    recoverables: await s.owner.query(api.accountingReports.supplierRecoverablesReconciliation, { orgId: s.orgId }),
    receivables: await s.owner.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId }),
    warnings: (await s.owner.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId: s.period._id })).warnings,
  };
}

test("SCRUM-850 F1 verified void and reentry preserve all three reconciliations and checklist warnings", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  const control = await reconciliationReaders(s);
  for (const result of [control.advances, control.recoverables, control.receivables]) expect(result).toMatchObject({ status: "AVAILABLE", isReconciled: true });
  await request(s, draftId);
  await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  await posted(s);
  expect(await reconciliationReaders(s)).toEqual(control);
}), 20_000);

test("SCRUM-850 F1 tampered reversal remains unavailable in all three reconciliations", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  await request(s, draftId);
  const { reversalJournalId } = await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  await posted(s);
  await s.t.run(async ctx => {
    const line = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", reversalJournalId)).first();
    if (!line) throw new Error("Missing reversal line");
    await ctx.db.patch(line._id, { creditMinor: line.creditMinor + 1 });
  });
  const actual = await reconciliationReaders(s);
  for (const result of [actual.advances, actual.recoverables, actual.receivables]) expect(result.status).toBe("UNAVAILABLE");
}));

const reviewedApprove = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">; expectedVersion: number }, { journalId: string }>("accountingCutover:approveOpeningBalance");
const reviewedReject = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">; expectedVersion: number; rejectionReason: string }, null>("accountingCutover:rejectOpeningBalanceDraft");

test("SCRUM-850 F2 stale approval refuses without writes and current reviewed version posts", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  await s.owner.mutation(edit, { ...s.payload, draftId: draft._id, memo: "Changed after review" });
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(reviewedApprove, { orgId: s.orgId, draftId: draft._id, expectedVersion: 0 })).rejects.toThrow(/OPENING_DRAFT_CHANGED/);
  expect(await entireDatabase(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(draft._id))).toMatchObject({ status: "PENDING_APPROVAL" });
  expect(await s.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual([]);
  const pending = await s.reviewer.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId });
  expect(pending[0]).toMatchObject({ version: 1, memo: "Changed after review" });
  await s.reviewer.mutation(reviewedApprove, { orgId: s.orgId, draftId: draft._id, expectedVersion: 1 });
  expect(await s.t.run(ctx => ctx.db.get(draft._id))).toMatchObject({ status: "POSTED" });
}));

test("SCRUM-850 F2 stale rejection refuses without writes and current reviewed version rejects", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  await s.owner.mutation(edit, { ...s.payload, draftId: draft._id, memo: "Changed after review" });
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(reviewedReject, { orgId: s.orgId, draftId: draft._id, expectedVersion: 0, rejectionReason: "Old decision" })).rejects.toThrow(/OPENING_DRAFT_CHANGED/);
  expect(await entireDatabase(s)).toEqual(before);
  await s.reviewer.mutation(reviewedReject, { orgId: s.orgId, draftId: draft._id, expectedVersion: 1, rejectionReason: "Current decision" });
  expect(await s.t.run(ctx => ctx.db.get(draft._id))).toMatchObject({ status: "REJECTED", rejectionReason: "Current decision" });
}));

function legacyDecisionRefuses(decision: "approve" | "reject") {
  return withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  const legacyApprove = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts"> }, unknown>("accountingCutover:approveOpeningBalance");
  const legacyReject = makeFunctionReference<"mutation", { orgId: Id<"organizations">; draftId: Id<"openingBalanceDrafts">; rejectionReason: string }, unknown>("accountingCutover:rejectOpeningBalanceDraft");
  await s.owner.mutation(edit, { ...s.payload, draftId: draft._id, memo: "Unseen replacement" });
  const before = await entireDatabase(s);
  const result = decision === "approve"
    ? s.reviewer.mutation(legacyApprove, { orgId: s.orgId, draftId: draft._id })
    : s.reviewer.mutation(legacyReject, { orgId: s.orgId, draftId: draft._id, rejectionReason: "Legacy" });
  await expect(result).rejects.toThrow();
  expect(await entireDatabase(s)).toEqual(before);
  });
}
// These are the actual test.each names registered at the failing-first commit.
test("SCRUM-850 F2 legacy approve client without reviewed version refuses after edit before writing", async () => {
  await legacyDecisionRefuses("approve");
});
test("SCRUM-850 F2 legacy reject client without reviewed version refuses after edit before writing", async () => {
  await legacyDecisionRefuses("reject");
});

async function entireDatabase(s: Seed) {
  return s.t.run(async (ctx) => {
    const tables: Record<string, unknown> = {};
    await inTurn(Object.keys(schema.tables) as TableNames[], async (table) => {
      tables[table] = await ctx.db.query(table).collect();
    });
    tables._scheduled_functions = await ctx.db.system.query("_scheduled_functions").collect();
    return tables;
  });
}
async function posted(s: Seed) {
  const { draftId } = await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run(async (ctx) => {
    const id = ctx.db.normalizeId("openingBalanceDrafts", draftId);
    return id ? ctx.db.get(id) : null;
  });
  if (!draft || draft._id !== draftId) throw new Error("Missing opening draft");
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0, orgId: s.orgId, draftId: draft._id });
  return draft._id;
}
async function request(s: Seed, draftId: Id<"openingBalanceDrafts">) {
  return s.owner.mutation(requestVoid, { orgId: s.orgId, draftId, reason: "Replace documented opening error" });
}
async function addActivity(s: Seed, otherPeriod: boolean, status: "POSTED" | "REVERSED" = "POSTED") {
  const date = otherPeriod ? s.period.endDate + 1 : s.asOfDate + 86_400_000;
  let periodId = s.period._id;
  if (otherPeriod) {
    const year = new Date(date).getUTCFullYear();
    await s.owner.mutation(api.accountingPeriods.create, { orgId: s.orgId, startDate: date,
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
    const next = (await s.owner.query(api.accountingPeriods.list, { orgId: s.orgId })).find(row => row.startDate === date);
    if (!next) throw new Error("Missing other open period");
    await s.owner.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: next._id });
    periodId = next._id;
  }
  await s.t.run((ctx) => ctx.db.insert("journalEntries", { orgId: s.orgId, journalNumber: "S850-ACTIVITY", accountingDate: date,
    periodId, sourceType: "manual", sourceId: "synthetic-activity", category: "MANUAL", memo: "Synthetic activity", status,
    currency: "JOD", postedBy: s.ownerId, postedAt: Date.now(), createdAt: Date.now() }));
}

test("SCRUM-850 preparer edits pending in place and a different actor approves the edited exact minor units", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  const input = { ...s.payload, draftId: draft._id, memo: "Corrected draft", lines: [
    { accountId: s.account("CASH_ON_HAND"), debitMinor: 321_007, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 321_007 },
  ] };
  await s.owner.mutation(edit, input);
  const edited = await s.t.run((ctx) => ctx.db.get(draft._id));
  expect(edited).toMatchObject({ status: "PENDING_APPROVAL", createdBy: s.ownerId, memo: "Corrected draft", lines: input.lines });
  const before = await entireDatabase(s);
  await expect(s.owner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 1, orgId: s.orgId, draftId: draft._id })).rejects.toThrow(/same as the preparer/);
  expect(await entireDatabase(s)).toEqual(before);
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 1, orgId: s.orgId, draftId: draft._id });
  const trial = await s.owner.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(trial).toMatchObject({ isBalanced: true, totalDebits: 321_007, totalCredits: 321_007 });
}));

// Explicit registrations let SCRUM-761 bind each case to one permanent record.
async function editedLinesReceiveDraftValidation(damage: "negative" | "nan" | "currency" | "bank" | "inactive" | "allocation") {
  return withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  const input: OpeningInput & { draftId: Id<"openingBalanceDrafts"> } = { ...s.payload, draftId: draft._id, lines: s.payload.lines.map(line => ({ ...line })) };
  if (damage === "negative") input.lines[0].debitMinor = -1;
  if (damage === "nan") input.lines[0].debitMinor = Number.NaN;
  if (damage === "currency") input.expectedCurrency = "USD";
  if (damage === "bank") input.lines[0].accountId = s.account("BANK_ACCOUNT");
  if (damage === "inactive") await s.t.run((ctx) => ctx.db.patch(input.lines[0].accountId, { active: false }));
  if (damage === "allocation") input.lines[0].accountId = s.account("ACCOUNTS_RECEIVABLE_CUSTOMERS");
  const before = await entireDatabase(s);
  // Exclude missing-function errors from this refusal assertion in the red run.
  await expect(s.owner.mutation(edit, input)).rejects.toThrow(/negative|non-negative|integer|currency|bank|inactive|allocat|finite|positive/i);
  expect(await entireDatabase(s)).toEqual(before);
  });
}
test("SCRUM-850 edited lines receive the same draft validation: negative", () => editedLinesReceiveDraftValidation("negative"));
test("SCRUM-850 edited lines receive the same draft validation: nan", () => editedLinesReceiveDraftValidation("nan"));
test("SCRUM-850 edited lines receive the same draft validation: currency", () => editedLinesReceiveDraftValidation("currency"));
test("SCRUM-850 edited lines receive the same draft validation: bank", () => editedLinesReceiveDraftValidation("bank"));
test("SCRUM-850 edited lines receive the same draft validation: inactive", () => editedLinesReceiveDraftValidation("inactive"));
test("SCRUM-850 edited lines receive the same draft validation: allocation", () => editedLinesReceiveDraftValidation("allocation"));

test("SCRUM-850 approved void unwinds all eleven allocation kinds and bank attribution then reposts the same masters", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  const original = await s.t.run((ctx) => ctx.db.get(draftId));
  expect(original?.allocationResults).toHaveLength(11);
  expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({ status: "OK", balanceMinor: 300_003 });
  expect(await request(s, draftId)).toBeNull();
  const beforeSameActor = await entireDatabase(s);
  await expect(s.owner.mutation(approveVoid, { orgId: s.orgId, draftId })).rejects.toThrow(/OPENING_CHANGE_SECOND_PERSON/);
  expect(await entireDatabase(s)).toEqual(beforeSameActor);
  const result = await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  const after = await entireDatabase(s);
  for (const table of ["receivables", "receivableDocuments", "employeeAdvances", "prepaidExpenseSchedules", "supplierCostRecoveries", "vehicleSupplierPayables", "openingCommissionLiabilities", "deposits"]) expect(after[table], table).toEqual([]);
  expect(after.vehicles).toEqual([expect.objectContaining({ purchasePrice: 1000, openingStockImportId: "s850-stock" })]);
  const vehicles = await s.t.run((ctx) => ctx.db.query("vehicles").collect());
  expect(vehicles[0]?.openingBalanceDraftId).toBeUndefined();
  const partners = await s.t.run((ctx) => ctx.db.query("partnerEquity").collect());
  expect(partners[0]?.openingBalanceDraftId).toBeUndefined();
  expect(partners[0]?.openingBalanceMinor ?? 0).toBe(0);
  expect(await s.t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: "VOIDED", allocationResults: original?.allocationResults });
  const journals = await s.t.run((ctx) => ctx.db.query("journalEntries").collect());
  expect(journals).toHaveLength(2);
  expect(journals.find(row => row._id === original?.journalEntryId)).toMatchObject({ status: "REVERSED", reversedByJournalEntryId: result.reversalJournalId });
  expect(journals.find(row => row._id === result.reversalJournalId)).toMatchObject({ status: "POSTED", reversalOfJournalEntryId: original?.journalEntryId, accountingDate: s.asOfDate });
  const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
  expect(lines).toHaveLength(26);
  expect(lines.reduce((total, row) => total + row.debitMinor, 0)).toBe(3_920_036);
  expect(lines.reduce((total, row) => total + row.creditMinor, 0)).toBe(3_920_036);
  const snapshots = await s.t.run((ctx) => ctx.db.query("accountBalanceSnapshots").collect());
  expect(snapshots.reduce((total, row) => total + row.runningDebitMinor, 0)).toBe(3_920_036);
  expect(snapshots.reduce((total, row) => total + row.runningCreditMinor, 0)).toBe(3_920_036);
  const trial = await s.owner.query(api.accountingReports.trialBalance, { orgId: s.orgId });
  expect(trial).toMatchObject({ isBalanced: true, totalDebits: 3_920_036, totalCredits: 3_920_036 });
  expect(trial.rows.every(row => row.netMinor === 0)).toBe(true);
  expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({ status: "OK", balanceMinor: 0, unattributedLineCount: 0 });
  const beforeReplay = await entireDatabase(s);
  expect(await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId })).toEqual(result);
  await request(s, draftId);
  expect(await entireDatabase(s)).toEqual(beforeReplay);
  await posted(s);
  expect(await s.owner.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({ status: "OK", balanceMinor: 300_003 });
  const readback = await s.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId });
  expect(readback?.rows).toHaveLength(11);
  expect(readback?.rows.every(row => row.recordAvailable || row.kind === "UNALLOCATED_LIABILITY")).toBe(true);
}));

// Explicit registrations let SCRUM-761 bind each case to one permanent record.
async function refuseNonOpeningActivity(otherPeriod: boolean) {
  return withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await addActivity(s, otherPeriod);
  const before = await entireDatabase(s);
  await expect(request(s, draftId)).rejects.toThrow(/OPENING_VOID_ACTIVITY/);
  expect(await entireDatabase(s)).toEqual(before);
  });
}
test("SCRUM-850 void refuses non-opening activity across the whole ledger otherPeriod=false", () => refuseNonOpeningActivity(false));
test("SCRUM-850 void refuses non-opening activity across the whole ledger otherPeriod=true", () => refuseNonOpeningActivity(true));

test("SCRUM-850 approval rechecks intervening activity and owner direct path cannot bypass it", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await request(s, draftId);
  await addActivity(s, true, "REVERSED");
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId })).rejects.toThrow(/OPENING_VOID_ACTIVITY/);
  await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, s.payload)).rejects.toThrow();
  expect(await entireDatabase(s)).toEqual(before);
}));

test("SCRUM-850 a later posting after a governed void still blocks every fresh opening door", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await request(s, draftId);
  await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  await addActivity(s, false);
  const before = await entireDatabase(s);
  await expect(s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload)).rejects.toThrow(/OPENING_BALANCE_AFTER_LEDGER_ACTIVITY/);
  await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, s.payload)).rejects.toThrow(/OPENING_BALANCE_AFTER_LEDGER_ACTIVITY/);
  expect(await entireDatabase(s)).toEqual(before);
}));

test("SCRUM-850 edit and void enforce preparer finance payroll and tenant authority without writes", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing draft");
  const foreignOrg = await s.t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Foreign synthetic", createdAt: Date.now() });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: s.ownerId, roleId });
    return orgId;
  });
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(edit, { ...s.payload, draftId: draft._id })).rejects.toThrow(/OPENING_CHANGE_PREPARER/);
  await expect(s.employee.mutation(edit, { ...s.payload, draftId: draft._id })).rejects.toThrow(/permission|authorized/i);
  await expect(s.owner.mutation(edit, { ...s.payload, orgId: foreignOrg, draftId: draft._id })).rejects.toThrow(/not found|organization/i);
  await expect(s.owner.mutation(requestVoid, { orgId: foreignOrg, draftId: draft._id, reason: "Foreign" })).rejects.toThrow(/not found|organization/i);
  await expect(s.owner.mutation(approveVoid, { orgId: foreignOrg, draftId: draft._id })).rejects.toThrow(/not found|organization/i);
  expect(await entireDatabase(s)).toEqual(before);
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0, orgId: s.orgId, draftId: draft._id });
  const postedBefore = await entireDatabase(s);
  await expect(s.owner.mutation(edit, { ...s.payload, draftId: draft._id })).rejects.toThrow(/OPENING_CHANGE_STATE/);
  await expect(s.employee.mutation(requestVoid, { orgId: s.orgId, draftId: draft._id, reason: "Denied" })).rejects.toThrow(/permission|authorized/i);
  await expect(s.employee.mutation(approveVoid, { orgId: s.orgId, draftId: draft._id })).rejects.toThrow(/permission|authorized/i);
  expect(await entireDatabase(s)).toEqual(postedBefore);
}));

// Explicit registrations let SCRUM-761 bind each case to one permanent record.
async function consumedOpeningRefuses(family: "payable" | "advance" | "prepaid" | "commission" | "deposit" | "vehicle" | "receivable" | "partner" | "missing") {
  return withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  await request(s, draftId);
  await s.t.run(async (ctx) => {
    if (family === "payable") { const row = await ctx.db.query("vehicleSupplierPayables").first(); if (row) await ctx.db.patch(row._id, { amountPaid: 1 }); }
    if (family === "advance") { const row = await ctx.db.query("employeeAdvances").first(); if (row) await ctx.db.patch(row._id, { recoveredMinor: 1 }); }
    if (family === "prepaid") { const row = await ctx.db.query("prepaidExpenseSchedules").first(); if (row) await ctx.db.patch(row._id, { recognizedMinor: 1 }); }
    if (family === "commission") { const row = await ctx.db.query("openingCommissionLiabilities").first(); if (row) await ctx.db.patch(row._id, { paidMinor: 1 }); }
    if (family === "deposit") { const row = await ctx.db.query("deposits").first(); if (row) await ctx.db.patch(row._id, { status: "REFUNDED" }); }
    if (family === "vehicle") { const row = await ctx.db.query("vehicles").first(); if (row) await ctx.db.patch(row._id, { status: "SOLD" }); }
    if (family === "receivable") { const row = await ctx.db.query("receivables").first(); if (row) await ctx.db.patch(row._id, { outstandingAmount: 1 }); }
    if (family === "partner") { const row = await ctx.db.query("partnerEquity").first(); if (row) await ctx.db.patch(row._id, { openingBalanceMinor: 1 }); }
    if (family === "missing") { const row = await ctx.db.query("receivableDocuments").first(); if (row) await ctx.db.delete(row._id); }
  });
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId })).rejects.toThrow(/OPENING_VOID_CONFLICT/);
  expect(await entireDatabase(s)).toEqual(before);
  });
}
test("SCRUM-850 consumed or damaged opening payable refuses without changing any table", () => consumedOpeningRefuses("payable"));
test("SCRUM-850 consumed or damaged opening advance refuses without changing any table", () => consumedOpeningRefuses("advance"));
test("SCRUM-850 consumed or damaged opening prepaid refuses without changing any table", () => consumedOpeningRefuses("prepaid"));
test("SCRUM-850 consumed or damaged opening commission refuses without changing any table", () => consumedOpeningRefuses("commission"));
test("SCRUM-850 consumed or damaged opening deposit refuses without changing any table", () => consumedOpeningRefuses("deposit"));
test("SCRUM-850 consumed or damaged opening vehicle refuses without changing any table", () => consumedOpeningRefuses("vehicle"));
test("SCRUM-850 consumed or damaged opening receivable refuses without changing any table", () => consumedOpeningRefuses("receivable"));
test("SCRUM-850 consumed or damaged opening partner refuses without changing any table", () => consumedOpeningRefuses("partner"));
test("SCRUM-850 consumed or damaged opening missing refuses without changing any table", () => consumedOpeningRefuses("missing"));

test("SCRUM-850 unposted management dependencies and closed periods refuse an opening void", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await s.owner.mutation(api.openingManagementSettlement.draft, { orgId: s.orgId, openingDraftId: draftId, totalMinor: 70_007,
    firstEffectiveMonth: s.asOfDate, supportingReference: "Synthetic historical consumed service", classificationAttestation: "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL", expectedCurrency: "JOD", idempotencyKey: "s850-plan" });
  const before = await entireDatabase(s);
  await expect(request(s, draftId)).rejects.toThrow(/OPENING_VOID_CONFLICT/);
  expect(await entireDatabase(s)).toEqual(before);
  await s.t.run(async (ctx) => { const plan = await ctx.db.query("openingManagementSettlementPlans").first(); if (plan) await ctx.db.delete(plan._id); await ctx.db.patch(s.period._id, { status: "CLOSED" }); });
  const closedBefore = await entireDatabase(s);
  await expect(request(s, draftId)).rejects.toThrow(/OPENING_VOID_PERIOD/);
  expect(await entireDatabase(s)).toEqual(closedBefore);
}));

// Explicit registrations let SCRUM-761 bind each case to one permanent record.
async function unpostedSourceReferencesPreventVoid(child: "payroll" | "payment-intent") {
  return withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  await request(s, draftId);
  await s.t.run(async (ctx) => {
    if (child === "payroll") {
      const liability = await ctx.db.query("openingCommissionLiabilities").unique();
      if (!liability) throw new Error("Missing liability");
      const runId = await ctx.db.insert("payrollRuns", { orgId: s.orgId, periodYear: new Date(s.asOfDate).getUTCFullYear(), periodMonth: 1,
        currency: "JOD", status: "DRAFT", totalGrossMinor: 160_003, totalNetMinor: 160_003, createdBy: s.ownerId, createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("payrollItems", { orgId: s.orgId, runId, userId: s.employeeId, baseSalaryMinor: 0, commissionMinor: 160_003,
        otherEarningsMinor: 0, advanceDeductionMinor: 0, otherDeductionMinor: 0, grossMinor: 160_003, netMinor: 160_003, currency: "JOD",
        commissionSaleIds: [], openingCommissionLiabilityIds: [liability._id], openingCommissionMinor: 160_003, createdAt: Date.now() });
    } else {
      const debt = await ctx.db.query("receivables").unique();
      if (!debt) throw new Error("Missing receivable");
      await ctx.db.insert("paymentIntents", { orgId: s.orgId, customerId: s.customerId, receivableId: debt._id,
        receivableDocumentId: debt.canonicalReceivableDocumentId, amountMinor: 100_003, currency: "JOD", provider: "synthetic", status: "PENDING",
        idempotencyKey: "s850-legacy-intent", createdBy: s.ownerId, createdAt: Date.now(), updatedAt: Date.now() });
    }
  });
  const before = await entireDatabase(s);
  await expect(s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId })).rejects.toThrow(/OPENING_VOID_CONFLICT/);
  expect(await entireDatabase(s)).toEqual(before);
  });
}
test("SCRUM-850 unposted payroll source references survive and prevent void", () => unpostedSourceReferencesPreventVoid("payroll"));
test("SCRUM-850 unposted payment-intent source references survive and prevent void", () => unpostedSourceReferencesPreventVoid("payment-intent"));

test("SCRUM-850 payroll authority is required for editing and voiding payroll-bearing openings", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  await s.reviewer.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  const draft = await s.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing pending draft");
  await s.t.run((ctx) => ctx.db.patch(s.reviewerRole, { permissions: ["view:finance", "manage:finance", "view:cost_price"] }));
  const beforeEdit = await entireDatabase(s);
  await expect(s.reviewer.mutation(edit, { ...s.payload, draftId: draft._id })).rejects.toThrow(/permission|authorized/i);
  expect(await entireDatabase(s)).toEqual(beforeEdit);
  await s.owner.mutation(api.accountingCutover.approveOpeningBalance, { expectedVersion: 0, orgId: s.orgId, draftId: draft._id });
  const beforeRequest = await entireDatabase(s);
  await expect(s.reviewer.mutation(requestVoid, { orgId: s.orgId, draftId: draft._id, reason: "Payroll denied" })).rejects.toThrow(/permission|authorized/i);
  expect(await entireDatabase(s)).toEqual(beforeRequest);
  await request(s, draft._id);
  const beforeApprove = await entireDatabase(s);
  await expect(s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId: draft._id })).rejects.toThrow(/permission|authorized/i);
  expect(await entireDatabase(s)).toEqual(beforeApprove);
}));

test("SCRUM-850 an unlisted materialized opening advance prevents void without writes", async () => withFrozenScheduler(async () => {
  const s = await fixture(true);
  const draftId = await posted(s);
  await s.t.run(async (ctx) => {
    const advance = await ctx.db.query("employeeAdvances").unique();
    if (!advance) throw new Error("Missing advance");
    await ctx.db.insert("employeeAdvances", { orgId: s.orgId, userId: s.employeeId, amountMinor: 7_003,
      recoveredMinor: 0, currency: "JOD", date: s.asOfDate, status: "OUTSTANDING", openingBalanceDraftId: draftId,
      createdBy: s.ownerId, createdAt: Date.now(), updatedAt: Date.now() });
  });
  const before = await entireDatabase(s);
  await expect(request(s, draftId)).rejects.toThrow(/OPENING_VOID_CONFLICT/);
  expect(await entireDatabase(s)).toEqual(before);
}));

test("SCRUM-850 generic reversal cannot undo the governed opening void journal", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await request(s, draftId);
  const { reversalJournalId } = await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  const eventId = await s.t.run((ctx) => ctx.db.insert("accountingEvents", { orgId: s.orgId, eventType: "EMPLOYEE_ADVANCE_PAID",
    sourceType: "employeeAdvances", sourceId: "s850-mislinked", eventVersion: 1, idempotencyKey: "s850-mislinked",
    occurredAt: s.asOfDate, accountingDate: s.asOfDate, currency: "JOD", payload: {}, status: "POSTED",
    createdBy: s.ownerId, createdAt: Date.now(), journalEntryId: reversalJournalId }));
  const before = await entireDatabase(s);
  await expect(s.owner.mutation(internal.accountingLedger.reverse, { orgId: s.orgId, originalEventId: eventId,
    reversalDate: s.asOfDate, reason: "Mislinked event must refuse", idempotencyKey: "s850-reverse-void" })).rejects.toThrow(/opening balance/i);
  expect(await entireDatabase(s)).toEqual(before);
}));

test("SCRUM-850 a damaged governed reversal never authorizes a fresh opening", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await request(s, draftId);
  const { reversalJournalId } = await s.reviewer.mutation(approveVoid, { orgId: s.orgId, draftId });
  await s.t.run(async (ctx) => {
    const line = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", reversalJournalId)).first();
    if (!line) throw new Error("Missing reversal line");
    await ctx.db.patch(line._id, { creditMinor: line.creditMinor + 1 });
  });
  const before = await entireDatabase(s);
  await expect(s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload)).rejects.toThrow(/OPENING_BALANCE_AFTER_LEDGER_ACTIVITY/);
  await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, s.payload)).rejects.toThrow(/OPENING_BALANCE_AFTER_LEDGER_ACTIVITY/);
  expect(await entireDatabase(s)).toEqual(before);
}));

test("SCRUM-850 ambiguous posted opening headers refuse a void without writes", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const draftId = await posted(s);
  await s.t.run(async (ctx) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error("Missing opening");
    await ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "POSTED", lines: draft.lines,
      currency: draft.currency, asOfDate: draft.asOfDate, createdBy: s.ownerId, createdAt: Date.now(), journalEntryId: draft.journalEntryId });
  });
  const before = await entireDatabase(s);
  await expect(request(s, draftId)).rejects.toThrow(/OPENING_VOID_CONFLICT/);
  expect(await entireDatabase(s)).toEqual(before);
}));
