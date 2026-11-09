import { expect, test } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { QueryCtx } from "./_generated/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import * as financialAudit from "./financialAudit";
import { AUDIT_READ_POLICY } from "./utils/financialAuditProjection";
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

test("SCRUM-936 audit pages reuse payroll controls and decisions per draft and request", async () => {
  const s = await fixture();
  await s.t.run(ctx => ctx.db.patch(s.financeRole, { permissions: ["manage:finance", "view:finance", "view:cost_price"] }));
  const drafts = await s.t.run(async ctx => {
    const ids = [];
    for (const payroll of [false, true]) {
      const journalEntryId = await ctx.db.insert("journalEntries", { orgId: s.orgId, accountingDate: s.asOfDate, journalNumber: `QA-${payroll}`,
        category: "OPENING_BALANCE", sourceType: "OPENING_BALANCE", sourceId: `synthetic-${payroll}`,
        memo: "Synthetic opening", status: "POSTED", currency: "JOD", createdAt: Date.now(), postedAt: Date.now(), postedBy: s.ownerId });
      const draftId = await ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "POSTED",
        createdBy: s.ownerId, createdAt: Date.now(), asOfDate: s.asOfDate, currency: "JOD", journalEntryId,
        lines: [...Array.from({ length: 40 }, () => ({ accountId: s.account("CASH_ON_HAND"), debitMinor: 1, creditMinor: 0 })),
          { accountId: s.account(payroll ? "COMMISSION_PAYABLE" : "RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 40 }] });
      ids.push({ draftId, journalEntryId, payroll });
    }
    for (let index = 0; index < 200; index += 1) {
      const draft = ids[index % 2];
      const journal = index % 4 < 2;
      await ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
        actionType: journal ? "POST_MANUAL_JOURNAL" : "REQUEST_OPENING_VOID",
        resourceType: journal ? "journalEntries" : "openingBalanceDrafts",
        resourceId: journal ? draft.journalEntryId : draft.draftId,
        description: "Synthetic protected evidence", after: { totalDebits: 40 }, occurredAt: Date.now() + index });
    }
    return ids;
  });
  const handler: unknown = Reflect.get(financialAudit.listAuditLog, "_handler");
  if (typeof handler !== "function") throw new Error("Registered audit query unavailable");
  const invoke = handler as (ctx: QueryCtx, args: FunctionArgs<typeof api.financialAudit.listAuditLog>) => Promise<FunctionReturnType<typeof api.financialAudit.listAuditLog>>;
  const draftIds = new Set(drafts.map(row => row.draftId as string));
  const totals = { accountGets: 0, draftGets: 0, controlLookups: 0 };
  const args = { orgId: s.orgId, limit: 200 };
  const observe = () => s.finance.query(ctx => invoke({ ...ctx, db: new Proxy(ctx.db, { get(db, key) {
    if (key === "get") return async (...params: Parameters<typeof db.get>) => {
      const id = String(params.at(-1));
      if (db.normalizeId("chartOfAccounts", id)) totals.accountGets += 1;
      if (draftIds.has(id)) totals.draftGets += 1;
      return Reflect.apply(db.get, db, params);
    };
    if (key === "query") return (table: Parameters<typeof db.query>[0]) => {
      if (table === "chartOfAccounts") totals.controlLookups += 1;
      return db.query(table);
    };
    const value: unknown = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  } }) }, args));
  const rows = await observe();
  expect(rows).toEqual(await s.finance.query(api.financialAudit.listAuditLog, args));
  expect(rows).toHaveLength(200);
  expect(rows.filter(row => row.detailsWithheld)).toHaveLength(100);
  expect(rows.filter(row => !row.detailsWithheld)).toHaveLength(100);
  expect(totals.accountGets).toBe(0);
  expect(totals.controlLookups).toBe(2);
  expect(totals.draftGets).toBeLessThanOrEqual(2);
  // A new request must not reuse an earlier request's permission decision.
  await s.t.run(ctx => ctx.db.patch(drafts[0].draftId, { lines: [
    { accountId: s.account("EMPLOYEE_ADVANCES"), debitMinor: 40, creditMinor: 0 },
  ] }));
  expect((await observe()).every(row => row.detailsWithheld)).toBe(true);
  expect(totals.controlLookups).toBe(4);
});

async function expectCostReaderRefusals(s: Seed) {
  await expect(s.finance.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/permission/i);
  await expect(s.finance.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(/permission/i);
  await expect(s.finance.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId,
    paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow(/permission/i);
}

async function assertAllBranches(s: Seed, row: AuditRow, forbidden: readonly string[], lineCount?: number) {
  for (const filter of [{}, { actorId: row.actorId }, { actionType: row.actionType }, { fromDate: 1 }]) {
    const args = { orgId: s.orgId, ...filter, limit: 200 };
    const rows = await s.finance.query(api.financialAudit.listAuditLog, args);
    const restricted = rows.find(r => r._id === row._id);
    expect(restricted).toBeDefined();
    expect(restricted).toMatchObject({ actorId: row.actorId, actionType: row.actionType,
      resourceType: row.resourceType, resourceId: "WITHHELD", occurredAt: row.occurredAt });
    if (lineCount !== undefined) expect(restricted).toMatchObject({ lineCount });
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
    await assertAllBranches(s, row, [String(amountMinor), String(kind === "EMPLOYEE_ADVANCE" ? s.employeeId : stock!._id)], 2);
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
  for (const { after, lineCount } of [{ after: { totalDebits: 1_000_000, lineCount: 2 }, lineCount: 2 },
    { after: { lines: [{ vehicleId: s.vehicleId, debitMinor: 1_000_000 }], allocations: [{ userId: s.employeeId, amountMinor: 110_003 }], memo: "private opening 1000000" }, lineCount: 1 }]) {
    const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.ownerId,
      actionType: "EDIT_OPENING_DRAFT", resourceType: "openingBalanceDrafts", resourceId: "legacy-draft",
      description: "Draft changed 1000000 total", before: { totalDebits: 110_003, userId: s.employeeId }, after,
      idempotencyKey: `private-${s.employeeId}-1000000`, occurredAt: Date.now() }));
    const row = await s.t.run(ctx => ctx.db.get(id));
    if (!row) throw new Error("Missing legacy edit");
    await assertAllBranches(s, row, ["1000000", "110003", String(s.vehicleId), String(s.employeeId), "private opening"], lineCount);
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

async function supplierAuditDetail(operation: "full" | "partial" | "commission" | "recovery") {
  await withFrozenScheduler(async () => {
    const s = await fixture();
    const supplierName = "QA TEST Synthetic Supplier";
    const supplierId = await s.t.run(ctx => ctx.db.insert("suppliers", { orgId: s.orgId,
      displayName: supplierName, displayNameKey: supplierName.toLowerCase(), status: "ACTIVE", version: 1,
      origin: "MANUAL", createdBy: s.ownerId, updatedBy: s.ownerId, createdAt: Date.now(), updatedAt: Date.now() }));
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedSupplierId: supplierId, sourcedFromName: supplierName, sourceCost: 1000 }));
    const common = { orgId: s.orgId, vehicleId: s.vehicleId, supplierId, supplierSnapshotVersion: 1,
      sourcedFromName: supplierName, amountDue: 2, currency: "JOD", createdBy: s.ownerId, createdAt: Date.now(), updatedAt: Date.now() };
    const key = `s936-detail-${operation}`;
    if (operation === "full" || operation === "partial") {
      const payableId = await s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", { ...common, status: "PENDING" }));
      await expect(s.finance.query(api.sourcingPayables.get, { orgId: s.orgId, payableId })).rejects.toThrow(/permission/i);
      if (operation === "full") await s.owner.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: key });
      else await s.owner.mutation(api.sourcingPayables.recordPartialPayment, { orgId: s.orgId, payableId, amount: 1, paymentMethod: "CASH", idempotencyKey: key });
      expect(await s.owner.query(api.sourcingPayables.get, { orgId: s.orgId, payableId })).toMatchObject({ paymentMethod: "CASH", sourcedFromName: supplierName });
    } else if (operation === "commission") {
      const saleId = await saleFixture(s);
      const receivableId = await s.t.run(ctx => ctx.db.insert("vehicleSupplierReceivables", { ...common, saleId, status: "OPEN" }));
      await expect(s.finance.query(api.supplierReceivables.list, { orgId: s.orgId })).rejects.toThrow(/permission/i);
      await s.owner.mutation(api.supplierReceivables.recordReceipt, { orgId: s.orgId, receivableId, amount: 1, receiptMethod: "CASH", idempotencyKey: key });
      expect((await s.owner.query(api.supplierReceivables.list, { orgId: s.orgId })).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ _id: receivableId, receiptMethod: "CASH", sourcedFromName: supplierName }),
      ]));
    } else {
      await expect(s.finance.query(api.supplierCostRecoveries.list, { orgId: s.orgId })).rejects.toThrow(/permission/i);
      await s.owner.mutation(api.expenses.create, { orgId: s.orgId, vehicleId: s.vehicleId, title: "QA TEST synthetic transport",
        amount: 2, date: Date.now() - 1000, category: "TRANSPORT", status: "PAID", paymentMethod: "CASH",
        costBearer: "SUPPLIER", vendorSupplierId: supplierId, idempotencyKey: `${key}-expense` });
      const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").withIndex("by_org", q => q.eq("orgId", s.orgId)).unique());
      if (!recovery) throw new Error("Missing synthetic recovery");
      await s.owner.mutation(api.supplierCostRecoveries.recordReceipt, { orgId: s.orgId, recoveryId: recovery._id,
        amountMinor: 1000, method: "CASH", receivedDate: Date.now() - 500, idempotencyKey: key });
    }
    const row = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action_idempotency", q =>
      q.eq("orgId", s.orgId).eq("actionType", "ALLOCATE_PAYMENT").eq("idempotencyKey", key)).unique());
    if (!row) throw new Error("Missing synthetic supplier audit");
    expect(row.after).toMatchObject({ paymentMethod: "CASH", supplierName, amountMinor: operation === "full" ? 2000 : 1000 });
    expect(row.description).not.toMatch(/\d/);
    expect(row.description).not.toContain(supplierName);
    await assertAllBranches(s, row, [supplierName, "CASH", `"amountMinor":${operation === "full" ? 2000 : 1000}`]);
  });
}

