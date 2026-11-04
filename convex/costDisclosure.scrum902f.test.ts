import { describe, expect, test, vi } from "vitest";
import { seedFinancedDealership, newApplication, refusalDataOf } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { economicsStamp } from "./utils/financingEconomics";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const BASE = ["view:finance", "manage:finance", "view:finance_applications", "approve:finance_application", "manage:supplier_settlement", "view:expenses"];
async function seed(tag: string) {
  return seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMISSIONS, label: "Synthetic cost disclosure", vinPrefix: "S902F", sourced: true,
    actors: { NoCost: BASE, Cost: [...BASE, "view:cost_price"], All: ALL_PERMISSIONS },
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function payable(s: Seed) {
  return s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", {
    orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
    amountDue: 9000, amountPaid: 100, currency: "JOD", status: "PARTIALLY_PAID",
    createdBy: s.owner.userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));
}

async function openingDraft(s: Seed, status: "POSTED" | "PENDING_APPROVAL") {
  const accounts = await s.owner.as.query(api.chartOfAccounts.list, { orgId: s.orgId });
  const inventory = accounts.find(a => a.systemKey === "VEHICLE_INVENTORY");
  if (!inventory) throw new Error("Missing fixture inventory account");
  return s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", {
    orgId: s.orgId, status, currency: "JOD", asOfDate: Date.now(), createdAt: Date.now(), createdBy: s.owner.userId,
    lines: [{ accountId: inventory._id, debitMinor: 9000000, creditMinor: 0 }],
    allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "stock", accountId: inventory._id, amountMinor: 9000000, vehicleId: s.vehicleId }],
  }));
}

