import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const WEBSITE_PERMISSIONS = [
  "website.view",
  "website.manage",
  "website.publish",
  "website.domain.manage",
  "website.leads.manage",
  "view:settings",
];

async function seedPublishedDealer(
  t: ReturnType<typeof convexTest>,
  opts: {
    name: string;
    subdomainSlug: string;
    city: string;
    withFinance?: boolean;
    isOptedIn?: boolean;
    hidePrices?: boolean;
    sellingPrice?: number;
    financeTerms?: { insuranceRate?: number; adminFees?: number; commission?: number };
    trust?: {
      inspectionStatus?: "SELF_REPORTED" | "PARTNER_VERIFIED";
      accidentDisclosed?: boolean;
      ownerCount?: number;
      dealerGuarantee?: boolean;
    };
  }
) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: opts.name, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "enterprise", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: WEBSITE_PERMISSIONS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "د.أ",
      enabledPaymentTypes: ["CASH"],
      dealershipName: opts.name,
    })
  );

  await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2021,
      mileage: 30000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: opts.sellingPrice ?? 14000,
      status: "AVAILABLE",
      isDeleted: false,
      inspectionStatus: opts.trust?.inspectionStatus,
      accidentDisclosed: opts.trust?.accidentDisclosed,
      ownerCount: opts.trust?.ownerCount,
      dealerGuarantee: opts.trust?.dealerGuarantee,
    })
  );

  let activeFinanceCompanyId: Id<"financeCompanies"> | undefined;
  if (opts.withFinance) {
    activeFinanceCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Test Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        insuranceRate: opts.financeTerms?.insuranceRate,
        adminFees: opts.financeTerms?.adminFees,
        commission: opts.financeTerms?.commission,
        isActive: true,
      })
    );
  }

  const asOwner = t.withIdentity({ subject: `owner_${orgId}` });
  await asOwner.mutation(api.websites.startSetup, { orgId });
  await asOwner.mutation(api.websites.saveDraft, {
    orgId,
    subdomainSlug: opts.subdomainSlug,
    activeFinanceCompanyId,
    sections: [
      { sectionKey: "vehicle.price", enabled: !opts.hidePrices },
      { sectionKey: "vehicle.photos", enabled: true },
    ],
  });
  await asOwner.mutation(api.websites.publish, { orgId });

  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: opts.isOptedIn ?? true,
      areas: [opts.city],
      brandsCarried: ["Toyota"],
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );

  return { orgId };
}

