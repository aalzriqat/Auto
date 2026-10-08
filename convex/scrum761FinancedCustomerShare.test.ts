/**
 * SCRUM-761 pilot path, financed half: what happens to the customer's own share (down payment / first payment) of a
 * financed deal. CHARACTERIZATION tests of today's behaviour (convex-test, not production), not an endorsement.
 * G = 12,500 approved, H = 200 customer deposit, C = 1,375 dealership contribution (the SCRUM-435 worked example).
 */
import {
  C, G, H, finalizeAsOwner, newApplication, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S761F", vinPrefix: "VIN761F", actors: {},
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Debit-positive net per system account across every journal line in the org. */
async function glNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}

/** The sale's canonical invoice: original less ACTIVE allocations. */
async function invoiceOf(s: Seeded, saleId: Id<"sales">) {
  return await s.t.run(async (ctx) => {
    const sale = await ctx.db.get(saleId);
    const docId = sale?.canonicalReceivableDocumentId;
    const doc = docId ? await ctx.db.get(docId) : null;
    if (!doc) return null;
    const active = (await ctx.db.query("paymentAllocations").collect()).filter(
      (a) => a.receivableDocumentId === docId && a.status === "ACTIVE"
    );
    const paid = active.reduce((sum, a) => sum + a.amountMinor, 0);
    return { status: doc.status, original: doc.originalAmountMinor, paid, outstanding: doc.originalAmountMinor - paid };
  });
}

/** An APPROVED deal with the customer's deposit taken through the real `deposits.create`, ready to finalize. */
async function dealWithRealDeposit(s: Seeded) {
  const { quoteId, applicationId } = await newApplication(s);
  const { owner, approver, orgId } = s;
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
  });
  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await owner.as.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Matched." });
  const depositId = await owner.as.mutation(api.deposits.create, {
    method: "CASH", idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: H / 1000,
  });
  await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: H, dealerContributionMinor: C }));
  return { applicationId, quoteId, depositId };
}

async function saleOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const sales = await ctx.db.query("sales").collect();
    return sales.find((x) => x.applicationId === applicationId)?._id as Id<"sales"> | undefined;
  });
}

const stageState = async (s: Seeded, saleId: Id<"sales">, key: string) => {
  const deal = await s.owner.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
  return deal?.stages.find((st) => st.key === key)?.state;
};

const memo = async (s: Seeded, depositId: Id<"deposits">) =>
  s.t.run(async (ctx) => { const d = await ctx.db.get(depositId); return { status: d?.status, holdActive: d?.holdActive }; });

