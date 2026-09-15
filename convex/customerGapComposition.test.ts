import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { composeCustomerGapToDealer, requireCustomerGapToDealer } from "./utils/financingEconomics";
import { resolveFinancedSalePlan } from "./utils/financedSaleRecognition";

/**
 * The customer's gap contribution to the dealership is composed from TWO
 * stored fields. Added inline before validation, a corrupt pair cancels —
 * −100 + 200 is a safe 100 — and every reader downstream certifies it. One
 * boundary now validates each present component and the sum, and every
 * profit, economics recomputation and posting plan reads through it.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;
const MODULES = import.meta.glob("./**/*.*s");

/** Component pairs that are wrong, including the pair that used to cancel. */
const CORRUPT_PAIRS: Array<[string, { cash?: number; installment?: number }]> = [
  ["a negative cash cancelled by a larger instalment", { cash: -100_000, installment: 200_000 }],
  ["a negative instalment cancelled by cash", { cash: 300_000, installment: -100_000 }],
  ["NaN cash", { cash: Number.NaN, installment: 0 }],
  ["Infinity instalment", { cash: 0, installment: Number.POSITIVE_INFINITY }],
  ["a fractional cash", { cash: 100_000.5, installment: 0 }],
  ["an unsafe instalment", { cash: 0, installment: Number.MAX_SAFE_INTEGER + 2 }],
  ["two negatives", { cash: -1, installment: -1 }],
  ["safe components that overflow between them", { cash: Number.MAX_SAFE_INTEGER - 1, installment: 2 }],
];

const asApp = (pair: { cash?: number; installment?: number }) => ({
  customerGapCashToDealerMinor: pair.cash,
  customerGapInstallmentToDealerMinor: pair.installment,
});

describe("composeCustomerGapToDealer", () => {
  test("both absent is zero (nothing agreed yet), one absent adds the other, both present add", () => {
    expect(composeCustomerGapToDealer({})).toEqual({ readable: true, amountMinor: 0 });
    expect(composeCustomerGapToDealer(asApp({ cash: 700_000 }))).toEqual({ readable: true, amountMinor: 700_000 });
    expect(composeCustomerGapToDealer(asApp({ installment: 300_000 }))).toEqual({ readable: true, amountMinor: 300_000 });
    expect(composeCustomerGapToDealer(asApp({ cash: 700_000, installment: 300_000 }))).toEqual({ readable: true, amountMinor: 1_000_000 });
    expect(composeCustomerGapToDealer(asApp({ cash: 0, installment: 0 }))).toEqual({ readable: true, amountMinor: 0 });
  });

  test.each(CORRUPT_PAIRS)("%s is unreadable, never a number", (_label, pair) => {
    expect(composeCustomerGapToDealer(asApp(pair))).toEqual({ readable: false, reason: "UNSAFE_AMOUNT" });
    expect(() => requireCustomerGapToDealer(asApp(pair), "the test")).toThrow(/not a readable amount/);
  });
});

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  vehicleId: Id<"vehicles">;
  applicationId: Id<"financeApplications">;
  asOwner: AuthenticatedTestConvex;
}

async function seed(suffix: string, sourceType: "STOCK" | "SOURCED"): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Gap Dealer ${suffix}`, createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `gap_owner_${suffix}`, email: `gap${suffix}@x.com`, name: "Owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Gap", lastName: "Customer" }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `GAPVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024, mileage: 100, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 10_500, status: "AVAILABLE",
      ...(sourceType === "SOURCED"
        ? { sourceType: "SOURCED" as const, sourceCost: 8_000, sourcedFromName: "Supplier Co" }
        : { sourceType: "STOCK" as const, purchasePrice: 9_500, landedCostTotal: 100 }),
    })
  );
  if (sourceType === "SOURCED") {
    await t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId, vehicleId, sourcedFromName: "Supplier Co", amountDue: 8_000, amountPaid: 0, currency: "JOD",
        status: "DUE_ON_SALE", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
  }
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500, termMonths: 60, status: "ACCEPTED",
      createdBy: userId, createdAt: Date.now(),
    })
  );
  const applicationId = await t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId, status: "APPROVED", economicsCurrency: "JOD",
      targetSellingAmountMinor: 12_000_000, approvedDealerPurchaseAmountMinor: 11_000_000,
      financeCompanyFundedPortionMinor: 9_350_000, dealerContributionMinor: 1_650_000,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  return { t, orgId, userId, vehicleId, applicationId, asOwner: t.withIdentity({ subject: `gap_owner_${suffix}` }) };
}

async function setGap(s: Seed, pair: { cash?: number; installment?: number }) {
  await s.t.run((ctx) =>
    ctx.db.patch(s.applicationId, {
      rawAppraisalGapMinor: 100_000,
      gapResolution: "CUSTOMER_ABSORBS",
      customerGapShareMinor: 100_000,
      customerGapCashToDealerMinor: pair.cash,
      customerGapInstallmentToDealerMinor: pair.installment,
      customerGapToFinanceCompanyMinor: 0,
    })
  );
}

