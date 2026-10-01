/**
 * SCRUM-258 / SCRUM-504 - `sales.getBillOfSaleEconomics`, the ONLY source of the totals printed on a
 * Bill of Sale, and the refusal that a financed sale exists only through the Deal.
 *
 * Invariant under test: every printed figure is server-authoritative (CASH: the ledger receivable
 * and its ledger-backed credits; FINANCED: the customer's server-priced quote snapshot), never a
 * caller-supplied sale field and never a finance-approval-tier amount. With no authoritative source
 * the answer is UNAVAILABLE, never a number and never 0.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime.
 */
import { convexTestWithComponents, registerHandover, recordReconciledZeroCost } from "../test-utils/convexTest";
import { expectFinancedSaleRequiresDeal } from "../test-utils/financedSaleRequiresDeal";
import { expectQuoteEconomicsDrifted } from "../test-utils/quoteEconomicsDrifted";
import { expectAppError } from "../test-utils/expectAppError";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

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
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const SCALE = 1_000; // JOD, 3 decimals

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S258 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}.o@example.com`, name: "owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const as = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  const approverId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.a@example.com`, name: "appr" }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const approver = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });
  // A member who may do everything EXCEPT view sales.
  const blindRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "BLIND", permissions: ["view:vehicles"] })
  );
  const blindId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_blind`, email: `${tag}.b@example.com`, name: "blind" }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: blindId, roleId: blindRoleId }));
  const blind = t.withIdentity({ subject: `${tag}_blind`, clerkId: `${tag}_blind` });
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const mkVehicle = (vin: string) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN258${tag}${vin}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
        color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: 13_000, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 10_000,
      })
    );
  const vehicleId = await mkVehicle("A");
  return { t, orgId, userId, as, approver, blind, customerId, vehicleId, mkVehicle };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;

const query = (s: Seeded, saleId: Id<"sales">) =>
  s.as.query(api.sales.getBillOfSaleEconomics, { orgId: s.orgId, saleId });

async function cashSale(s: Seeded, price = 13_000) {
  return await s.as.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
    salespersonId: s.userId, salePrice: price, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
}

/** A finalize-ready manual finance deal: quote -> application -> approval -> handover -> invoice -> costs. NOT finalized. */
async function readyFinancedDeal(s: Seeded, quoteExtra: Record<string, unknown> = {}) {
  const quoteId = await s.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: 12_000, downPayment: 0, termMonths: 48,
    mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option",
    manualAdminFees: 0, manualProfitRate: 5, ...quoteExtra,
  } as never);
  const applicationId = await s.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  // The finance approval tier: amounts here must NEVER reach the Bill of Sale.
  await s.approver.mutation(api.financingEconomics.recordManualFinanceApproval, {
    orgId: s.orgId, applicationId, approvedAmountMinor: 12_000_000, financierName: "Al-Ameen Islamic Finance",
    dealerSendsMinor: 1_650_000,
  });
  await registerHandover(s.as, api, s.orgId, applicationId);
  await s.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: 12_000 * SCALE, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  await recordReconciledZeroCost(s.as, api, s.orgId, applicationId);
  return { applicationId, quoteId };
}

const finalize = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.as.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId });

/** A real Deal: manual finance company quote -> application -> approval -> finalizeDeal. */
async function financedSaleThroughDeal(s: Seeded, quoteExtra: Record<string, unknown> = {}) {
  const { applicationId, quoteId } = await readyFinancedDeal(s, quoteExtra);
  const saleId = await finalize(s, applicationId);
  return { saleId: saleId as Id<"sales">, applicationId, quoteId };
}

/** A trade-in car: no purchase price (it is taken in, not bought). */
const mkTradeIn = (s: Seeded, vin: string) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN258TI${vin}`, make: "Toyota", model: "Yaris", year: 2018, mileage: 90_000,
      color: "White", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 2_000, status: "AVAILABLE", sourceType: "STOCK" as const,
    })
  );

/** A sale taking a real trade-in through the normal door (the ledger trade-in payment is posted at completion). */
async function cashSaleWithTradeIn(s: Seeded, tradeInValue: number) {
  const tradeInVehicleId = await mkTradeIn(s, "A");
  return await s.as.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
    salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
    tradeInVehicleId, tradeInValue,
  });
}

/** A sale that consumes a real reservation deposit: quote -> deposits.create -> sales.create(quoteId). */
async function cashSaleWithDeposit(s: Seeded, depositAmount: number) {
  const quoteId = await s.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 13_000, downPayment: 0, termMonths: 0,
  });
  await s.as.mutation(api.deposits.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, amount: depositAmount, method: "CASH",
  });
  return await s.as.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
    salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH", quoteId,
  });
}

