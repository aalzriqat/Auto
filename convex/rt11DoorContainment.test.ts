import { afterEach, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { commonEn, commonAr } from "../lib/i18n/domains/common";

// RT11-DOORS / SCRUM-760#c23862. No containment mocks: these exercise the shipped doors.
async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "RT11 dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "rt11_operator", email: "operator@example.com" });
    const employeeId = await ctx.db.insert("users", { clerkId: "rt11_employee", email: "employee@example.com" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "RT11VIN", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 10500,
      status: "AVAILABLE", sourceType: "STOCK",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10500, downPayment: 0, termMonths: 48,
      status: "ACCEPTED", createdBy: employeeId, createdAt: Date.now(),
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: employeeId, status: "APPROVED",
      expectedPaymentMethod: "BANK_TRANSFER", economicsCurrency: "JOD", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: employeeId, salePrice: 10500,
      saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
    });
    return { orgId, userId, employeeId, vehicleId, applicationId, saleId, quoteId };
  });
  const as = t.withIdentity({ subject: "rt11_operator" });
  await as.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId: ids.orgId, fiscalYear: year, periodNumber: 1, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true,
  });
  return { t, as, ...ids };
}
type Seed = Awaited<ReturnType<typeof seed>>;
afterEach(() => vi.useRealTimers());

async function snapshot(s: Seed) {
  return {
    tables: await dbSnapshot(s.t, Object.keys(schema.tables)),
    scheduled: await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  };
}
async function refused(s: Seed, code: string, call: () => Promise<unknown>) {
  const before = await snapshot(s);
  const result = await refusalDataOf(call());
  expect(result?.code, result?.message ?? "Mutation succeeded instead of refusing").toBe(code);
  expect(result?.message).toMatch(/pilot/i);
  expect(result?.message).toContain("Nothing has been changed.");
  const english: Record<string, string> = commonEn;
  const arabic: Record<string, string> = commonAr;
  expect(english[`ServerError_${code}`]).toBe(result?.message);
  expect(arabic[`ServerError_${code}`]).toMatch(/[\u0600-\u06ff]/);
  expect(await snapshot(s)).toEqual(before);
}
async function custody(s: Seed) {
  return s.as.mutation(api.financeDealCosts.openDealCustody, {
    orgId: s.orgId, applicationId: s.applicationId, userId: s.employeeId,
    issuedMinor: 100000, method: "CASH", idempotencyKey: crypto.randomUUID(),
  });
}
async function reimbursement(s: Seed) {
  const custodyId = await custody(s);
  await s.as.mutation(api.financeDealCosts.recordDealFee, {
    orgId: s.orgId, applicationId: s.applicationId, custodyId, expectedCurrency: "JOD",
    feeType: "LICENSING", paidBy: "EMPLOYEE", paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: 150000,
    idempotencyKey: crypto.randomUUID(),
  });
  return { orgId: s.orgId, custodyId, kind: "REIMBURSED" as const, amountMinor: 50000, method: "CASH" as const, idempotencyKey: crypto.randomUUID() };
}