describe("SCRUM-902 c24475 remaining cost disclosures", () => {
  test("F1 supplierConcessionBasis refuses finance without cost and preserves granted access", async () => {
    const s = await seed("basis");
    const { applicationId } = await newApplication(s);
    const args = { orgId: s.orgId, applicationId };
    for (const actor of [s.actors.Cost, s.actors.All, s.owner]) {
      expect(await actor.as.query(api.financingEconomics.supplierConcessionBasis, args))
        .toMatchObject({ eligible: true, entitlementMinor: 9000000 });
    }
    await expect(s.actors.NoCost.as.query(api.financingEconomics.supplierConcessionBasis, args))
      .rejects.toThrow(/view:cost_price/);
  });

  test("F1 resolveAppraisalGap cannot compare guessed entitlement without cost access", async () => {
    const s = await seed("oracle");
    const { applicationId } = await newApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: 12500000, source: "MANUAL_ENTRY", customerFirstPaymentMinor: 500000,
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: 11500000, basis: "MANUAL", notes: "Synthetic approval",
    });
    const app = await s.t.run(ctx => ctx.db.get(applicationId));
    if (!app) throw new Error("Missing fixture application");
    const args = {
      orgId: s.orgId, applicationId, economicsStamp: economicsStamp(app),
      customerGapShareMinor: 0, dealerGapShareMinor: 900000, supplierGapShareMinor: 100000,
      customerGapCashToDealerMinor: 0, customerGapInstallmentToDealerMinor: 0, customerGapToFinanceCompanyMinor: 0,
      observedSupplierEntitlementMinor: 9000000, observedSupplierName: "Amman Importer Co", observedSupplierId: s.supplierId,
    };
    const outcomes = [];
    for (const guess of [8999999, 9000000, 9000001]) {
      outcomes.push(await refusalDataOf(s.actors.NoCost.as.mutation(api.financingEconomics.resolveAppraisalGap, { ...args, observedSupplierEntitlementMinor: guess })));
    }
    expect(outcomes).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ code: "FORBIDDEN", message: expect.stringContaining("view:cost_price") })));
    expect(await s.actors.Cost.as.mutation(api.financingEconomics.resolveAppraisalGap, args)).toBe(applicationId);
  });

  test("F2 postedOpeningAllocationReadback withholds per-car opening amounts", async () => {
    const s = await seed("posted");
    await openingDraft(s, "POSTED");
    expect((await s.actors.Cost.as.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId }))?.rows[0])
      .toMatchObject({ amountMinor: 9000000, partyId: s.vehicleId });
    expect(await s.actors.NoCost.as.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId })).toBeNull();
  });

  test("F2 pending drafts withhold raw allocations, enriched allocations and balancing cost lines", async () => {
    const s = await seed("draft");
    await openingDraft(s, "PENDING_APPROVAL");
    const granted = await s.actors.Cost.as.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId });
    expect(granted[0]?.allocations?.[0]).toMatchObject({ amountMinor: 9000000, vehicleId: s.vehicleId });
    expect(granted[0]?.allocationDetails?.[0]).toMatchObject({ amountMinor: 9000000 });
    expect(await s.actors.NoCost.as.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId })).toEqual([]);
  });

  test("F3 listPending gates cost payloads in every status branch", async () => {
    for (const status of [undefined, "PENDING", "POSTED", "FAILED"] as const) {
      const s = await seed(`outbox${status}`);
      await s.t.run(ctx => ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "POST", status: status ?? "PENDING", idempotencyKey: "synthetic", accountingDate: Date.now(),
        actorId: s.owner.userId, attempts: 0, createdAt: Date.now(), sourceType: "sales", sourceId: "synthetic",
        payload: { vehicleId: s.vehicleId, cogsMinor: 9000000 },
      }));
      expect((await s.actors.Cost.as.query(api.accountingOutbox.listPending, { orgId: s.orgId, status }))[0]?.payload)
        .toEqual({ vehicleId: s.vehicleId, cogsMinor: 9000000 });
      await expect(s.actors.NoCost.as.query(api.accountingOutbox.listPending, { orgId: s.orgId, status })).rejects.toThrow(/view:cost_price/);
    }
  });

  test("F4 partial payment refusal has no cost amount or due field without grant", async () => {
    const s = await seed("refusal");
    const payableId = await payable(s);
    const args = { orgId: s.orgId, payableId, amount: 9001, paymentMethod: "CASH" as const, idempotencyKey: "overpayment" };
    await expect(s.actors.Cost.as.mutation(api.sourcingPayables.recordPartialPayment, args))
      .rejects.toMatchObject({ data: { due: 9000, projected: 9101 } });
    await expect(s.actors.NoCost.as.mutation(api.sourcingPayables.recordPartialPayment, args))
      .rejects.toHaveProperty("data", { code: "SUPPLIER_PAYMENT_REFUSED", message: "This supplier payment cannot be recorded. Check the payment details and try again." });
    expect((await s.t.run(ctx => ctx.db.get(payableId)))?.amountPaid).toBe(100);
  });

  test("F4 partial payment success and replay redact accumulated paid and entitlement balance", async () => {
    const s = await seed("paid");
    const payableId = await payable(s);
    const args = { orgId: s.orgId, payableId, amount: 50, paymentMethod: "CASH" as const, idempotencyKey: "payment" };
    expect(await s.actors.Cost.as.mutation(api.sourcingPayables.recordPartialPayment, args))
      .toEqual({ amountPaid: 150, remainingAmount: 8850 });
    await revokeCost(s, s.actors.Cost.userId);
    expect(await s.actors.Cost.as.mutation(api.sourcingPayables.recordPartialPayment, args)).toEqual({});
    expect((await s.t.run(ctx => ctx.db.get(payableId)))?.amountPaid).toBe(150);
    expect(await s.actors.NoCost.as.mutation(api.sourcingPayables.recordPartialPayment, { ...args, idempotencyKey: "second" })).toEqual({});
    expect((await s.t.run(ctx => ctx.db.get(payableId)))?.amountPaid).toBe(200);
  });

  test("F5 unfiltered expenses exclude vehicle cost rows including tax and capitalization operands", async () => {
    const s = await seed("expense");
    await s.t.run(async ctx => {
      await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic capitalized cost", amount: 116,
        taxAmount: 16, date: Date.now(), category: "REPAIR", accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 100 });
      await ctx.db.insert("expenses", { orgId: s.orgId, title: "Office", amount: 20, date: Date.now(), category: "OFFICE" });
    });
    const args = { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } };
    const granted = await s.actors.Cost.as.query(api.expenses.list, args);
    expect(granted.page.find(row => row.vehicleId === s.vehicleId)).toMatchObject({ amount: 116, taxAmount: 16, capitalizedAmount: 100 });
    const restricted = await s.actors.NoCost.as.query(api.expenses.list, args);
    expect(restricted.page).toHaveLength(1);
    expect(restricted.page[0]).toMatchObject({ title: "Office", amount: 20 });
    expect(JSON.stringify(restricted)).not.toContain(s.vehicleId);
    expect(restricted.isDone).toBe(true);
  });

  test("sweep markPaid cannot compare a guessed settlement balance without cost access", async () => {
    const s = await seed("markoracle");
    const payableId = await payable(s);
    const args = { orgId: s.orgId, payableId, paymentMethod: "CASH" as const, idempotencyKey: "mark" };
    for (const guess of [8899999, 8900000]) {
      await expect(s.actors.NoCost.as.mutation(api.sourcingPayables.markPaid, { ...args, expectedSettlementAmountMinor: guess }))
        .rejects.toThrow(/view:cost_price/);
    }
    await s.actors.Cost.as.mutation(api.sourcingPayables.markPaid, { ...args, expectedSettlementAmountMinor: 8900000 });
    expect((await s.t.run(ctx => ctx.db.get(payableId)))?.amountPaid).toBe(9000);
  });

  test("sweep supplier receipt refusal and replay do not disclose the margin claim", async () => {
    const s = await seed("claim");
    const saleId = await s.t.run(ctx => ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.owner.userId,
      salePrice: 12500, saleDate: Date.now(), status: "COMPLETED",
    }));
    const receivableId = await s.t.run(ctx => ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
      amountDue: 3500, currency: "JOD", status: "OPEN", createdBy: s.owner.userId, createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const args = { orgId: s.orgId, receivableId, amount: 3501, receiptMethod: "CASH" as const, idempotencyKey: "claim-over" };
    expect((await refusalDataOf(s.actors.Cost.as.mutation(api.supplierReceivables.recordReceipt, args)))?.message).toContain("3500 owed");
    expect(await refusalDataOf(s.actors.NoCost.as.mutation(api.supplierReceivables.recordReceipt, args)))
      .toEqual({ code: "SUPPLIER_RECEIPT_REFUSED", message: "This supplier receipt cannot be recorded. Check the receipt details and try again." });
    const payment = { ...args, amount: 100, idempotencyKey: "claim-payment" };
    expect(await s.actors.Cost.as.mutation(api.supplierReceivables.recordReceipt, payment))
      .toEqual({ amountReceived: 100, remainingAmount: 3400, status: "PARTIALLY_PAID" });
    await revokeCost(s, s.actors.Cost.userId);
    expect(await s.actors.Cost.as.mutation(api.supplierReceivables.recordReceipt, payment)).toEqual({ status: "PARTIALLY_PAID" });
    expect(await s.actors.NoCost.as.mutation(api.supplierReceivables.recordReceipt, { ...payment, idempotencyKey: "claim-second" }))
      .toEqual({ status: "PARTIALLY_PAID" });
    expect((await s.t.run(ctx => ctx.db.get(receivableId)))?.amountReceived).toBe(200);
  });

  test("sweep cost recovery receipt and replay withhold remaining vehicle cost", async () => {
    const s = await seed("recovery");
    const expenseId = await s.owner.as.mutation(api.expenses.create, {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic supplier cost", amount: 200, date: Date.now() - 60000,
      category: "TRANSPORT", status: "PAID", paymentMethod: "CASH", costBearer: "SUPPLIER", idempotencyKey: "expense",
    });
    const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").withIndex("by_org_expense", q => q.eq("orgId", s.orgId).eq("expenseId", expenseId)).unique());
    if (!recovery) throw new Error("Missing fixture recovery");
    const args = { orgId: s.orgId, recoveryId: recovery._id, amountMinor: 50000, method: "CASH" as const, receivedDate: Date.now(), idempotencyKey: "recovery" };
    const granted = await s.actors.Cost.as.mutation(api.supplierCostRecoveries.recordReceipt, args);
    expect(granted).toMatchObject({ amountRecoveredMinor: 50000, remainingMinor: 150000 });
    await revokeCost(s, s.actors.Cost.userId);
    expect(await s.actors.Cost.as.mutation(api.supplierCostRecoveries.recordReceipt, args))
      .toEqual({ receiptId: granted.receiptId, status: "PARTIALLY_RECOVERED" });
    const restricted = await s.actors.NoCost.as.mutation(api.supplierCostRecoveries.recordReceipt, { ...args, idempotencyKey: "recovery-second" });
    expect(Object.keys(restricted).sort()).toEqual(["receiptId", "status"]);
    expect((await s.t.run(ctx => ctx.db.get(recovery._id)))?.amountRecoveredMinor).toBe(100000);
  });

  test("sweep direct supplier route and approval refusals contain no entitlement", async () => {
    for (const door of ["route", "approval"] as const) {
      const s = await seed(`direct${door}`);
      const { applicationId } = await newApplication(s);
      await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
      await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
      await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: s.orgId, applicationId, submittedQuotationMinor: 12500000, source: "MANUAL_ENTRY", customerFirstPaymentMinor: 500000,
      });
      const route = { orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER" as const };
      const approval = { orgId: s.orgId, applicationId, approvedAmountMinor: 8000000, basis: "MANUAL" as const, notes: "Synthetic approval" };
      if (door === "route") await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, approval);
      else await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, route);
      const call = (actor: Seed["actors"]["Cost"]) => door === "route"
        ? actor.as.mutation(api.applications.setSupplierSettlementRoute, route)
        : actor.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, approval);
      expect(await refusalDataOf(call(s.actors.NoCost))).toEqual({ code: "SUPPLIER_DIRECT_SETTLEMENT_REFUSED",
        message: "The supplier cannot receive less than he is owed. Review the agreement or settle through the dealership." });
      expect((await refusalDataOf(call(s.actors.Cost)))?.code).toBe("SUPPLIER_DIRECT_SETTLEMENT_REFUSED");
    }
  });

  test("sweep inventory backfill response withholds vehicle cost but keeps migration results", async () => {
    const s = await seed("migration");
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK", purchasePrice: 9000 }));
    const args = { orgId: s.orgId, dryRun: true };
    expect((await s.actors.Cost.as.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, args)).results)
      .toContainEqual(expect.objectContaining({ vehicleId: s.vehicleId, amountMinor: 9000000, action: "WOULD_POST" }));
    const restricted = await s.actors.NoCost.as.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, args);
    expect(restricted.results).toContainEqual(expect.objectContaining({ vehicleId: s.vehicleId, action: "WOULD_POST" }));
    expect(restricted.results.every(row => !("amountMinor" in row))).toBe(true);
  });
});

async function revokeCost(s: Seed, userId: Seed["actors"]["Cost"]["userId"]) {
  await s.t.run(async ctx => {
    const membership = await ctx.db.query("memberships").withIndex("by_org_user", q => q.eq("orgId", s.orgId).eq("userId", userId)).unique();
    if (!membership) throw new Error("Missing fixture membership");
    await ctx.db.patch(membership.roleId, { permissions: BASE });
  });
}
