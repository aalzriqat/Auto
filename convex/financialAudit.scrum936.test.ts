import { expect, test } from "vitest";
import type { FunctionArgs } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import * as financialAudit from "./financialAudit";
import { newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";

type OpeningInput = FunctionArgs<typeof api.accountingCutover.draftOpeningBalance>;
type AuditRow = Doc<"financialAuditLog">;

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST SCRUM-936", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "s936-owner", email: "owner@example.test" });
    const reviewerId = await ctx.db.insert("users", { clerkId: "s936-reviewer", email: "reviewer@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "s936-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeRole = await ctx.db.insert("roles", { orgId, name: "FINANCE_ONLY", permissions: ["view:finance", "manage:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: financeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL" });
    return { orgId, ownerId, reviewerId, employeeId, financeRole };
  });
  const owner = t.withIdentity({ subject: "s936-owner" });
  const reviewer = t.withIdentity({ subject: "s936-reviewer" });
  const finance = t.withIdentity({ subject: "s936-employee" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId });
  function account(key: string) {
    const row = accounts.find(a => a.systemKey === key);
    if (!row) throw new Error(`Missing fixture account ${key}`);
    return row._id;
  }
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", { orgId: ids.orgId,
    vin: "S936-ONLY-CAR", make: "Synthetic", model: "Opening", year: 2024, mileage: 0,
    color: "Gray", fuelType: "Petrol", transmission: "Automatic", status: "AVAILABLE",
    sourceType: "STOCK", purchasePrice: 1000, sellingPrice: 2000,
  }));
  return { t, owner, reviewer, finance, ...ids, asOfDate, account, vehicleId };
}
type Seed = Awaited<ReturnType<typeof fixture>>;

async function expectCostReaderRefusals(s: Seed) {
  await expect(s.finance.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/permission/i);
  await expect(s.finance.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(/permission/i);
  await expect(s.finance.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId,
    paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow(/permission/i);
}

async function assertAllBranches(s: Seed, row: AuditRow, forbidden: readonly string[]) {
  for (const filter of [{}, { actorId: row.actorId }, { actionType: row.actionType }, { fromDate: 1 }]) {
    const args = { orgId: s.orgId, ...filter, limit: 200 };
    const rows = await s.finance.query(api.financialAudit.listAuditLog, args);
    const restricted = rows.find(r => r._id === row._id);
    expect(restricted).toBeDefined();
    expect(restricted).toMatchObject({ actorId: row.actorId, actionType: row.actionType,
      resourceType: row.resourceType, resourceId: "WITHHELD", occurredAt: row.occurredAt });
    const text = JSON.stringify(restricted);
    for (const secret of forbidden) expect(text).not.toContain(secret);
    expect(await s.owner.query(api.financialAudit.listAuditLog, args)).toContainEqual(row);
  }
  // An explicit grant on a non-owner is a separate positive control.
  const role = await s.t.run(ctx => ctx.db.get(s.financeRole));
  if (!role) throw new Error("Missing fixture role");
  const grants = row.actionType === "ADD_DEAL_COMMISSION_LINE" || row.actionType === "REMOVE_DEAL_COMMISSION_LINE" || row.actionType === "SET_COMMISSION_AMOUNT"
    ? ["view:commissions"] : ["view:cost_price", "view:payroll", "manage:payroll"];
  await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: [...role.permissions, ...grants] }));
  for (const filter of [{}, { actorId: row.actorId }, { actionType: row.actionType }, { fromDate: 1 }]) {
    expect(await s.finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId, ...filter, limit: 200 })).toContainEqual(row);
  }
  await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: role.permissions }));
  // Read-time projection does not erase or rewrite the retained evidence.
  expect(await s.t.run(ctx => ctx.db.get(row._id))).toEqual(row);
}