describe("the composition boundary at every real caller", () => {
  test("STOCK: a readable pair adds into the planned line; a cancelling pair is CorruptInput, not a 100 JOD profit line", async () => {
    const s = await seed("stock", "STOCK");
    await setGap(s, { cash: 100_000, installment: 200_000 });
    const readable = (await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId }))!
      .financialSummary!.profit;
    if (!readable.available || readable.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
    expect(readable.lines).toContainEqual({ key: "CUSTOMER_PLANNED_TO_DEALER", sign: 1, amountMinor: 300_000 });

    for (const [, pair] of CORRUPT_PAIRS) {
      await setGap(s, pair);
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId });
      expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "CorruptInput" });
    }
  });

  test("STOCK: a CANCELLED deal reads DealCancelled even when its gap components are corrupt — cancellation outranks the composition", async () => {
    const s = await seed("cancelled", "STOCK");
    await setGap(s, { cash: -100_000, installment: 200_000 });
    await s.t.run((ctx) => ctx.db.patch(s.applicationId, { status: "CANCELLED" }));
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId });
    expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "DealCancelled" });
  });

  test("SOURCED (ACC-1 consignment): the cockpit's own profit and the overview's both refuse a cancelling pair", async () => {
    const s = await seed("sourced", "SOURCED");
    await setGap(s, { cash: 100_000, installment: 0 });
    const cockpit = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
    const own = cockpit!.money!.profit;
    if (!own.available || own.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected the cockpit's consignment estimate");
    expect(own.amountMinor).toBe(11_000_000 + 100_000 - 8_000_000 - 1_650_000);

    for (const [, pair] of CORRUPT_PAIRS) {
      await setGap(s, pair);
      const corrupt = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
      expect(corrupt!.money!.profit).toEqual({ available: false, reason: "CorruptInput" });
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId });
      expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "CorruptInput" });
    }
  });

  test("the posting plan refuses a cancelling pair before it builds anything, and builds on a readable one", async () => {
    const s = await seed("plan", "STOCK");
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId, name: "Plan Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true, ruleVersion: 1,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.patch(s.applicationId, {
        companyId,
        // Invoice = what the financier remits (11,000) + the customer's 300 gap.
        legalInvoiceAmountMinor: 11_300_000,
        legalInvoiceNumber: "INV-1",
        legalInvoiceDate: Date.now(),
        legalInvoiceIssuedTo: "FINANCE_COMPANY",
        // The engine's frozen answer, consistent with gross 11,000 and no deductions.
        expectedDealerRemittanceMinor: 11_000_000,
      })
    );
    const plan = async (pair: { cash?: number; installment?: number }) => {
      await setGap(s, pair);
      return await s.t.run(async (ctx) => {
        const app = (await ctx.db.get(s.applicationId))!;
        return await resolveFinancedSalePlan(ctx, app, { settlesDirect: false, currency: "JOD" });
      });
    };
    const readable = await plan({ cash: 100_000, installment: 200_000 });
    expect(readable).toBeDefined();
    for (const [, pair] of CORRUPT_PAIRS) {
      await expect(plan(pair)).rejects.toThrow(/gap contribution .* not a readable amount/);
    }
  });

  test("the economics recomputation (via classification) refuses a cancelling pair before any write", async () => {
    const s = await seed("recompute", "STOCK");
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId, name: "Recompute Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true,
        ruleVersion: 1, defaultLtvPercent: 85,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.patch(s.applicationId, {
        companyId,
        submittedQuotationMinor: 12_000_000,
        appliedLtvPercent: 85,
        customerFirstPaymentMinor: 0,
        legalInvoiceAmountMinor: 12_000_000,
        legalInvoiceNumber: "INV-1",
        legalInvoiceDate: Date.now(),
        legalInvoiceIssuedTo: "FINANCE_COMPANY",
      })
    );
    const feeId = await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId, applicationId: s.applicationId, feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: 90_000, expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "checked" });
    await setGap(s, { cash: -100_000, installment: 200_000 });
    const before = (await s.t.run((ctx) => ctx.db.get(s.applicationId)))!;

    await expect(
      s.asOwner.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: s.orgId, applicationId: s.applicationId, notes: "all on file",
      })
    ).rejects.toThrow(/gap contribution .* not a readable amount/);

    const after = (await s.t.run((ctx) => ctx.db.get(s.applicationId)))!;
    expect(after.accountingClassification).not.toBe("CLASSIFIED");
    expect(after.expectedDealerRemittanceMinor).toBe(before.expectedDealerRemittanceMinor);
    expect(after.dealerContributionMinor).toBe(before.dealerContributionMinor);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});