/** The live ledger allocations of a sale's receivable, with the idempotency key of each payment. */
async function allocationsOf(s: Seeded, saleId: Id<"sales">) {
  return await s.t.run(async (ctx) => {
    const sale = await ctx.db.get(saleId);
    const rows = await ctx.db
      .query("paymentAllocations")
      .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", sale!.canonicalReceivableDocumentId!))
      .collect();
    return await Promise.all(
      rows.map(async (a) => ({ ...a, key: (await ctx.db.get(a.paymentId))!.idempotencyKey }))
    );
  });
}

describe("getBillOfSaleEconomics - CASH", () => {
  test("a plain cash sale states the ledger receivable, itemised, with the exact CASH keys", async () => {
    const s = await seedDealership("cash");
    const saleId = await cashSale(s);
    expect(await query(s, saleId)).toEqual({
      kind: "CASH", currency: "JOD", vehicle: 13_000, taxes: 0, dealerFees: 0, warranty: 0, gap: 0,
      vehicleSettledWithSupplier: false, totalBilled: 13_000, tradeInCredit: 0, depositsApplied: 0, balanceDue: 13_000,
    });
  });

  test("tax, fees, warranty and GAP are itemised and foot to the receivable", async () => {
    const s = await seedDealership("cashlines");
    const saleId = await s.as.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
      salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
      taxAmount: 50, dealerFees: 100, warrantySold: 400, warrantyTermMonths: 24, gapSold: 200, gapTermMonths: 12,
    });
    expect(await query(s, saleId)).toEqual({
      kind: "CASH", currency: "JOD", vehicle: 13_000, taxes: 50, dealerFees: 100, warranty: 400, gap: 200,
      vehicleSettledWithSupplier: false, totalBilled: 13_750, tradeInCredit: 0, depositsApplied: 0, balanceDue: 13_750,
    });
  });

  test("a consigned DIRECT_TO_SUPPLIER cash sale bills 0 for the car, itemises the fees and says it was paid to the supplier", async () => {
    const s = await seedDealership("cashdirect");
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VIN258DIRECT", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
        color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 13_000,
        status: "AVAILABLE", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", sourceCost: 11_000,
      })
    );
    const saleId = await s.as.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
      salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER", dealerFees: 150,
    });
    expect(await query(s, saleId)).toEqual({
      kind: "CASH", currency: "JOD", vehicle: 0, taxes: 0, dealerFees: 150, warranty: 0, gap: 0,
      vehicleSettledWithSupplier: true, totalBilled: 150, tradeInCredit: 0, depositsApplied: 0, balanceDue: 150,
    });
  });

  test("S1: an itemisation that does not foot to the receivable is UNAVAILABLE DOES_NOT_FOOT, never a printed total", async () => {
    const s = await seedDealership("cashfoot");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const receivable = await ctx.db.get(sale!.canonicalReceivableDocumentId!);
      await ctx.db.patch(receivable!._id, { originalAmountMinor: receivable!.originalAmountMinor + 1 });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "DOES_NOT_FOOT" });
  });

  test("S1: a sale row edited after completion (price no longer matches the receivable) is DOES_NOT_FOOT", async () => {
    const s = await seedDealership("cashedit");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { salePrice: 12_000 }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "DOES_NOT_FOOT" });
  });

  test("a caller-supplied downPayment and loanAmount never move a CASH figure", async () => {
    const s = await seedDealership("cashdp");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { downPayment: 4_000, loanAmount: 9_000 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", totalBilled: 13_000, balanceDue: 13_000 });
  });

  test("a trade-in value with no trade-in vehicle is not a credit", async () => {
    const s = await seedDealership("cashtv");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInValue: 2_000 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", tradeInCredit: 0, balanceDue: 13_000 });
  });

  test("S1b: a real trade-in is credited from its ledger allocation, equal to the trade-in payment", async () => {
    const s = await seedDealership("cashti");
    const saleId = await cashSaleWithTradeIn(s, 2_000);
    const allocations = await allocationsOf(s, saleId);
    const tradeIn = allocations.filter((a) => a.key === `trade_in_payment_${saleId}`);
    expect(tradeIn).toHaveLength(1);
    expect(tradeIn[0].amountMinor).toBe(2_000 * SCALE);
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", tradeInCredit: 2_000, depositsApplied: 0, balanceDue: 11_000 });
  });

  test("S1b: the credit is the ledger's figure, not the sale row's (a later edit of tradeInValue moves nothing)", async () => {
    const s = await seedDealership("cashtiedit");
    const saleId = await cashSaleWithTradeIn(s, 2_000);
    await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInValue: 9_999 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", tradeInCredit: 2_000, balanceDue: 11_000 });
  });

  test("S1b: a reversed trade-in allocation leaves a trade-in with no ledger credit - DOES_NOT_FOOT", async () => {
    const s = await seedDealership("cashtirev");
    const saleId = await cashSaleWithTradeIn(s, 2_000);
    const [allocation] = (await allocationsOf(s, saleId)).filter((a) => a.key === `trade_in_payment_${saleId}`);
    await s.t.run((ctx) => ctx.db.patch(allocation._id, { status: "REVERSED" }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "DOES_NOT_FOOT" });
  });

  test("S1b: a real reservation deposit is credited from its ledger allocation", async () => {
    const s = await seedDealership("cashdep");
    const saleId = await cashSaleWithDeposit(s, 1_500);
    const deposits = (await allocationsOf(s, saleId)).filter((a) => a.key.startsWith("deposit_received_"));
    expect(deposits).toHaveLength(1);
    expect(deposits[0].amountMinor).toBe(1_500 * SCALE);
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", depositsApplied: 1_500, tradeInCredit: 0, balanceDue: 11_500 });
  });

  test("S1b: a reversed deposit allocation is not a credit", async () => {
    const s = await seedDealership("cashdeprev");
    const saleId = await cashSaleWithDeposit(s, 1_500);
    const [allocation] = (await allocationsOf(s, saleId)).filter((a) => a.key.startsWith("deposit_received_"));
    await s.t.run((ctx) => ctx.db.patch(allocation._id, { status: "REVERSED" }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", depositsApplied: 0, balanceDue: 13_000 });
  });

  test("S1b: a customer collection allocated after completion is neither a trade-in nor a deposit and changes no figure", async () => {
    const s = await seedDealership("cashlater");
    const saleId = await cashSale(s);
    const before = await query(s, saleId);
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId: s.orgId, direction: "IN", payerType: "CUSTOMER", customerId: s.customerId, method: "CASH",
        amountMinor: 3_000 * SCALE, currency: "JOD", scale: 3, status: "SETTLED",
        idempotencyKey: "collection-after-completion", createdBy: s.userId, createdAt: Date.now(),
      });
      await ctx.db.insert("paymentAllocations", {
        orgId: s.orgId, paymentId, receivableDocumentId: sale!.canonicalReceivableDocumentId!,
        amountMinor: 3_000 * SCALE, currency: "JOD", scale: 3, allocationDate: Date.now(), status: "ACTIVE",
        createdBy: s.userId, createdAt: Date.now(),
      });
    });
    expect(await query(s, saleId)).toEqual(before);
  });

  test("a credit allocated in another currency than the receivable fails closed", async () => {
    const s = await seedDealership("cashcur");
    const saleId = await cashSaleWithDeposit(s, 1_500);
    const [allocation] = (await allocationsOf(s, saleId)).filter((a) => a.key.startsWith("deposit_received_"));
    await s.t.run((ctx) => ctx.db.patch(allocation._id, { currency: "USD" }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "CURRENCY_MISMATCH" });
  });

  test("S2: a receivable in another currency than the organisation's fails closed", async () => {
    const s = await seedDealership("cashorgcur");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      await ctx.db.patch(sale!.canonicalReceivableDocumentId!, { currency: "USD" });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "CURRENCY_MISMATCH" });
  });

  test("a credit larger than the bill is UNAVAILABLE, never a printed negative", async () => {
    const s = await seedDealership("cashneg");
    const saleId = await cashSaleWithTradeIn(s, 2_000);
    const [allocation] = (await allocationsOf(s, saleId)).filter((a) => a.key === `trade_in_payment_${saleId}`);
    await s.t.run((ctx) => ctx.db.patch(allocation._id, { amountMinor: 99_000 * SCALE }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NEGATIVE_BALANCE" });
  });

  test("no canonical receivable is UNAVAILABLE, not 0", async () => {
    const s = await seedDealership("cashnorec");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { canonicalReceivableDocumentId: undefined }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NO_RECEIVABLE" });
  });

  test("a receivable that belongs to another sale is not trusted", async () => {
    const s = await seedDealership("cashforeign");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      await ctx.db.patch(sale!.canonicalReceivableDocumentId!, { sourceId: "someone-else" });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NO_RECEIVABLE" });
  });

  test("a draft (PENDING) sale has no official figures", async () => {
    const s = await seedDealership("cashdraft");
    const saleId = await s.as.mutation(api.sales.createDraft, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
      salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), financingType: "CASH",
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NOT_COMPLETED" });
  });

  test("a LEASE row is NOT_SUPPORTED (retired mode, legacy data)", async () => {
    const s = await seedDealership("lease");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { financingType: "LEASE" }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NOT_SUPPORTED" });
  });
});