async function postedOpening(kind: "VEHICLE_INVENTORY" | "EMPLOYEE_ADVANCE", door: "direct" | "approve") {
  await withFrozenScheduler(async () => {
    const s = await fixture();
    // No unrelated unimported stock may exist at the cutover boundary.
    await s.t.run(ctx => ctx.db.delete(s.vehicleId));
    const amountMinor = kind === "VEHICLE_INVENTORY" ? 1_000_000 : 110_003;
    if (kind === "VEHICLE_INVENTORY") {
      // Import through the public opening-stock door, which records provenance.
      await s.owner.mutation(api.vehicles.importBulk, { orgId: s.orgId, acquisitionPosting: "OPENING_STOCK", importId: "s936-stock",
        vehicles: [{ rowId: 1, make: "Synthetic", model: "Stock", year: 2024, mileage: 0, color: "Gray",
          fuelType: "Petrol", transmission: "Automatic", purchasePrice: 1000, sellingPrice: 2000, sourceType: "STOCK", vin: "S936STOCK000001" }] });
    }
    const vehicle = await s.t.run(ctx => ctx.db.query("vehicles").withIndex("by_org", q => q.eq("orgId", s.orgId)).collect());
    const stock = vehicle.find(v => v.vin === "S936STOCK000001");
    const allocation: NonNullable<OpeningInput["allocations"]>[number] = kind === "EMPLOYEE_ADVANCE"
      ? { kind, rowKey: "only", accountId: s.account("EMPLOYEE_ADVANCES"), userId: s.employeeId, amountMinor }
      : { kind, rowKey: "only", accountId: s.account("VEHICLE_INVENTORY"), vehicleId: stock!._id, amountMinor };
    const input: OpeningInput = { orgId: s.orgId, asOfDate: s.asOfDate, expectedCurrency: "JOD", lines: [
      { accountId: allocation.accountId, debitMinor: amountMinor, creditMinor: 0 },
      { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: amountMinor },
    ], allocations: [allocation] };
    await expectCostReaderRefusals(s);
    if (door === "direct") await s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, input);
    else {
      await s.owner.mutation(api.accountingCutover.draftOpeningBalance, input);
      const draft = await s.t.run(ctx => ctx.db.query("openingBalanceDrafts").unique());
      if (!draft) throw new Error("Missing fixture draft");
      expect(await s.finance.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId })).toEqual([]);
      await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId: draft._id, expectedVersion: 0 });
    }
    const row = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q =>
      q.eq("orgId", s.orgId).eq("actionType", "POST_MANUAL_JOURNAL")).unique());
    if (!row) throw new Error("Missing posted-opening audit");
    // Authorized positive control has the actual structured total.
    expect(row.after).toMatchObject({ totalDebits: amountMinor, lines: 2 });
    await assertAllBranches(s, row, [String(amountMinor), String(kind === "EMPLOYEE_ADVANCE" ? s.employeeId : stock!._id)]);
    await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: ["view:finance", "manage:finance", "view:cost_price"] }));
    const readback = await s.finance.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId });
    if (kind === "EMPLOYEE_ADVANCE") {
      expect(readback?.rows).toEqual([{ kind, restricted: true }]);
      await assertAllBranches(s, row, [String(amountMinor), String(s.employeeId)]);
      await s.owner.mutation(api.openingBalanceMaintenance.requestVoid, { orgId: s.orgId, draftId: readback!.draftId,
        reason: "private payroll void 110003" });
      await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: ["view:finance", "manage:finance", "view:cost_price", "view:payroll"] }));
      expect(await s.finance.query(api.openingBalanceMaintenance.status, { orgId: s.orgId })).toMatchObject({ voidReason: null });
      const voidRow = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q =>
        q.eq("orgId", s.orgId).eq("actionType", "REQUEST_OPENING_VOID")).unique());
      if (!voidRow) throw new Error("Missing void audit");
      await assertAllBranches(s, voidRow, ["private payroll void", "110003"]);
    } else {
      expect(readback?.rows[0]).toMatchObject({ amountMinor: 1_000_000, restricted: false });
      expect(await s.finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId })).toContainEqual(row);
    }
    expect(row.description).not.toContain(String(amountMinor));
  });
}

test("SCRUM-936 owner-direct singleton vehicle posting audit inherits cost withholding", async () => postedOpening("VEHICLE_INVENTORY", "direct"), 30_000);
test("SCRUM-936 approved singleton vehicle posting audit inherits cost withholding", async () => postedOpening("VEHICLE_INVENTORY", "approve"), 30_000);
test("SCRUM-936 owner-direct singleton employee posting audit inherits payroll withholding", async () => postedOpening("EMPLOYEE_ADVANCE", "direct"), 30_000);
test("SCRUM-936 approved singleton employee posting audit inherits payroll withholding", async () => postedOpening("EMPLOYEE_ADVANCE", "approve"), 30_000);