test("SCRUM-936 supplier full payment retains authorized structured audit facts", async () => supplierAuditDetail("full"));
test("SCRUM-936 supplier partial payment retains authorized structured audit facts", async () => supplierAuditDetail("partial"));
test("SCRUM-936 supplier commission receipt retains authorized structured audit facts", async () => supplierAuditDetail("commission"));
test("SCRUM-936 supplier cost receipt retains authorized structured audit facts", async () => supplierAuditDetail("recovery"));

test("SCRUM-936 every stored audit action has an explicit reader classification", () => {
  const actions = schema.tables.financialAuditLog.validator.fields.actionType.members.map(m => m.value);
  expect(Object.keys(AUDIT_READ_POLICY).sort()).toEqual([...actions].sort());
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

async function applicationReaders(tag: string) {
  const s = await seedFinancedDealership(tag, { modules: import.meta.glob("./**/*.*s"), ownerPerms: [],
    actors: { finance: ["manage:finance", "view:finance"], sales: ["manage:finance", "view:sales"],
      full: ["manage:finance", "view:finance", "view:sales"] }, label: "QA TEST SCRUM-936", vinPrefix: "S936" });
  registerRateLimiter(s.t);
  const { applicationId } = await newApplication(s);
  return { s, applicationId };
}

async function financeCheque({ s, applicationId }: Awaited<ReturnType<typeof applicationReaders>>) {
  return s.t.run(ctx => ctx.db.insert("postDatedCheques", { orgId: s.orgId, customerId: s.customerId,
    vehicleId: s.vehicleId, applicationId, originApplicationId: applicationId, drawerType: "FINANCE_COMPANY",
    financeCompanyId: s.companyId, bank: "Synthetic", chequeNumber: "S936-CHEQUE", chequeDate: Date.now(),
    amount: 12500, status: "HELD", createdBy: s.owner.userId, createdAt: Date.now(), updatedAt: Date.now() }));
}

test("SCRUM-936 application audit details inherit both sales and finance read gates", async () => withFrozenScheduler(async () => {
  const { s, applicationId } = await applicationReaders("s936-app-gates");
  await s.t.run(ctx => ctx.db.patch(applicationId, { disbursedAmountMinor: 12_500_000 }));
  await expect(s.actors.finance.as.query(api.applications.get, { orgId: s.orgId, applicationId })).rejects.toThrow(/permission/i);
  await expect(s.actors.finance.as.query(api.dealUnwind.unwindStatus, { orgId: s.orgId, applicationId })).rejects.toThrow(/permission/i);
  const salesView = await s.actors.sales.as.query(api.applications.get, { orgId: s.orgId, applicationId });
  expect(salesView?.disbursedAmountMinor).not.toBe(12_500_000);
  const fullView = await s.actors.full.as.query(api.applications.get, { orgId: s.orgId, applicationId });
  expect(fullView?.disbursedAmountMinor).toBe(12_500_000);
  for (const actionType of ["CONFIRM_SUPPLIER_DISBURSEMENT", "AMEND_SUPPLIER_DISBURSEMENT_ADVICE",
    "RETURN_FINANCE_DISBURSEMENT_CHEQUE", "DEAL_UNWIND_STARTED"] as const) {
    const id = await s.t.run(ctx => ctx.db.insert("financialAuditLog", { orgId: s.orgId, actorId: s.owner.userId,
      actionType, resourceType: "financeApplications", resourceId: applicationId,
      description: "Application finance 12500000", after: { disbursedAmountMinor: 12_500_000 }, occurredAt: Date.now() }));
    const original = await s.t.run(ctx => ctx.db.get(id));
    for (const filter of [{}, { actorId: s.owner.userId }, { actionType }, { fromDate: 1 }]) {
      const args = { orgId: s.orgId, ...filter };
      for (const viewer of [s.actors.finance.as, s.actors.sales.as]) {
        const row = (await viewer.query(api.financialAudit.listAuditLog, args)).find(r => r._id === id);
        expect(row).toMatchObject({ resourceId: "WITHHELD", detailsWithheld: true });
        expect(JSON.stringify(row)).not.toContain("12500000");
      }
      expect(await s.actors.full.as.query(api.financialAudit.listAuditLog, args)).toContainEqual(original);
    }
  }
}), 30_000);

test("SCRUM-936 cheque face audit remains visible to its dedicated finance-only reader", async () => withFrozenScheduler(async () => {
  const seed = await applicationReaders("s936-cheque-face");
  const { s } = seed;
  const chequeId = await financeCheque(seed);
  await s.owner.as.mutation(api.applications.attestChequeFace, { orgId: s.orgId, chequeId,
    faceAmount: "12500.000", note: "private-face-12500000" });
  const args = { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } };
  expect((await s.actors.finance.as.query(api.collections.listCheques, args)).page).toContainEqual(
    expect.objectContaining({ _id: chequeId, amountMinor: 12_500_000, faceAttestationNote: "private-face-12500000" }));
  await expect(s.actors.sales.as.query(api.collections.listCheques, args)).rejects.toThrow(/permission/i);
  const original = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q =>
    q.eq("orgId", s.orgId).eq("actionType", "ATTEST_CHEQUE_FACE")).unique());
  if (!original) throw new Error("Missing attestation audit");
  for (const filter of [{}, { actorId: s.owner.userId }, { actionType: "ATTEST_CHEQUE_FACE" }, { fromDate: 1 }]) {
    const query = { orgId: s.orgId, ...filter };
    expect(await s.actors.finance.as.query(api.financialAudit.listAuditLog, query)).toContainEqual(original);
    const hidden = (await s.actors.sales.as.query(api.financialAudit.listAuditLog, query)).find(r => r._id === original._id);
    expect(JSON.stringify(hidden)).not.toContain("12500000");
  }
}), 30_000);