describe("getBillOfSaleEconomics - FINANCED (through the Deal)", () => {
  test("states the customer's priced snapshot with exactly the FINANCED keys, and none of the approval-tier amounts", async () => {
    const s = await seedDealership("fin");
    const { saleId, quoteId, applicationId } = await financedSaleThroughDeal(s);
    const quote = await s.t.run((ctx) => ctx.db.get(quoteId));
    const snap = quote!.customerQuotePricingSnapshot!;
    const e = await query(s, saleId);
    // toEqual pins the exact key set: no approval-tier field can ride along.
    expect(e).toEqual({
      kind: "FINANCED", currency: "JOD", vehiclePrice: snap.vehiclePrice, downPayment: snap.downPayment,
      executionFees: snap.executionFees, capitalisedCommission: 0,
      amountFinanced: snap.totalFinancedAmount, termMonths: 48, flatAnnualProfitRatePercent: 5,
    });
    // The finance-approval tier is not a source: moving every amount on the application changes nothing.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: 7_777_000, dealerContributionMinor: 3_333_000, customerGapCashToDealerMinor: 1_111_000,
      })
    );
    expect(await query(s, saleId)).toEqual(e);
    // Footing: price - down + fees + capitalised commission = amount financed.
    const f = e as Extract<typeof e, { kind: "FINANCED" }>;
    expect(f.vehiclePrice - f.downPayment + f.executionFees + f.capitalisedCommission).toBeCloseTo(f.amountFinanced, 3);
  });

  test("a manual quote with no stated profit rate reports the rate as null, never 0", async () => {
    const s = await seedDealership("finnorate");
    const { saleId, applicationId } = await financedSaleThroughDeal(s);
    // The rate is read from the application's frozen copy: remove it there (a deal that never stated one).
    await s.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const { profitRate: _dropped, ...rest } = app!.manualFinanceSnapshot!;
      await ctx.db.patch(applicationId, { manualFinanceSnapshot: rest });
    });
    expect(await query(s, saleId)).toMatchObject({ kind: "FINANCED", flatAnnualProfitRatePercent: null });
  });

  test("S258-01 (g): the printed rate does not follow a post-sale edit of quote.manualProfitRate", async () => {
    const s = await seedDealership("finratefrozen");
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(quoteId, { manualProfitRate: undefined }));
    expect(await query(s, saleId)).toMatchObject({ kind: "FINANCED", flatAnnualProfitRatePercent: 5 });
    await s.t.run((ctx) => ctx.db.patch(quoteId, { manualProfitRate: 9 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "FINANCED", flatAnnualProfitRatePercent: 5 });
  });

  test("a caller-supplied sale.loanAmount / downPayment / apr never moves a FINANCED figure", async () => {
    const s = await seedDealership("finlie");
    const { saleId } = await financedSaleThroughDeal(s);
    const before = await query(s, saleId);
    await s.t.run((ctx) => ctx.db.patch(saleId, { loanAmount: 1, downPayment: 1, apr: 99 } as never));
    expect(await query(s, saleId)).toEqual(before);
  });

  test("no pricing snapshot on the application (the frozen, sale-bound copy) is UNAVAILABLE (f)", async () => {
    const s = await seedDealership("finnosnap");
    const { saleId, applicationId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerQuotePricingSnapshot: undefined }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NO_PRICING_SNAPSHOT" });
  });

  describe("S258-01: the quote is editable after the sale; the application's frozen snapshot is the authority", () => {
    const UNAVAILABLE_MISMATCH = { kind: "UNAVAILABLE", reason: "SNAPSHOT_MISMATCH" };

    /**
     * A direct-DB edit of the quote after the sale (legacy / out-of-band drift). Since SCRUM-528 `quotes`
     * is a financial table, so `adminData.adminUpdateRecord` refuses it; these tests keep covering the
     * snapshot comparison as the backstop against drift that bypasses that door.
     */
    async function adminPatchQuote(s: Seeded, quoteId: Id<"quotes">, patch: Record<string, unknown>) {
      await s.t.run((ctx) => ctx.db.patch(quoteId, patch as never));
    }
    const quoteSnap = async (s: Seeded, quoteId: Id<"quotes">) =>
      (await s.t.run((ctx) => ctx.db.get(quoteId)))!.customerQuotePricingSnapshot!;

    test("(e) untouched control: the figures are the literals", async () => {
      const s = await seedDealership("s01e");
      const { saleId } = await financedSaleThroughDeal(s);
      expect(await query(s, saleId)).toEqual({
        kind: "FINANCED", currency: "JOD", vehiclePrice: 12_000, downPayment: 0, executionFees: 0,
        capitalisedCommission: 0, amountFinanced: 12_000, termMonths: 48, flatAnnualProfitRatePercent: 5,
      });
    });

    test("(a) a BALANCED admin edit of the quote snapshot (down +1000, financed -1000) prints nothing", async () => {
      const s = await seedDealership("s01a");
      const { saleId, quoteId } = await financedSaleThroughDeal(s);
      const snap = await quoteSnap(s, quoteId);
      await adminPatchQuote(s, quoteId, {
        customerQuotePricingSnapshot: { ...snap, downPayment: snap.downPayment + 1_000, totalFinancedAmount: snap.totalFinancedAmount - 1_000 },
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await query(s, saleId)).toEqual(UNAVAILABLE_MISMATCH);
      consoleError.mockRestore();
    });

    test("(b) a price-only edit (footing broken) is SNAPSHOT_MISMATCH: the cross-check runs before footing", async () => {
      const s = await seedDealership("s01b");
      const { saleId, quoteId } = await financedSaleThroughDeal(s);
      const snap = await quoteSnap(s, quoteId);
      await adminPatchQuote(s, quoteId, { customerQuotePricingSnapshot: { ...snap, vehiclePrice: snap.vehiclePrice + 500 } });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await query(s, saleId)).toEqual(UNAVAILABLE_MISMATCH);
      consoleError.mockRestore();
    });

    test("(c) a rate-only edit (profitRate) is SNAPSHOT_MISMATCH", async () => {
      const s = await seedDealership("s01c");
      const { saleId, quoteId } = await financedSaleThroughDeal(s);
      const snap = await quoteSnap(s, quoteId);
      await adminPatchQuote(s, quoteId, { customerQuotePricingSnapshot: { ...snap, profitRate: snap.profitRate + 3 } });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await query(s, saleId)).toEqual(UNAVAILABLE_MISMATCH);
      consoleError.mockRestore();
    });

    test("(d) removing the quote's snapshot is SNAPSHOT_MISMATCH, not a number", async () => {
      const s = await seedDealership("s01d");
      const { saleId, quoteId } = await financedSaleThroughDeal(s);
      await s.t.run((ctx) => ctx.db.patch(quoteId, { customerQuotePricingSnapshot: undefined }));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await query(s, saleId)).toEqual(UNAVAILABLE_MISMATCH);
      consoleError.mockRestore();
    });
  });

  test("S3: a snapshot whose itemisation does not foot to the amount financed is DOES_NOT_FOOT, never a printed figure", async () => {
    const s = await seedDealership("finfoot");
    const { saleId, quoteId, applicationId } = await financedSaleThroughDeal(s);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await s.t.run(async (ctx) => {
      const quote = await ctx.db.get(quoteId);
      const snap = quote!.customerQuotePricingSnapshot!;
      // Break the FROZEN copy (and the quote, so the cross-check agrees): only footing remains to refuse it.
      const broken = { ...snap, totalFinancedAmount: snap.totalFinancedAmount + 1 };
      await ctx.db.patch(quoteId, { customerQuotePricingSnapshot: broken });
      await ctx.db.patch(applicationId, { customerQuotePricingSnapshot: broken });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "DOES_NOT_FOOT" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("an application that does not point back at the sale is a LINK_MISMATCH", async () => {
    const s = await seedDealership("finlink");
    const { saleId, applicationId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { finalizedSaleId: undefined }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "LINK_MISMATCH" });
  });

  test("a snapshot in another currency than the organisation's is a CURRENCY_MISMATCH", async () => {
    const s = await seedDealership("fincur");
    const { saleId, quoteId, applicationId } = await financedSaleThroughDeal(s);
    await s.t.run(async (ctx) => {
      const quote = await ctx.db.get(quoteId);
      const usd = { ...quote!.customerQuotePricingSnapshot!, currency: "USD" };
      await ctx.db.patch(quoteId, { customerQuotePricingSnapshot: usd });
      await ctx.db.patch(applicationId, { customerQuotePricingSnapshot: usd });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "CURRENCY_MISMATCH" });
  });

  test("a multi-vehicle quote is MULTI_VEHICLE (one price cannot be stated for one car)", async () => {
    const s = await seedDealership("finmulti");
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    const other = await s.mkVehicle("B");
    await s.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 6_000 }, { vehicleId: other, unitPrice: 6_000 }],
      } as never)
    );
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "MULTI_VEHICLE" });
  });

  test("a quote for a different vehicle than the sale is VEHICLE_MISMATCH, not MULTI_VEHICLE", async () => {
    const s = await seedDealership("finvmis");
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    const other = await s.mkVehicle("B");
    await s.t.run((ctx) => ctx.db.patch(quoteId, { vehicleId: other }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "VEHICLE_MISMATCH" });
  });

  // R3 F3: the Bill of Sale states the customer-priced snapshot, itemised. Every expected figure
  // below is an independent literal (price - down + fees [+ commission when NOT carried in the debt]),
  // never a value read back from the result under test.
  test.each([
    { includes: true, capitalisedCommission: 0, amountFinanced: 10_100 },
    { includes: false, capitalisedCommission: 300, amountFinanced: 10_400 },
  ])(
    "a real Deal with a down payment, execution fees and commission itemises exactly (includesCommissionInDebt=$includes)",
    async ({ includes, capitalisedCommission, amountFinanced }) => {
      const s = await seedDealership(`finitem${includes ? "T" : "F"}`);
      const { saleId } = await financedSaleThroughDeal(s, {
        downPayment: 2_000, manualAdminFees: 100, manualCommission: 300, manualIncludesCommissionInDebt: includes,
      });
      expect(await query(s, saleId)).toEqual({
        kind: "FINANCED", currency: "JOD", vehiclePrice: 12_000, downPayment: 2_000, executionFees: 100,
        capitalisedCommission, amountFinanced, termMonths: 48, flatAnnualProfitRatePercent: 5,
      });
    }
  );

  test("a FINANCED row with no application at all (legacy) is LINK_MISMATCH", async () => {
    const s = await seedDealership("finlegacy");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { financingType: "FINANCED" }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "LINK_MISMATCH" });
  });
});