test("SCRUM-936 legacy opening edit draft and total copies are projected in every branch", async () => {
  const s = await fixture();
  await expectCostReaderRefusals(s);
  for (const after of [{ totalDebits: 1_000_000, lineCount: 2 },
    { lines: [{ vehicleId: s.vehicleId, debitMinor: 1_000_000 }], allocations: [{ userId: s.employeeId, amountMinor: 110_003 }], memo: "private opening 1000000" }]) {
    const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
      actionType: "EDIT_OPENING_DRAFT", resourceType: "openingBalanceDrafts", resourceId: "legacy-draft",
      description: "Draft changed 1000000 total", before: { totalDebits: 110_003, userId: s.employeeId }, after,
      idempotencyKey: `private-${s.employeeId}-1000000`, occurredAt: Date.now() }));
    const row = await s.t.run(ctx => ctx.db.get(id));
    if (!row) throw new Error("Missing legacy edit");
    await assertAllBranches(s, row, ["1000000", "110003", String(s.vehicleId), String(s.employeeId), "private opening"]);
  }
  const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId,
    status: "PENDING_APPROVAL", createdBy: s.ownerId, createdAt: Date.now(), asOfDate: s.asOfDate, currency: "JOD",
    lines: [{ accountId: s.account("CASH_ON_HAND"), debitMinor: 200_003, creditMinor: 0 },
      { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 200_003 }] }));
  const legacyId = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
    actionType: "EDIT_OPENING_DRAFT", resourceType: "openingBalanceDrafts", resourceId: draftId,
    description: "Old employee removed", before: { allocations: [{ kind: "EMPLOYEE_ADVANCE", userId: s.employeeId, amountMinor: 110_003 }], totalDebits: 110_003 },
    after: { version: 1, lineCount: 2 }, occurredAt: Date.now() }));
  await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: ["view:finance", "manage:finance", "view:cost_price"] }));
  expect(await s.finance.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId })).toHaveLength(1);
  const legacyRow = await s.t.run(ctx => ctx.db.get(legacyId));
  if (!legacyRow) throw new Error("Missing historical employee edit");
  await assertAllBranches(s, legacyRow, ["110003", String(s.employeeId)]);
});

test("SCRUM-936 legacy posted manual journal totals and memo are withheld while pilot posting stays blocked", async () => {
  const s = await fixture();
  await expectCostReaderRefusals(s);
  await expect(s.owner.mutation(api.financialAudit.createManualJournal, { orgId: s.orgId, memo: "private 1000000",
    lines: [{ accountId: s.account("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000_000 }],
    accountingDate: s.asOfDate, idempotencyKey: "legacy-control" })).rejects.toThrow(/pilot/i);
  // A pending manual draft has a broader existing audience than a posted journal.
  const pendingId = await s.t.run(ctx => ctx.db.insert("manualJournalDrafts", { orgId: s.orgId,
    status: "PENDING_APPROVAL", memo: "Pending manual 1000000", lines: [
      { accountId: s.account("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000_000 },
    ], accountingDate: s.asOfDate, idempotencyKey: "legacy-pending", createdBy: s.ownerId, createdAt: Date.now() }));
  const pendingAuditId = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId,
    actorId: s.ownerId, actionType: "CREATE_MANUAL_JOURNAL_DRAFT", resourceType: "manualJournalDrafts", resourceId: pendingId,
    description: "Manual journal draft submitted for approval: Pending manual 1000000", after: { lines: 2 }, occurredAt: Date.now() }));
  expect(await s.finance.query(api.financialAudit.listPendingManualJournals, { orgId: s.orgId })).toEqual([
    expect.objectContaining({ _id: pendingId, memo: "Pending manual 1000000" }),
  ]);
  expect(await s.finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId })).toContainEqual(
    await s.t.run(ctx => ctx.db.get(pendingAuditId)));
  const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
    actionType: "POST_MANUAL_JOURNAL", resourceType: "journalEntries", resourceId: "legacy-journal",
    description: "Manual journal posted: private 1000000", after: { totalDebits: 1_000_000, lines: 2, draftId: "private-draft" }, occurredAt: Date.now() }));
  const row = await s.t.run(ctx => ctx.db.get(id));
  if (!row) throw new Error("Missing legacy manual row");
  await assertAllBranches(s, row, ["1000000", "private-draft", "private 1000000"]);
});

