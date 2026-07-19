import { convexTest } from "convex-test";
import { expect, test, describe, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { compareBrowseVehicles } from "./marketplaceBrowse";

describe("compareBrowseVehicles", () => {
  const car = (price: number | null, year: number, mileage: number | null) => ({ price, year, mileage });

  it("orders each direction and pushes missing values to the end", () => {
    const sort = (rows: ReturnType<typeof car>[], sortBy: Parameters<typeof compareBrowseVehicles>[2]) =>
      [...rows].sort((a, b) => compareBrowseVehicles(a, b, sortBy));

    const rows = [car(20000, 2019, 90000), car(10000, 2023, 15000), car(null, 2021, null)];

    // price_asc: cheapest first, null price last.
    expect(sort(rows, "price_asc").map((r) => r.price)).toEqual([10000, 20000, null]);
    // price_desc: dearest first, null price last.
    expect(sort(rows, "price_desc").map((r) => r.price)).toEqual([20000, 10000, null]);
    // year_desc: newest year first.
    expect(sort(rows, "year_desc").map((r) => r.year)).toEqual([2023, 2021, 2019]);
    // mileage_asc: lowest mileage first, null mileage last.
    expect(sort(rows, "mileage_asc").map((r) => r.mileage)).toEqual([15000, 90000, null]);
  });
});

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
    dealershipPhone?: string;
    whatsappNumber?: string;
    withSpecs?: boolean;
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
      dealershipPhone: opts.dealershipPhone,
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
      { sectionKey: "vehicle.transmission", enabled: opts.withSpecs === true },
      { sectionKey: "vehicle.fuelType", enabled: opts.withSpecs === true },
      { sectionKey: "vehicle.exteriorColor", enabled: opts.withSpecs === true },
    ],
  });
  await asOwner.mutation(api.websites.publish, { orgId });

  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: opts.isOptedIn ?? true,
      areas: [opts.city],
      brandsCarried: ["Toyota"],
      whatsappNumber: opts.whatsappNumber,
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

  test("sorts by the requested order (price asc default, price desc, year desc)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Cheap 2020", subdomainSlug: "cheap2020", city: "Amman", sellingPrice: 8000 });
    await seedPublishedDealer(t, { name: "Pricey 2024", subdomainSlug: "pricey2024", city: "Amman", sellingPrice: 25000 });
    await seedPublishedDealer(t, { name: "Mid 2022", subdomainSlug: "mid2022", city: "Amman", sellingPrice: 15000 });

    const asc = await t.query(api.marketplaceBrowse.search, {});
    expect(asc.vehicles.map((v) => v.price)).toEqual([8000, 15000, 25000]);

    const explicitAsc = await t.query(api.marketplaceBrowse.search, { sortBy: "price_asc" });
    expect(explicitAsc.vehicles.map((v) => v.price)).toEqual([8000, 15000, 25000]);

    const desc = await t.query(api.marketplaceBrowse.search, { sortBy: "price_desc" });
    expect(desc.vehicles.map((v) => v.price)).toEqual([25000, 15000, 8000]);
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

  test("exposes dealer phone and WhatsApp for direct contact, falling back WhatsApp to the phone", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    // Dealer with both a phone and a distinct WhatsApp number.
    await seedPublishedDealer(t, {
      name: "Both Contacts",
      subdomainSlug: "bothcontacts",
      city: "Amman",
      dealershipPhone: "+962790000001",
      whatsappNumber: "+962790000002",
    });
    // Dealer with only a phone -> WhatsApp falls back to the phone.
    await seedPublishedDealer(t, {
      name: "Phone Only",
      subdomainSlug: "phoneonly",
      city: "Amman",
      dealershipPhone: "+962790000003",
    });
    // Dealer with no contact info at all -> both null.
    await seedPublishedDealer(t, { name: "No Contact", subdomainSlug: "nocontact", city: "Amman" });

    const result = await t.query(api.marketplaceBrowse.search, {});
    const both = result.vehicles.find((v) => v.dealershipName === "Both Contacts");
    const phoneOnly = result.vehicles.find((v) => v.dealershipName === "Phone Only");
    const none = result.vehicles.find((v) => v.dealershipName === "No Contact");

    expect(both).toMatchObject({ dealerPhone: "+962790000001", dealerWhatsapp: "+962790000002" });
    expect(phoneOnly).toMatchObject({ dealerPhone: "+962790000003", dealerWhatsapp: "+962790000003" });
    expect(none).toMatchObject({ dealerPhone: null, dealerWhatsapp: null });
  });

  test("passes through spec fields (transmission/fuel/color) only when the dealer enables those sections", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedPublishedDealer(t, { name: "Specs Dealer", subdomainSlug: "specsdealer", city: "Amman", withSpecs: true });
    await seedPublishedDealer(t, { name: "No Specs Dealer", subdomainSlug: "nospecsdealer", city: "Amman" });

    const result = await t.query(api.marketplaceBrowse.search, {});
    const withSpecs = result.vehicles.find((v) => v.dealershipName === "Specs Dealer");
    const withoutSpecs = result.vehicles.find((v) => v.dealershipName === "No Specs Dealer");

    expect(withSpecs).toMatchObject({ transmission: "Automatic", fuelType: "Petrol", exteriorColor: "White" });
    expect(withoutSpecs).toMatchObject({ transmission: null, fuelType: null, exteriorColor: null });
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
