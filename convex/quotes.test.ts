import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = ["view:sales", "view:customers", "view:vehicles", "create:leads", "view:leads"];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_q1", email: "q@test.com", name: "Quote User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_q1", clerkId: "user_q1" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A444444",
      make: "Hyundai",
      model: "Tucson",
      year: 2022,
      color: "Gray",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 8000,
      sellingPrice: 19000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser" })
  );

  return { t, orgId, customerId, vehicleId, asUser };
}

describe("quotes.get", () => {
  test("returns the quote when the org matches", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    const quote = await asUser.query(api.quotes.get, { orgId, quoteId });
    expect(quote?._id).toBe(quoteId);
    expect(quote?.vehiclePrice).toBe(19000);
  });

  test("throws for a quote belonging to a different org", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );

    await expect(
      asUser.query(api.quotes.get, { orgId: orgId2, quoteId })
    ).rejects.toThrow();
  });
});

describe("configured finance valuation ceiling", () => {
  async function setupConfiguredQuote() {
    const seed = await setup();
    const customerStatusId = await seed.t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", {
        orgId: seed.orgId,
        label: "Eligible",
        isActive: true,
        order: 1,
      })
    );
    const companyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Valuation Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        adminFees: 0,
        maxFinancingLTV: 85,
        isActive: true,
        acceptedStatuses: [customerStatusId],
        ruleVersion: 1,
        editRevision: 1,
      })
    );
    return { ...seed, customerStatusId, companyId };
  }

  test("NEGATIVE CONTROL: refuses configured financing above the lender valuation ceiling", async () => {
    const seed = await setupConfiguredQuote();
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleValuations", {
        orgId: seed.orgId,
        vehicleId: seed.vehicleId,
        companyId: seed.companyId,
        valuationAmount: 20_000,
      })
    );

    await expect(
      seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId: seed.vehicleId,
        companyId: seed.companyId,
        customerEligibilityStatusIds: [seed.customerStatusId],
        mode: "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: 19_000,
        downPayment: 1_000,
        termMonths: 48,
      })
    ).rejects.toThrow(/financing limit|down payment/i);
  });

  test("accepts configured financing exactly at the lender valuation ceiling", async () => {
    const seed = await setupConfiguredQuote();
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleValuations", {
        orgId: seed.orgId,
        vehicleId: seed.vehicleId,
        companyId: seed.companyId,
        valuationAmount: 20_000,
      })
    );

    await expect(
      seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId: seed.vehicleId,
        companyId: seed.companyId,
        customerEligibilityStatusIds: [seed.customerStatusId],
        mode: "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: 19_000,
        downPayment: 2_000,
        termMonths: 48,
      })
    ).resolves.toBeDefined();
  });

  test("does not invent a valuation ceiling when the lender has not valued the vehicle", async () => {
    const seed = await setupConfiguredQuote();

    await expect(
      seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId: seed.vehicleId,
        companyId: seed.companyId,
        customerEligibilityStatusIds: [seed.customerStatusId],
        mode: "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: 19_000,
        downPayment: 1_000,
        termMonths: 48,
      })
    ).resolves.toBeDefined();
  });
});

describe("quotes.updateQuoteStatus lead stage advance", () => {
  test("marking a quote SHARED advances its linked lead to NEGOTIATION", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      leadId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    await asUser.mutation(api.quotes.updateQuoteStatus, { orgId, quoteId, status: "SHARED" });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("NEGOTIATION");
    });
  });

  test("no-ops when the quote has no linked lead", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    await expect(
      asUser.mutation(api.quotes.updateQuoteStatus, { orgId, quoteId, status: "SHARED" })
    ).resolves.not.toThrow();
  });

  test("does not move a lead backward when it's already past NEGOTIATION", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });
    await t.run((ctx) => ctx.db.patch(leadId, { stage: "RESERVED" }));

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      leadId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    await asUser.mutation(api.quotes.updateQuoteStatus, { orgId, quoteId, status: "SHARED" });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("RESERVED");
    });
  });
});

describe("financed quote single-vehicle authority", () => {
  test("NEGATIVE CONTROL: rejects vehicleItems before financed quote normalization", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const secondVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A555555",
        make: "Toyota",
        model: "Corolla",
        year: 2021,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 12000,
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );

    await expect(
      asUser.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehicleItems: [
          { vehicleId, unitPrice: 19_000 },
          { vehicleId: secondVehicleId, unitPrice: 15_000 },
        ],
        mode: "MANUAL_FINANCE_COMPANY",
        vehiclePrice: 34_000,
        desiredProfit: 1_000,
        downPayment: 5_000,
        termMonths: 48,
        manualAdminFees: 0,
        manualProfitRate: 5,
      })
    ).rejects.toThrow(/exactly one vehicle/i);
  });
});