describe("SCRUM-761 financed deal: the customer's own share (deposit H = 200) through finalize and the finance company's transfer", () => {
  test("(a) a deposit taken BEFORE finalize is applied at finalize: the customer's invoice is zero, no customer receivable remains", async () => {
    const s = await seed("fina");
    const { applicationId, depositId } = await dealWithRealDeposit(s);
    expect(await glNet(s)).toMatchObject({ CASH_ON_HAND: H, CUSTOMER_DEPOSITS_LIABILITY: -H });

    await finalizeAsOwner(s, applicationId);
    const saleId = (await saleOf(s, applicationId))!;

    expect(await memo(s, depositId)).toEqual({ status: "APPLIED", holdActive: false });
    const gl = await glNet(s);
    expect(gl.CASH_ON_HAND).toBe(H);
    expect(gl.CUSTOMER_DEPOSITS_LIABILITY).toBe(0);
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(G);
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-(H + C));
    expect(gl.SALES_REVENUE).toBe(-G);
    expect(gl.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect(gl.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBeUndefined();
    expect(gl.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY).toBeUndefined();
    // The sale invoice was shrunk to nothing: the customer owes the dealership nothing after finalize.
    expect(await invoiceOf(s, saleId)).toMatchObject({ original: 0, outstanding: 0 });
  });

  test("(b) a payment AFTER finalize: naming the sale is refused; without the sale it is ACCEPTED and parked as an unapplied liability", async () => {
    const s = await seed("finb");
    const { applicationId } = await dealWithRealDeposit(s);
    await finalizeAsOwner(s, applicationId);
    const saleId = (await saleOf(s, applicationId))!;
    const before = await glNet(s);

    const refusal = await refusalMessageOf(
      s.owner.as.mutation(api.collections.recordPayment, {
        orgId: s.orgId, saleId, customerId: s.customerId, amount: 100, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal).toMatch(/cannot be recorded against a separate receivable/i);
    expect(await glNet(s)).toEqual(before);

    await s.owner.as.mutation(api.collections.recordPayment, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, amount: 100, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
    });
    const after = await glNet(s);
    expect(after.CASH_ON_HAND).toBe(H + 100_000);
    expect(after.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY).toBe(-100_000);
    expect(await invoiceOf(s, saleId)).toMatchObject({ original: 0, outstanding: 0 });
  });

  test("(c) the finance company's part settles: forward + confirmDisbursement clear both finance-company accounts; SETTLEMENT is not COMPLETE until the transfer is confirmed (SCRUM-803)", async () => {
    const s = await seed("finc");
    const { applicationId } = await dealWithRealDeposit(s);
    await finalizeAsOwner(s, applicationId);
    const saleId = (await saleOf(s, applicationId))!;
    // SETTLEMENT must NOT be COMPLETE before the finance company's transfer is confirmed.
    expect(await stageState(s, saleId, "SETTLEMENT")).not.toBe("COMPLETE");

    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(), expectedAmountMinor: H + C, idempotencyKey: crypto.randomUUID(),
    });
    await s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
    });

    const gl = await glNet(s);
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(0);
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(0);
    // The finance company's G in, less the H + C forwarded back to it.
    expect(gl.BANK_ACCOUNT).toBe(G - (H + C));
    expect(gl.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY).toBeUndefined();
    expect(await stageState(s, saleId, "SETTLEMENT")).toBe("COMPLETE");
  });

  test("SCRUM-803: a settled application for S2 cannot complete S1's settlement", async () => {
    const s = await seed("link");
    const { applicationId: firstApplicationId } = await dealWithRealDeposit(s);
    await finalizeAsOwner(s, firstApplicationId);
    const firstSaleId = (await saleOf(s, firstApplicationId))!;

    const secondVehicleId = await s.t.run(async (ctx) => {
      const vehicle = (await ctx.db.get(s.vehicleId))!;
      const { _id, _creationTime, ...vehicleFields } = vehicle;
      return await ctx.db.insert("vehicles", { ...vehicleFields, vin: "VIN761Flink2", status: "AVAILABLE" });
    });
    const secondDeal = { ...s, vehicleId: secondVehicleId };
    const { applicationId: secondApplicationId } = await dealWithRealDeposit(secondDeal);
    await finalizeAsOwner(secondDeal, secondApplicationId);
    const secondSaleId = (await saleOf(s, secondApplicationId))!;
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId: secondApplicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
      expectedAmountMinor: H + C, idempotencyKey: crypto.randomUUID(),
    });
    await s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId: secondApplicationId, disbursedAmountMinor: G,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await stageState(s, secondSaleId, "SETTLEMENT")).toBe("COMPLETE");
    expect(await stageState(s, firstSaleId, "SETTLEMENT")).not.toBe("COMPLETE");

    await s.t.run((ctx) => ctx.db.patch(firstSaleId, { applicationId: secondApplicationId }));
    expect(await stageState(s, firstSaleId, "SETTLEMENT")).not.toBe("COMPLETE");
  });

  test("SCRUM-803: dangling and foreign-org applications cannot complete a sale's settlement", async () => {
    const s = await seed("invalidlink");
    const { applicationId } = await dealWithRealDeposit(s);
    await finalizeAsOwner(s, applicationId);
    const saleId = (await saleOf(s, applicationId))!;
    await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
      expectedAmountMinor: H + C, idempotencyKey: crypto.randomUUID(),
    });
    await s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
    });
    expect(await stageState(s, saleId, "SETTLEMENT")).toBe("COMPLETE");

    const foreignApplicationId = await s.t.run(async (ctx) => {
      const application = (await ctx.db.get(applicationId))!;
      const foreignOrgId = await ctx.db.insert("organizations", { name: "Foreign org", createdAt: Date.now() });
      const { _id, _creationTime, ...applicationFields } = application;
      return await ctx.db.insert("financeApplications", { ...applicationFields, orgId: foreignOrgId });
    });
    await s.t.run((ctx) => ctx.db.delete(applicationId));
    expect(await stageState(s, saleId, "SETTLEMENT")).not.toBe("COMPLETE");

    await s.t.run((ctx) => ctx.db.patch(saleId, { applicationId: foreignApplicationId }));
    expect(await stageState(s, saleId, "SETTLEMENT")).not.toBe("COMPLETE");
  });

  test("(d) cancelling BEFORE finalize with a held deposit: the car is freed, the deposit stays HELD as a liability, and deposits.release REFUNDED clears it", async () => {
    const s = await seed("find");
    const { applicationId, depositId } = await dealWithRealDeposit(s);

    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "customer walked", idempotencyKey: crypto.randomUUID(),
    });

    expect(await memo(s, depositId)).toEqual({ status: "HELD", holdActive: false });
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status)).toBe("AVAILABLE");
    expect(await glNet(s)).toEqual({ CASH_ON_HAND: H, CUSTOMER_DEPOSITS_LIABILITY: -H });

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    expect(await memo(s, depositId)).toEqual({ status: "REFUNDED", holdActive: false });
    expect(await glNet(s)).toEqual({ CASH_ON_HAND: 0, CUSTOMER_DEPOSITS_LIABILITY: 0 });
  });
});