describe("getBillOfSaleEconomics - access", () => {
  test("another organisation's sale is refused and discloses nothing", async () => {
    const a = await seedDealership("orgA");
    const saleId = await cashSale(a);
    const b = await seedDealership("orgB");
    await expect(
      b.as.query(api.sales.getBillOfSaleEconomics, { orgId: b.orgId, saleId })
    ).rejects.toThrow();
    await expect(
      b.as.query(api.sales.getBillOfSaleEconomics, { orgId: a.orgId, saleId })
    ).rejects.toThrow();
  });

  test("a member without view:sales is refused", async () => {
    const s = await seedDealership("noperm");
    const saleId = await cashSale(s);
    await expect(
      s.blind.query(api.sales.getBillOfSaleEconomics, { orgId: s.orgId, saleId })
    ).rejects.toThrow();
  });

  test("it is a pure read: calling it changes no row", async () => {
    const s = await seedDealership("pure");
    const saleId = await cashSale(s);
    const snapshot = () =>
      s.t.run(async (ctx) => ({
        sales: await ctx.db.query("sales").collect(),
        receivables: await ctx.db.query("receivableDocuments").collect(),
      }));
    const before = await snapshot();
    await query(s, saleId);
    await query(s, saleId);
    expect(await snapshot()).toEqual(before);
  });
});