describe("marketplaceBrowse.search", () => {
  test("unions vehicles from multiple opted-in dealers and excludes non-opted-in ones", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Amman Motors", subdomainSlug: "ammanmotors", city: "Amman" });
    await seedPublishedDealer(t, { name: "Zarqa Autos", subdomainSlug: "zarqaautos", city: "Zarqa" });
    await seedPublishedDealer(t, { name: "Hidden Dealer", subdomainSlug: "hiddendealer", city: "Amman", isOptedIn: false });

    const result = await t.query(api.marketplaceBrowse.search, {});
    expect(result.vehicles).toHaveLength(2);
    const dealerships = result.vehicles.map((v) => v.dealershipName).sort();
    expect(dealerships).toEqual(["Amman Motors", "Zarqa Autos"]);
  });

  test("filters by city using the dealer's declared areas", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Amman Motors", subdomainSlug: "ammanmotors2", city: "Amman" });
    await seedPublishedDealer(t, { name: "Zarqa Autos", subdomainSlug: "zarqaautos2", city: "Zarqa" });

    const result = await t.query(api.marketplaceBrowse.search, { city: "amman" });
    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0].dealershipName).toBe("Amman Motors");
  });

  test("filters by price range and payment type", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Cash Only Dealer", subdomainSlug: "cashonly", city: "Amman", withFinance: false });
    await seedPublishedDealer(t, { name: "Finance Dealer", subdomainSlug: "financedealer", city: "Amman", withFinance: true });

    const financeOnly = await t.query(api.marketplaceBrowse.search, { paymentType: "FINANCE" });
    expect(financeOnly.vehicles).toHaveLength(1);
    expect(financeOnly.vehicles[0].dealershipName).toBe("Finance Dealer");
    expect(financeOnly.vehicles[0].financeAvailable).toBe(true);

    const tooExpensive = await t.query(api.marketplaceBrowse.search, { priceMin: 20000 });
    expect(tooExpensive.vehicles).toHaveLength(0);
  });

  test("paginates via cursor", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Dealer A", subdomainSlug: "dealera", city: "Amman" });
    await seedPublishedDealer(t, { name: "Dealer B", subdomainSlug: "dealerb", city: "Amman" });

    const firstPage = await t.query(api.marketplaceBrowse.search, { numItems: 1 });
    expect(firstPage.vehicles).toHaveLength(1);
    expect(firstPage.isDone).toBe(false);
    expect(firstPage.continueCursor).not.toBeNull();

    const secondPage = await t.query(api.marketplaceBrowse.search, { numItems: 1, cursor: firstPage.continueCursor! });
    expect(secondPage.vehicles).toHaveLength(1);
    expect(secondPage.isDone).toBe(true);
    expect(secondPage.vehicles[0].orgId).not.toBe(firstPage.vehicles[0].orgId);
  });

  test("passes through trust-passport fields when disclosed, and safe defaults when not (Phase 61)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, {
      name: "Disclosed Dealer",
      subdomainSlug: "discloseddealer",
      city: "Amman",
      trust: { inspectionStatus: "SELF_REPORTED", accidentDisclosed: false, ownerCount: 1, dealerGuarantee: true },
    });
    await seedPublishedDealer(t, { name: "Undisclosed Dealer", subdomainSlug: "undiscloseddealer", city: "Amman" });

    const result = await t.query(api.marketplaceBrowse.search, {});
    const disclosed = result.vehicles.find((v) => v.dealershipName === "Disclosed Dealer");
    const undisclosed = result.vehicles.find((v) => v.dealershipName === "Undisclosed Dealer");

    expect(disclosed).toMatchObject({
      inspectionStatus: "SELF_REPORTED",
      accidentDisclosed: false,
      ownerCount: 1,
      dealerGuarantee: true,
    });
    expect(undisclosed).toMatchObject({
      inspectionStatus: "NONE",
      accidentDisclosed: null,
      ownerCount: null,
      dealerGuarantee: null,
    });
  });

  test("estimates the monthly payment using the same math as lib/financing.ts, and filters by it (Phase 62)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, {
      name: "Finance Dealer",
      subdomainSlug: "financedealer2",
      city: "Amman",
      withFinance: true,
      sellingPrice: 10000,
      financeTerms: { insuranceRate: 1.5, adminFees: 50, commission: 100 },
    });

    const result = await t.query(api.marketplaceBrowse.search, {});
    // Matches lib/financing.test.ts's "standard loan" case: 10000 price, 20%
    // (2000) down, 5% profit, 1.5% insurance, 50 fees, 100 commission, 60mo
    // -> totalContractValue 10951.5625 / 60 = 182.526..., rounded to 183.
    expect(result.vehicles[0].estimatedMonthlyPayment).toBe(183);

    const withinBudget = await t.query(api.marketplaceBrowse.search, { maxMonthlyPayment: 183 });
    expect(withinBudget.vehicles).toHaveLength(1);

    const tooTight = await t.query(api.marketplaceBrowse.search, { maxMonthlyPayment: 182 });
    expect(tooTight.vehicles).toHaveLength(0);
  });

  test("excludes cash-only dealers when a max monthly payment filter is applied (no estimate possible)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Cash Only", subdomainSlug: "cashonly2", city: "Amman", withFinance: false });

    const result = await t.query(api.marketplaceBrowse.search, { maxMonthlyPayment: 1000 });
    expect(result.vehicles).toHaveLength(0);
  });

  test("still estimates the monthly payment from financePrice when the dealer hides public prices", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, {
      name: "Hidden Price Dealer",
      subdomainSlug: "hiddenpricedealer",
      city: "Amman",
      withFinance: true,
      hidePrices: true,
      sellingPrice: 10000,
      financeTerms: { insuranceRate: 1.5, adminFees: 50, commission: 100 },
    });

    const result = await t.query(api.marketplaceBrowse.search, { maxMonthlyPayment: 183 });
    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0].price).toBeNull();
    expect(result.vehicles[0].estimatedMonthlyPayment).toBe(183);
  });
});