async function saleFixture(s: Seed) {
  return s.t.run(async ctx => {
    const customerId = await ctx.db.insert("customers", { orgId: s.orgId, firstName: "Synthetic", lastName: "Customer" });
    return ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId, salespersonId: s.ownerId,
      salePrice: 2000, saleDate: Date.now(), status: "PENDING", financingType: "CASH" });
  });
}

async function commissionLineAudit(actionType: "ADD_DEAL_COMMISSION_LINE" | "REMOVE_DEAL_COMMISSION_LINE") {
  await withFrozenScheduler(async () => {
  const s = await fixture();
  const saleId = await saleFixture(s);
  await s.t.run(ctx => ctx.db.patch(saleId, { status: "COMPLETED" }));
  await expect(s.finance.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId })).rejects.toThrow(/permission/i);
  const lineId = await s.owner.mutation(api.dealCommissions.addLine, { orgId: s.orgId, saleId, employeeId: s.employeeId,
    kind: "PURCHASE", amount: 110.003, note: "private commission note" });
  const view = await s.owner.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId });
  expect(view.lines[0]).toMatchObject({ amountMinor: 110_003, employeeId: s.employeeId });
  await s.owner.mutation(api.dealCommissions.removeLine, { orgId: s.orgId, lineId });
    const row = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q => q.eq("orgId", s.orgId).eq("actionType", actionType)).unique());
    if (!row) throw new Error("Missing commission audit");
    await assertAllBranches(s, row, ["110003", String(s.employeeId), String(lineId), "private commission note"]);
  });
}
test("SCRUM-936 adding a deal commission audit inherits the commission reader gate", async () => commissionLineAudit("ADD_DEAL_COMMISSION_LINE"), 30_000);
test("SCRUM-936 removing a deal commission audit inherits the commission reader gate", async () => commissionLineAudit("REMOVE_DEAL_COMMISSION_LINE"), 30_000);

test("SCRUM-936 setting a sale commission audit inherits its dedicated reader gate", async () => withFrozenScheduler(async () => {
  const s = await fixture();
  const saleId = await saleFixture(s);
  await expect(s.finance.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId })).rejects.toThrow(/permission/i);
  await expect(s.finance.query(api.sales.get, { orgId: s.orgId, saleId })).rejects.toThrow(/permission/i);
  await s.owner.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId, commissionAmount: 110.003 });
  const row = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q => q.eq("orgId", s.orgId).eq("actionType", "SET_COMMISSION_AMOUNT")).unique());
  if (!row) throw new Error("Missing commission decision audit");
  expect(await s.owner.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId })).toMatchObject({ salesperson: { amountMinor: 110_003 } });
  await assertAllBranches(s, row, ["110.003", "110003"]);
}), 30_000);

async function historicalCostAudit(actionType: "MIGRATE_TRANSACTION" | "ALLOCATE_PAYMENT" | "REVERSE_ALLOCATION") {
  const s = await fixture();
  await expectCostReaderRefusals(s);
  await expect(s.finance.query(api.supplierCostRecoveries.list, { orgId: s.orgId })).rejects.toThrow(/permission/i);
    const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId, actionType,
      resourceType: actionType === "MIGRATE_TRANSACTION" ? "sales" : actionType === "ALLOCATE_PAYMENT" ? "supplierCostRecoveries" : "supplierCostRecoveryReceipts", resourceId: "legacy-resource",
      description: "Historical cost 1000000", before: { cogsMinor: 1_000_000, amountRecoveredMinor: 0 },
      after: { amountRecoveredMinor: 1_000_000, vehicleId: s.vehicleId }, occurredAt: Date.now() }));
    const row = await s.t.run(ctx => ctx.db.get(id));
    if (!row) throw new Error("Missing legacy cost row");
    await assertAllBranches(s, row, ["1000000", String(s.vehicleId)]);
}
test("SCRUM-936 historical consigned migration COGS audit inherits cost reader gates", async () => historicalCostAudit("MIGRATE_TRANSACTION"));
test("SCRUM-936 historical supplier cost receipt audit inherits cost reader gates", async () => historicalCostAudit("ALLOCATE_PAYMENT"));
test("SCRUM-936 historical supplier cost receipt reversal audit inherits cost reader gates", async () => historicalCostAudit("REVERSE_ALLOCATION"));

