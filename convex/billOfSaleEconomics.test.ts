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
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
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

/** A real Deal: manual finance company quote -> application -> approval -> finalizeDeal. */
async function financedSaleThroughDeal(s: Seeded, quoteExtra: Record<string, unknown> = {}) {
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
  const saleId = await s.as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
  });
  return { saleId: saleId as Id<"sales">, applicationId, quoteId };
}

describe("getBillOfSaleEconomics - CASH", () => {
  test("a plain cash sale states the ledger receivable and nothing else", async () => {
    const s = await seedDealership("cash");
    const saleId = await cashSale(s);
    const e = await query(s, saleId);
    expect(e).toEqual({ kind: "CASH", currency: "JOD", totalBilled: 13_000, tradeInCredit: 0, depositsApplied: 0, balanceDue: 13_000 });
    expect(Object.keys(e).sort()).toEqual(["balanceDue", "currency", "depositsApplied", "kind", "totalBilled", "tradeInCredit"]);
  });

  test("a caller-supplied downPayment and loanAmount never move a CASH figure", async () => {
    const s = await seedDealership("cashdp");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { downPayment: 4_000, loanAmount: 9_000 }));
    const e = await query(s, saleId);
    expect(e).toMatchObject({ kind: "CASH", totalBilled: 13_000, balanceDue: 13_000 });
  });

  test("a trade-in value with no trade-in vehicle is not a credit", async () => {
    const s = await seedDealership("cashtv");
    const saleId = await cashSale(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInValue: 2_000 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", tradeInCredit: 0, balanceDue: 13_000 });
  });

  test("a trade-in vehicle credits its value against the balance", async () => {
    const s = await seedDealership("cashti");
    const saleId = await cashSale(s);
    const tradeIn = await s.mkVehicle("T");
    await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: tradeIn, tradeInValue: 2_000 }));
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", tradeInCredit: 2_000, balanceDue: 11_000 });
  });

  test("an applied customer-receivable deposit reduces the balance; reversed and supplier-settlement ones do not", async () => {
    const s = await seedDealership("cashdep");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const depositId = await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
        amount: 1_500, amountMinor: 1_500_000, currency: "JOD", method: "CASH", status: "APPLIED", holdActive: false,
        createdBy: s.userId, createdAt: Date.now(),
      } as never);
      const base = {
        orgId: s.orgId, depositId, vehicleId: s.vehicleId, saleId, customerId: s.customerId,
        currency: "JOD", eventType: "x", eventSourceType: "x", eventSourceId: "x", eventVersion: 1,
        appliedAt: Date.now(), appliedBy: s.userId,
      };
      await ctx.db.insert("depositApplications", { ...base, amountMinor: 1_500_000, treatment: "CUSTOMER_RECEIVABLE", status: "APPLIED", eventIdempotencyKey: "k1" });
      await ctx.db.insert("depositApplications", { ...base, amountMinor: 700_000, treatment: "CUSTOMER_RECEIVABLE", status: "REVERSED", eventIdempotencyKey: "k2" });
      await ctx.db.insert("depositApplications", { ...base, amountMinor: 900_000, treatment: "SUPPLIER_SETTLEMENT", status: "APPLIED", eventIdempotencyKey: "k3" });
    });
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", depositsApplied: 1_500, balanceDue: 11_500 });
  });

  test("a deposit in another currency than the receivable fails closed", async () => {
    const s = await seedDealership("cashcur");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const depositId = await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
        amount: 1, amountMinor: 100, currency: "USD", method: "CASH", status: "APPLIED", holdActive: false,
        createdBy: s.userId, createdAt: Date.now(),
      } as never);
      await ctx.db.insert("depositApplications", {
        orgId: s.orgId, depositId, vehicleId: s.vehicleId, saleId, customerId: s.customerId, currency: "USD",
        amountMinor: 100, treatment: "CUSTOMER_RECEIVABLE", status: "APPLIED", eventType: "x", eventSourceType: "x",
        eventSourceId: "x", eventVersion: 1, eventIdempotencyKey: "kc", appliedAt: Date.now(), appliedBy: s.userId,
      });
    });
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "CURRENCY_MISMATCH" });
  });

  test("a consigned direct-route sale, whose receivable is 0, states 0 - the ledger's own figure", async () => {
    const s = await seedDealership("cashzero");
    const saleId = await cashSale(s);
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      await ctx.db.patch(sale!.canonicalReceivableDocumentId!, { originalAmountMinor: 0 });
    });
    expect(await query(s, saleId)).toMatchObject({ kind: "CASH", totalBilled: 0, balanceDue: 0 });
  });

  test("a negative balance is UNAVAILABLE, never a printed negative", async () => {
    const s = await seedDealership("cashneg");
    const saleId = await cashSale(s);
    const tradeIn = await s.mkVehicle("T");
    await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: tradeIn, tradeInValue: 99_000 }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NO_RECEIVABLE" });
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
    expect(e.kind).toBe("FINANCED");
    expect(Object.keys(e).sort()).toEqual([
      "amountFinanced", "capitalisedCommission", "currency", "downPayment", "executionFees",
      "flatAnnualProfitRatePercent", "kind", "termMonths", "vehiclePrice",
    ]);
    expect(e).toMatchObject({
      currency: "JOD", vehiclePrice: snap.vehiclePrice, downPayment: snap.downPayment,
      executionFees: snap.executionFees, amountFinanced: snap.totalFinancedAmount, termMonths: 48,
      flatAnnualProfitRatePercent: 5,
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
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(quoteId, { manualProfitRate: undefined }));
    expect(await query(s, saleId)).toMatchObject({ kind: "FINANCED", flatAnnualProfitRatePercent: null });
  });

  test("a caller-supplied sale.loanAmount / downPayment / apr never moves a FINANCED figure", async () => {
    const s = await seedDealership("finlie");
    const { saleId } = await financedSaleThroughDeal(s);
    const before = await query(s, saleId);
    await s.t.run((ctx) => ctx.db.patch(saleId, { loanAmount: 1, downPayment: 1, apr: 99 } as never));
    expect(await query(s, saleId)).toEqual(before);
  });

  test("no pricing snapshot on the quote is UNAVAILABLE", async () => {
    const s = await seedDealership("finnosnap");
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(quoteId, { customerQuotePricingSnapshot: undefined }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "NO_PRICING_SNAPSHOT" });
  });

  test("an application that does not point back at the sale is a LINK_MISMATCH", async () => {
    const s = await seedDealership("finlink");
    const { saleId, applicationId } = await financedSaleThroughDeal(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { finalizedSaleId: undefined }));
    expect(await query(s, saleId)).toEqual({ kind: "UNAVAILABLE", reason: "LINK_MISMATCH" });
  });

  test("a snapshot in another currency than the organisation's is a CURRENCY_MISMATCH", async () => {
    const s = await seedDealership("fincur");
    const { saleId, quoteId } = await financedSaleThroughDeal(s);
    await s.t.run(async (ctx) => {
      const quote = await ctx.db.get(quoteId);
      await ctx.db.patch(quoteId, { customerQuotePricingSnapshot: { ...quote!.customerQuotePricingSnapshot!, currency: "USD" } });
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

  test("a legacy FINANCED draft can still be CANCELLED or moved to CASH (never a dead end)", async () => {
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
