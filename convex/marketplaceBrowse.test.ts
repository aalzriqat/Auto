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
  opts: { name: string; subdomainSlug: string; city: string; withFinance?: boolean; isOptedIn?: boolean }
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
      sellingPrice: 14000,
      status: "AVAILABLE",
      isDeleted: false,
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
      { sectionKey: "vehicle.price", enabled: true },
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
});