test("SCRUM-936 every stored audit action has an explicit reader classification", () => {
  const actions = schema.tables.financialAuditLog.validator.fields.actionType.members.map(m => m.value);
  // Transitional namespace access lets this failing-first test run before the table exists.
  const policy = (financialAudit as unknown as { AUDIT_READ_POLICY?: Record<string, unknown> }).AUDIT_READ_POLICY;
  expect(policy).toBeDefined();
  expect(Object.keys(policy ?? {}).sort()).toEqual([...actions].sort());
});

test("SCRUM-936 restricted posted events retain their line count without source text", async () => {
  const s = await fixture();
  await expectCostReaderRefusals(s);
  const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
    actionType: "POST_EVENT", resourceType: "journalEntries", resourceId: "legacy-post",
    description: "Posted protected-source-1000000", after: { lineCount: 2, journalNumber: "private journal" }, occurredAt: Date.now() }));
  for (const filter of [{}, { actorId: s.ownerId }, { actionType: "POST_EVENT" }, { fromDate: 1 }]) {
    const row = (await s.finance.query(api.financialAudit.listAuditLog, { orgId: s.orgId, ...filter })).find(r => r._id === id);
    expect(row).toMatchObject({ lineCount: 2, resourceId: "WITHHELD" });
    expect(JSON.stringify(row)).not.toContain("protected-source");
  }
});

test("SCRUM-936 unwind actors retain permitted remittance amounts while finance text stays withheld", async () => withFrozenScheduler(async () => {
  const s = await seedFinancedDealership("s936-unwind", { modules: import.meta.glob("./**/*.*s"),
    ownerPerms: [], actors: { operator: ["manage:finance", "view:sales", "cancel:closed_deal", "confirm:finance_disbursement"] },
    label: "QA TEST SCRUM-936", vinPrefix: "S936" });
  registerRateLimiter(s.t);
  const { applicationId } = await newApplication(s);
  const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId,
    customerId: s.customerId, salespersonId: s.owner.userId, salePrice: 12500, saleDate: Date.now(), status: "CANCELLED", financingType: "FINANCED" }));
  await s.t.run(ctx => ctx.db.insert("dealUnwinds", { orgId: s.orgId, applicationId, saleId,
    status: "ABANDONED", reason: "private finance reason", startedBy: s.owner.userId, startedAt: Date.now(),
    remittanceVersion: 1, remittanceMinor: 12_500_000, remittanceMethod: "CASH", forwardDueMinor: 1_575_000,
    createdAt: Date.now(), updatedAt: Date.now() }));
  const view = await s.actors.operator.as.query(api.dealUnwind.unwindStatus, { orgId: s.orgId, applicationId });
  expect(view.evidence).toMatchObject({ remittanceMinor: 12_500_000, reason: null, forwardDueMinor: null });
  const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.owner.userId,
    actionType: "DEAL_UNWIND_STARTED", resourceType: "financeApplications", resourceId: applicationId,
    description: "Deal unwind started: private finance reason", after: { remittanceMinor: 12_500_000, remittanceMethod: "CASH", forwardDueMinor: 1_575_000 }, occurredAt: Date.now() }));
  for (const filter of [{}, { actorId: s.owner.userId }, { actionType: "DEAL_UNWIND_STARTED" }, { fromDate: 1 }]) {
    const row = (await s.actors.operator.as.query(api.financialAudit.listAuditLog, { orgId: s.orgId, ...filter })).find(r => r._id === id);
    expect(row?.after).toEqual({ remittanceMinor: 12_500_000, remittanceMethod: "CASH" });
    expect(JSON.stringify(row)).not.toContain("private finance reason");
    expect(JSON.stringify(row)).not.toContain("1575000");
  }
}), 30_000);
