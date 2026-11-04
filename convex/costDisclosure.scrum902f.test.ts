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
const BASE = ["view:finance", "manage:finance", "view:finance_applications", "approve:finance_application", "view:expenses"];
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

  test.each([undefined, "PENDING", "POSTED", "FAILED"] as const)("F3 listPending gates cost payloads with status %s", async status => {
    const s = await seed(`outbox${status}`);
    await s.t.run(ctx => ctx.db.insert("pendingAccountingEvents", {
      orgId: s.orgId, kind: "POST", status: status ?? "PENDING", idempotencyKey: "synthetic", accountingDate: Date.now(),
      actorId: s.owner.userId, attempts: 0, createdAt: Date.now(), sourceType: "sales", sourceId: "synthetic",
      payload: { vehicleId: s.vehicleId, cogsMinor: 9000000 },
    }));
    expect((await s.actors.Cost.as.query(api.accountingOutbox.listPending, { orgId: s.orgId, status }))[0]?.payload)
      .toEqual({ vehicleId: s.vehicleId, cogsMinor: 9000000 });
    await expect(s.actors.NoCost.as.query(api.accountingOutbox.listPending, { orgId: s.orgId, status })).rejects.toThrow(/view:cost_price/);
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
    await s.t.run(async ctx => {
      const membership = await ctx.db.query("memberships").withIndex("by_org_user", q => q.eq("orgId", s.orgId).eq("userId", s.actors.Cost.userId)).unique();
      if (!membership) throw new Error("Missing fixture membership");
      await ctx.db.patch(membership.roleId, { permissions: BASE });
    });
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
});