describe("SCRUM-504 - a financed sale exists only through the Deal", () => {
  const draft = (s: Seeded, financingType: "CASH" | "FINANCED") => ({
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
    salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), financingType,
  });

  test("sales.create FINANCED is refused with the code and exact message; nothing is written", async () => {
    const s = await seedDealership("r504create");
    await expectFinancedSaleRequiresDeal(
      s.as.mutation(api.sales.create, { ...draft(s, "FINANCED"), status: "COMPLETED" })
    );
    expect(await s.t.run((ctx) => ctx.db.query("sales").first())).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(s.vehicleId)))?.status).toBe("AVAILABLE");
  });

  test("sales.createDraft FINANCED is refused", async () => {
    const s = await seedDealership("r504draft");
    await expectFinancedSaleRequiresDeal(s.as.mutation(api.sales.createDraft, draft(s, "FINANCED")));
    expect(await s.t.run((ctx) => ctx.db.query("sales").first())).toBeNull();
  });

  test("sales.update into FINANCED is refused and leaves the draft unchanged", async () => {
    const s = await seedDealership("r504update");
    const saleId = await s.as.mutation(api.sales.createDraft, draft(s, "CASH"));
    const before = await s.t.run((ctx) => ctx.db.get(saleId));
    await expectFinancedSaleRequiresDeal(
      s.as.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "FINANCED" })
    );
    expect(await s.t.run((ctx) => ctx.db.get(saleId))).toEqual(before);
  });

  test("sales.completeDraft on a legacy FINANCED draft is refused and the draft stays PENDING", async () => {
    const s = await seedDealership("r504complete");
    const saleId = await s.as.mutation(api.sales.createDraft, draft(s, "CASH"));
    await s.t.run((ctx) => ctx.db.patch(saleId, { financingType: "FINANCED" }));
    await expectFinancedSaleRequiresDeal(
      s.as.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() })
    );
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("PENDING");
  });

  test("a legacy FINANCED draft can still be CANCELLED (never a dead end)", async () => {
    const s = await seedDealership("r504cancel");
    const saleId = await s.as.mutation(api.sales.createDraft, draft(s, "CASH"));
    await s.t.run((ctx) => ctx.db.patch(saleId, { financingType: "FINANCED" }));
    await s.approver.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))).toMatchObject({ status: "CANCELLED", financingType: "FINANCED" });
  });

  test("a legacy FINANCED draft can still be moved to CASH (never a dead end)", async () => {
    const s = await seedDealership("r504exit");
    const saleId = await s.as.mutation(api.sales.createDraft, draft(s, "CASH"));
    await s.t.run((ctx) => ctx.db.patch(saleId, { financingType: "FINANCED" }));
    await s.as.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "CASH" });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.financingType).toBe("CASH");
  });

  test("finalizeDeal still completes a FINANCED sale, with its application", async () => {
    const s = await seedDealership("r504deal");
    const { saleId, applicationId } = await financedSaleThroughDeal(s);
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(sale).toMatchObject({ status: "COMPLETED", financingType: "FINANCED", applicationId });
  });

  test("a replay of a key already used by a CASH create returns the stored result, not a refusal", async () => {
    const s = await seedDealership("r504replay");
    const args = { ...draft(s, "CASH"), status: "COMPLETED" as const };
    const first = await s.as.mutation(api.sales.create, args);
    const again = await s.as.mutation(api.sales.create, args);
    expect(again).toBe(first);
  });
});