test("SCRUM-936 expected payment audit separates open method metadata from finance cheque evidence", async () => withFrozenScheduler(async () => {
  const seed = await applicationReaders("s936-correction");
  const { s, applicationId } = seed;
  const chequeId = await financeCheque(seed);
  const expectedDate = Date.UTC(s.fiscalYear, 5, 15);
  await s.t.run(ctx => ctx.db.patch(applicationId, { expectedPaymentMethod: "CHEQUE", expectedPaymentDate: expectedDate }));
  expect(await s.actors.sales.as.query(api.applications.get, { orgId: s.orgId, applicationId })).toMatchObject({
    expectedPaymentMethod: "CHEQUE", expectedPaymentDate: expectedDate });
  const cheques = { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } };
  await expect(s.actors.sales.as.query(api.collections.listCheques, cheques)).rejects.toThrow(/permission/i);
  await s.owner.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId,
    reason: "private-correction-12500000" });
  expect((await s.actors.finance.as.query(api.collections.listCheques, cheques)).page).toContainEqual(
    expect.objectContaining({ _id: chequeId, cancellationReason: "private-correction-12500000" }));
  const original = await s.t.run(ctx => ctx.db.query("financialAuditLog").withIndex("by_org_action", q =>
    q.eq("orgId", s.orgId).eq("actionType", "CORRECT_EXPECTED_PAYMENT")).unique());
  if (!original) throw new Error("Missing payment correction audit");
  for (const filter of [{}, { actorId: s.owner.userId }, { actionType: "CORRECT_EXPECTED_PAYMENT" }, { fromDate: 1 }]) {
    const args = { orgId: s.orgId, ...filter };
    const sales = (await s.actors.sales.as.query(api.financialAudit.listAuditLog, args)).find(r => r._id === original._id);
    expect(sales?.before).toEqual({ expectedPaymentMethod: "CHEQUE", expectedPaymentDate: expectedDate });
    expect(sales?.after).toEqual({ expectedPaymentMethod: null, expectedPaymentDate: null });
    expect(JSON.stringify(sales)).not.toContain(String(chequeId));
    expect(JSON.stringify(sales)).not.toContain("private-correction");
    const finance = (await s.actors.finance.as.query(api.financialAudit.listAuditLog, args)).find(r => r._id === original._id);
    expect(finance?.before).toEqual({ chequeIds: [chequeId] });
    expect(finance?.description).toBe(original.description);
    expect(await s.actors.full.as.query(api.financialAudit.listAuditLog, args)).toContainEqual(original);
  }
}), 30_000);