test("RT11 finalized custody reversal refuses without writes", async () => {
  const s = await seed();
  const custodyId = await custody(s);
  const entry = await s.t.run((ctx) => ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", q => q.eq("custodyId", custodyId)).unique());
  expect(entry).not.toBeNull();
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { status: "CLOSED", finalizedSaleId: s.saleId }));
  await refused(s, "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED", () => s.as.mutation(api.financeDealCosts.recordCustodyMovement, {
    orgId: s.orgId, custodyId, kind: "REVERSAL", reversesEntryId: entry!._id, amountMinor: 100000, idempotencyKey: crypto.randomUUID(),
  }));
});
test("RT11 finalized custody reimbursement refuses without writes", async () => {
  const s = await seed();
  const args = await reimbursement(s);
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { status: "CLOSED", finalizedSaleId: s.saleId }));
  await refused(s, "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED", () => s.as.mutation(api.financeDealCosts.recordCustodyMovement, args));
});
test("RT11 pre-final reimbursement still pays the employee", async () => {
  const s = await seed();
  const args = await reimbursement(s);
  await s.as.mutation(api.financeDealCosts.recordCustodyMovement, args);
  expect((await s.t.run(ctx => ctx.db.get(args.custodyId)))?.reimbursedMinor).toBe(50000);
});
test("RT11 custody shortage write-off refuses without writes", async () => {
  const s = await seed();
  const custodyId = await custody(s);
  await refused(s, "CUSTODY_WRITEOFF_PILOT_DISABLED", () => s.as.mutation(api.financeDealCosts.reconcileDealCustody, {
    orgId: s.orgId, custodyId, notes: "Checked receipts", writeOffReason: "Unaccounted cash", idempotencyKey: crypto.randomUUID(),
  }));
});
test("RT11 balanced custody closure remains allowed", async () => {
  const s = await seed();
  const custodyId = await custody(s);
  await s.as.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: s.orgId, custodyId, kind: "RETURNED", amountMinor: 100000, method: "CASH", idempotencyKey: crypto.randomUUID() });
  await s.as.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: s.orgId, custodyId, notes: "All cash returned", writeOffReason: "No shortage", idempotencyKey: crypto.randomUUID() });
  expect((await s.t.run(ctx => ctx.db.get(custodyId)))?.status).toBe("RECONCILED");
});
test("RT11 legacy custody migration refuses without writes", async () => {
  const s = await seed();
  const custodyId = await s.t.run(ctx => ctx.db.insert("financeDealCustody", {
    orgId: s.orgId, applicationId: s.applicationId, userId: s.employeeId, currency: "JOD",
    issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));
  await refused(s, "CUSTODY_MIGRATION_PILOT_DISABLED", () => s.as.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: s.orgId, custodyId, idempotencyKey: crypto.randomUUID() }));
});
test("RT11 custody reopen refuses without writes", async () => {
  const s = await seed();
  const custodyId = await custody(s);
  await s.as.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: s.orgId, custodyId, kind: "RETURNED", amountMinor: 100000, method: "CASH", idempotencyKey: crypto.randomUUID() });
  await s.as.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: s.orgId, custodyId, notes: "All cash returned", idempotencyKey: crypto.randomUUID() });
  await refused(s, "CUSTODY_REOPEN_PILOT_DISABLED", () => s.as.mutation(api.financeDealCosts.reopenDealCustody, { orgId: s.orgId, custodyId, reason: "Late receipt" }));
});
test("RT11 manual finance approval refuses without writes", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { quoteModeAtSubmission: "MANUAL_FINANCE_COMPANY", targetSellingAmountMinor: 10500000 }));
  await refused(s, "MANUAL_FINANCE_APPROVAL_PILOT_DISABLED", () => s.as.mutation(api.financingEconomics.recordManualFinanceApproval, { orgId: s.orgId, applicationId: s.applicationId, approvedAmountMinor: 10000000, financierName: "Test financier", dealerSendsMinor: 0 }));
});
test("RT11 expected payment after dealer payout refuses without writes", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { disbursedAt: Date.now() }));
  await refused(s, "EXPECTED_PAYMENT_PAID_PILOT_DISABLED", () => s.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId: s.applicationId, reason: "Payment correction" }));
});
test("RT11 expected payment after supplier payout refuses without writes", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", supplierDisbursementConfirmedAt: Date.now(), supplierDisbursementStatus: "REQUIRES_RECONCILIATION" }));
  await refused(s, "EXPECTED_PAYMENT_PAID_PILOT_DISABLED", () => s.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId: s.applicationId, reason: "Payment correction" }));
});
test("RT11 expected payment before payout remains correctable", async () => {
  const s = await seed();
  await s.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId: s.applicationId, reason: "Wrong expected method" });
  expect((await s.t.run(ctx => ctx.db.get(s.applicationId)))?.expectedPaymentMethod).toBeUndefined();
});
test("RT11 supplier advice amendment refuses without writes", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.applicationId, { supplierDisbursementConfirmedAt: Date.now(), supplierDisbursedAmountMinor: 9900000, approvedDealerPurchaseAmountMinor: 10000000 }));
  await refused(s, "SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED", () => s.as.mutation(api.applications.amendSupplierDisbursementAdvice, { orgId: s.orgId, applicationId: s.applicationId, disbursedAmountMinor: 10000000, reason: "Re-read original advice", idempotencyKey: crypto.randomUUID() }));
});
test("RT11 direct commission payout refuses without writes", async () => {
  const s = await seed();
  await refused(s, "DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED", () => s.as.mutation(api.sales.markCommissionPaid, { orgId: s.orgId, saleId: s.saleId, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID() }));
});
test("RT11 sourced vehicle buyout refuses without writes", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedFromName: "Test supplier", sourceCost: 9000 }));
  await refused(s, "VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: s.vehicleId, sourceType: "STOCK", purchasePrice: 9000, purchasePaymentMethod: "CASH" }));
});
test("RT11 stock vehicle conversion refuses without writes", async () => {
  const s = await seed();
  await refused(s, "VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: s.vehicleId, sourceType: "SOURCED", sourceCost: 9000, sourcedFromName: "Test supplier" }));
});
test("RT11 ordinary vehicle edit remains allowed", async () => {
  const s = await seed();
  await s.as.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: s.vehicleId, color: "Blue" });
  expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.color).toBe("Blue");
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
});
const paidCost = { label: "Transport", amount: 100, paymentMethod: "CASH" as const };
async function cost(s: Seed) {
  await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [paidCost] });
}
test("RT11 editing paid landed cost refuses without writes", async () => {
  const s = await seed(); await cost(s);
  await refused(s, "PAID_LANDED_COST_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [{ ...paidCost, amount: 120 }] }));
});
test("RT11 removing paid landed cost refuses without writes", async () => {
  const s = await seed(); await cost(s);
  await refused(s, "PAID_LANDED_COST_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [] }));
});
test("RT11 moving paid landed cost refuses without writes", async () => {
  const s = await seed(); await cost(s);
  const bankAccountId = await s.t.run(ctx => ctx.db.insert("bankAccounts", { orgId: s.orgId, name: "Test bank", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: false, createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now() }));
  await refused(s, "PAID_LANDED_COST_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [{ ...paidCost, paymentMethod: "BANK_TRANSFER", bankAccountId }] }));
});
test("RT11 adding new landed cost preserves the paid item", async () => {
  const s = await seed(); await cost(s);
  const result = await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [paidCost, { label: "Inspection", amount: 20, paymentMethod: "CASH" }] });
  expect(result.total).toBe(120);
  expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.landedCostTotal).toBe(120);
});

test("RT11 duplicate paid landed costs cannot be collapsed", async () => {
  const s = await seed();
  await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [paidCost, paidCost] });
  await refused(s, "PAID_LANDED_COST_CHANGE_PILOT_DISABLED", () => s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [paidCost] }));
});
test("RT11 reordering paid landed costs remains allowed", async () => {
  const s = await seed();
  const inspection = { label: "Inspection", amount: 20, paymentMethod: "CASH" as const };
  await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [paidCost, inspection] });
  const before = await s.t.run(ctx => ctx.db.query("journalEntries").collect());
  await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [inspection, paidCost] });
  expect(await s.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual(before);
});
test("RT11 informational sourced landed costs remain editable", async () => {
  const s = await seed();
  await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedFromName: "Test supplier", sourceCost: 9000 }));
  await cost(s);
  const before = await s.t.run(ctx => ctx.db.query("journalEntries").collect());
  const result = await s.as.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId, items: [{ ...paidCost, amount: 120 }] });
  expect(result.total).toBe(120);
  expect(await s.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual(before);
});