describe("SCRUM-528 - finalizeDeal builds the sale only from quote economics that agree with the application's frozen snapshot", () => {
  /** Every table's rows, so "zero writes" means the whole database, not a hand-picked list. */
  const databaseState = (s: Seeded) =>
    s.t.run(async (ctx) => {
      const out: Record<string, unknown[]> = {};
      for (const table of Object.keys(schema.tables)) {
        out[table] = await ctx.db.query(table as never).collect();
      }
      return out;
    });

  /** The deal is refused with the coded error and NOTHING in the database changed. */
  async function expectRefusedWithZeroWrites(s: Seeded, applicationId: Id<"financeApplications">) {
    const before = await databaseState(s);
    await expectQuoteEconomicsDrifted(finalize(s, applicationId));
    expect(await databaseState(s)).toEqual(before);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app).toMatchObject({ status: "APPROVED" });
    expect(app?.finalizedSaleId).toBeUndefined();
    const sales = await s.t.run((ctx) => ctx.db.query("sales").collect());
    expect(sales).toHaveLength(0);
  }

  test("control: with no drift the deal finalizes", async () => {
    const s = await seedDealership("d528ctl");
    const { applicationId } = await readyFinancedDeal(s);
    const saleId = (await finalize(s, applicationId)) as Id<"sales">;
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(sale).toMatchObject({ salePrice: 12_000, downPayment: 0, loanAmount: 12_000, termMonths: 48, financingType: "FINANCED" });
  });

  test.each([
    ["vehiclePrice", { vehiclePrice: 11_000 }],
    ["downPayment", { downPayment: 1_000 }],
    ["totalFinancedAmount", { totalFinancedAmount: 9_000 }],
    ["termMonths", { termMonths: 60 }],
  ])("a quote whose top-level %s drifted refuses with the coded error and writes nothing", async (field, patch) => {
    const s = await seedDealership(`d528${field}`);
    const { applicationId, quoteId } = await readyFinancedDeal(s);
    await s.t.run((ctx) => ctx.db.patch(quoteId, patch));
    await expectRefusedWithZeroWrites(s, applicationId);
  });

  test("a replay of a key that already finalized returns the stored sale even if the quote drifts afterwards (no second sale, no refusal)", async () => {
    const s = await seedDealership("d528replay");
    const { applicationId, quoteId } = await readyFinancedDeal(s);
    const args = { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId };
    const first = await s.as.mutation(api.applications.finalizeDeal, args);
    await s.t.run((ctx) => ctx.db.patch(quoteId, { vehiclePrice: 1 }));
    expect(await s.as.mutation(api.applications.finalizeDeal, args)).toBe(first);
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(1);
  });

  test.each<[string, (snap: NonNullable<Doc<"quotes">["customerQuotePricingSnapshot"]>) => Partial<Doc<"quotes">>]>([
    ["a drift only inside quote.customerQuotePricingSnapshot refuses", (snap) => ({ customerQuotePricingSnapshot: { ...snap, profitRate: 9 } })],
    ["a quote whose snapshot was removed refuses", () => ({ customerQuotePricingSnapshot: undefined })],
  ])("%s", async (_name, quotePatch) => {
    const s = await seedDealership("d528quotesnap");
    const { applicationId, quoteId } = await readyFinancedDeal(s);
    await s.t.run(async (ctx) => {
      const q = await ctx.db.get(quoteId);
      await ctx.db.patch(quoteId, quotePatch(q!.customerQuotePricingSnapshot!));
    });
    await expectRefusedWithZeroWrites(s, applicationId);
  });

  test("a BALANCED drift (top-level and quote snapshot changed consistently) still refuses: the application is the anchor", async () => {
    const s = await seedDealership("d528balanced");
    const { applicationId, quoteId } = await readyFinancedDeal(s);
    await s.t.run(async (ctx) => {
      const q = await ctx.db.get(quoteId);
      const snap = q!.customerQuotePricingSnapshot!;
      const next = { ...snap, downPayment: snap.downPayment + 1_000, totalFinancedAmount: snap.totalFinancedAmount - 1_000 };
      await ctx.db.patch(quoteId, {
        downPayment: next.downPayment, totalFinancedAmount: next.totalFinancedAmount, customerQuotePricingSnapshot: next,
      });
    });
    await expectRefusedWithZeroWrites(s, applicationId);
  });

  describe("no snapshot on the application: a financed deal fails closed", () => {
    test.each<[string, Partial<Doc<"financeApplications">>]>([
      ["MANUAL_FINANCE_COMPANY application refuses", {}],
      ["a legacy application whose MANUAL mode is only on its quote (no quoteModeAtSubmission) refuses", { quoteModeAtSubmission: undefined }],
      ["CONFIGURED_FINANCE_COMPANY mode refuses", { quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY" }],
    ])("%s", async (_name, appPatch) => {
      const s = await seedDealership("d528nosnap");
      const { applicationId } = await readyFinancedDeal(s);
      await s.t.run((ctx) => ctx.db.patch(applicationId, { ...appPatch, customerQuotePricingSnapshot: undefined }));
      await expectRefusedWithZeroWrites(s, applicationId);
    });
    test("a mode-less application WITH a company refuses", async () => {
      const s = await seedDealership("d528nosnapco");
      const { applicationId, quoteId } = await readyFinancedDeal(s);
      const companyId = await s.t.run((ctx) =>
        ctx.db.insert("financeCompanies", {
          orgId: s.orgId, name: "Configured Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0,
          isActive: true, adminFees: 0, defaultLtvPercent: 100,
        })
      );
      await s.t.run(async (ctx) => {
        await ctx.db.patch(applicationId, { customerQuotePricingSnapshot: undefined, quoteModeAtSubmission: undefined, companyId });
        await ctx.db.patch(quoteId, { mode: undefined, companyId });
      });
      await expectRefusedWithZeroWrites(s, applicationId);
    });

    test("control: a mode-less application with no company and no snapshot is not compared (CASH)", async () => {
      const s = await seedDealership("d528nosnapcash");
      const { applicationId, quoteId } = await readyFinancedDeal(s);
      await s.t.run(async (ctx) => {
        await ctx.db.patch(applicationId, { customerQuotePricingSnapshot: undefined, quoteModeAtSubmission: undefined });
        await ctx.db.patch(quoteId, { mode: undefined });
      });
      // Not compared: the deal finalizes as a plain CASH sale.
      const saleId = (await finalize(s, applicationId)) as Id<"sales">;
      expect(await s.t.run((ctx) => ctx.db.get(saleId))).toMatchObject({ financingType: "CASH", status: "COMPLETED" });
    });
  });

  describe("no generic admin path may change a quote (quotes is a financial table)", () => {
    async function superAdmin(s: Seeded) {
      process.env.SUPER_ADMIN_EMAILS = "s528.admin@autoflow.dev";
      process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
      process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
      await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "s528_sa", email: "s528.admin@autoflow.dev", name: "sa" }));
      return s.t.withIdentity({ subject: "s528_sa", clerkId: "s528_sa" });
    }
    const forbidden = (action: string) =>
      `Financial table "quotes" cannot be changed through ${action}. Use a domain reversal, cancellation, or audited correction workflow.`;
    const draftQuote = async (s: Seeded) =>
      (await s.as.mutation(api.quotes.saveQuote, {
        orgId: s.orgId, customerId: s.customerId, vehicleId: await s.mkVehicle("B"), vehiclePrice: 12_000, downPayment: 0,
        termMonths: 48, mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option", manualAdminFees: 0,
        manualProfitRate: 5,
      } as never)) as Id<"quotes">;

    test.each<[string, string, (s: Seeded) => Promise<Id<"quotes">>]>([
      ["with an application", "d528admapp", async (s) => (await readyFinancedDeal(s)).quoteId],
      ["a DRAFT with no application", "d528admdraft", draftQuote],
    ])("update / restore / hard delete refuse a quote %s", async (_label, seedKey, setup) => {
      const s = await seedDealership(seedKey);
      const quoteId = await setup(s);
      const admin = await superAdmin(s);
      const before = await s.t.run((ctx) => ctx.db.get(quoteId));
      await expectAppError(
        admin.mutation(api.adminData.adminUpdateRecord, { table: "quotes", id: quoteId, patch: { vehiclePrice: 1 } }),
        "FORBIDDEN", forbidden("adminUpdateRecord")
      );
      await expectAppError(
        admin.mutation(api.adminData.adminRestoreRecords, { table: "quotes", ids: [quoteId] }),
        "FORBIDDEN", forbidden("adminRestoreRecords")
      );
      await expectAppError(
        admin.mutation(api.adminData.adminHardDelete, { table: "quotes", id: quoteId }),
        "FORBIDDEN", forbidden("adminHardDelete")
      );
      expect(await s.t.run((ctx) => ctx.db.get(quoteId))).toEqual(before);
    });
  });
});
