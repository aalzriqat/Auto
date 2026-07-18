import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { computeAffordabilityRange } from "./marketplaceAffordability";

const WEBSITE_PERMS = ["website.view", "website.manage", "website.publish", "view:settings"];

function terms(profitRate: number, overrides: Partial<{ maxTermMonths: number; insuranceRate: number; adminFees: number; commission: number }> = {}) {
  return {
    profitRate,
    maxTermMonths: overrides.maxTermMonths ?? 60,
    gracePeriodMonths: 0,
    insuranceRate: overrides.insuranceRate ?? 3,
    adminFees: overrides.adminFees ?? 150,
    commission: overrides.commission ?? 300,
  };
}

describe("computeAffordabilityRange (pure)", () => {
  const inputs = { maximumMonthlyPayment: 400, downPayment: 3000, termMonths: 60 };

  test("returns a spread across finance companies — lower profit rate affords more car", () => {
    const range = computeAffordabilityRange([terms(4), terms(12)], inputs);
    expect(range).not.toBeNull();
    expect(range!.companiesConsidered).toBe(2);
    expect(range!.minPriceJod).toBeGreaterThan(0);
    expect(range!.maxPriceJod).toBeGreaterThan(range!.minPriceJod);
    // The cheaper-rate company defines the top of the affordable range.
    const cheap = computeAffordabilityRange([terms(4)], inputs)!;
    expect(range!.maxPriceJod).toBe(cheap.maxPriceJod);
  });

  test("counts a finance company shared by two dealers only once", () => {
    const range = computeAffordabilityRange([terms(6), terms(6)], inputs);
    expect(range!.companiesConsidered).toBe(1);
    expect(range!.minPriceJod).toBe(range!.maxPriceJod);
  });

  test("caps each company's term at its own maxTermMonths", () => {
    const range = computeAffordabilityRange([terms(6, { maxTermMonths: 24 })], { ...inputs, termMonths: 72 });
    expect(range).not.toBeNull();
    expect(range!.maxPriceJod).toBeGreaterThan(0);
  });

  test("returns null when no finance terms are available", () => {
    expect(computeAffordabilityRange([], inputs)).toBeNull();
  });

  test("returns null for a non-positive monthly ceiling or bad term", () => {
    expect(computeAffordabilityRange([terms(6)], { ...inputs, maximumMonthlyPayment: 0 })).toBeNull();
    expect(computeAffordabilityRange([terms(6)], { ...inputs, termMonths: 0 })).toBeNull();
    expect(computeAffordabilityRange([terms(6)], { ...inputs, downPayment: -1 })).toBeNull();
  });

  test("drops companies that can't finance anything at the given budget", () => {
    // A monthly ceiling below the insurance/fee floor buys 0 car everywhere → null.
    expect(computeAffordabilityRange([terms(6)], { maximumMonthlyPayment: 1, downPayment: 0, termMonths: 60 })).toBeNull();
  });
});

describe("getAffordabilityRange (query)", () => {
  async function seedFinanceDealer(
    t: ReturnType<typeof convexTest>,
    opts: { name: string; subdomainSlug: string; profitRate: number }
  ) {
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: opts.name, createdAt: Date.now() }));
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId, plan: "enterprise", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" }));
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: WEBSITE_PERMS }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "د.أ", enabledPaymentTypes: ["CASH"], dealershipName: opts.name })
    );
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, make: "Toyota", model: "Corolla", year: 2021, mileage: 30000, color: "White",
        fuelType: "Petrol", transmission: "Automatic", sellingPrice: 18000, status: "AVAILABLE", isDeleted: false,
      })
    );
    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", { orgId, name: "Test Finance", profitRate: opts.profitRate, maxTermMonths: 60, gracePeriodMonths: 0, insuranceRate: 3, adminFees: 150, commission: 300, isActive: true })
    );
    const asOwner = t.withIdentity({ subject: `owner_${orgId}` });
    await asOwner.mutation(api.websites.startSetup, { orgId });
    await asOwner.mutation(api.websites.saveDraft, {
      orgId,
      subdomainSlug: opts.subdomainSlug,
      activeFinanceCompanyId: financeCompanyId,
      sections: [
        { sectionKey: "vehicle.price", enabled: true },
        { sectionKey: "vehicle.photos", enabled: true },
      ],
    });
    await asOwner.mutation(api.websites.publish, { orgId });
    await t.run((ctx) =>
      ctx.db.insert("marketplaceDealerProfiles", {
        orgId, isOptedIn: true, areas: ["Amman"], brandsCarried: ["Toyota"], badges: [],
        totalResponses: 0, totalAccepted: 0, tier: "FREE_FOUNDING", leadsUsedThisPeriod: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    return { orgId };
  }

  test("returns a real range across two opted-in dealers with different finance rates", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedFinanceDealer(t, { name: "Amman Motors", subdomainSlug: "afford1", profitRate: 4 });
    await seedFinanceDealer(t, { name: "Petra Cars", subdomainSlug: "afford2", profitRate: 12 });

    const range = await t.query(api.marketplaceAffordability.getAffordabilityRange, {
      maximumMonthlyPayment: 400,
      downPayment: 3000,
      termMonths: 60,
    });
    expect(range).not.toBeNull();
    expect(range!.companiesConsidered).toBe(2);
    expect(range!.maxPriceJod).toBeGreaterThan(range!.minPriceJod);
  });

  test("returns null when no opted-in dealers publish finance terms", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const range = await t.query(api.marketplaceAffordability.getAffordabilityRange, {
      maximumMonthlyPayment: 400,
    });
    expect(range).toBeNull();
  });

  test("returns null for a non-positive monthly ceiling without scanning", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedFinanceDealer(t, { name: "Amman Motors", subdomainSlug: "afford3", profitRate: 5 });
    const range = await t.query(api.marketplaceAffordability.getAffordabilityRange, { maximumMonthlyPayment: 0 });
    expect(range).toBeNull();
  });
});
