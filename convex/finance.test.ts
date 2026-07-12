import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

async function setupFinanceOrg() {
  const t = convexTest(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Finance Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "finance_owner",
      email: "finance-owner@example.com",
      name: "Finance Owner",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asOwner = t.withIdentity({ subject: "finance_owner" });

  return { t, orgId, userId, asOwner };
}

async function seedVehicle(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "FINANCEVIN001",
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 12_000,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 22_000,
      status: "AVAILABLE",
    })
  );
}

describe("finance companies", () => {
  test("owner_manages_company_lifecycle_and_list_reflects_deactivation", async () => {
    const { t, orgId, userId, asOwner } = await setupFinanceOrg();
    const acceptedStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", {
        orgId,
        label: "Prime",
        isActive: true,
        order: 1,
      })
    );

    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Jordan Finance",
      profitRate: 5.25,
      maxTermMonths: 60,
      gracePeriodMonths: 1,
      insuranceRate: 1.2,
      adminFees: 150,
      commission: 250,
      includesCommissionInDebt: true,
      maxFinancingLTV: 85,
      isActive: true,
      acceptedStatuses: [acceptedStatusId],
    });

    await asOwner.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId,
      name: "Jordan Finance Updated",
      profitRate: 5.5,
      maxTermMonths: 72,
      gracePeriodMonths: 0,
      isActive: true,
      acceptedStatuses: [acceptedStatusId],
    });

    await asOwner.mutation(api.finance.deleteCompany, { id: companyId, orgId });

    const companies = await asOwner.query(api.finance.listCompanies, { orgId });
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({
      _id: companyId,
      name: "Jordan Finance Updated",
      profitRate: 5.5,
      maxTermMonths: 72,
      isActive: false,
      deactivatedBy: userId,
    });
    expect(companies[0]?.deactivatedAt).toBeTypeOf("number");
  });

  test("accepted_customer_statuses_must_belong_to_company_organization", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const otherOrgStatusId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      return await ctx.db.insert("orgCustomerStatuses", {
        orgId: otherOrgId,
        label: "External",
        isActive: true,
        order: 1,
      });
    });

    await expect(
      asOwner.mutation(api.finance.createCompany, {
        orgId,
        name: "Invalid Status Finance",
        profitRate: 4,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        isActive: true,
        acceptedStatuses: [otherOrgStatusId],
      })
    ).rejects.toThrow(/accepted customer status/i);
  });
});

describe("vehicle valuations", () => {
  test("saveValuation_upserts_per_vehicle_and_finance_company", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const vehicleId = await seedVehicle(t, orgId);
    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Valuation Bank",
      profitRate: 6,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });

    const valuationId = await asOwner.mutation(api.finance.saveValuation, {
      orgId,
      vehicleId,
      companyId,
      valuationAmount: 20_000,
      expiresAt: 1_800_000_000_000,
    });
    const updatedValuationId = await asOwner.mutation(api.finance.saveValuation, {
      orgId,
      vehicleId,
      companyId,
      valuationAmount: 21_500,
      expiresAt: 1_900_000_000_000,
    });

    expect(updatedValuationId).toBe(valuationId);

    const valuations = await asOwner.query(api.finance.listValuations, { orgId, vehicleId });
    expect(valuations).toHaveLength(1);
    expect(valuations[0]).toMatchObject({
      _id: valuationId,
      valuationAmount: 21_500,
      expiresAt: 1_900_000_000_000,
    });
  });

  test("saveValuation_rejects_vehicle_and_company_from_other_organizations", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const vehicleId = await seedVehicle(t, orgId);
    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Local Finance",
      profitRate: 6,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });
    const { otherVehicleId, otherCompanyId } = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Finance Dealer", createdAt: Date.now() });
      const otherVehicleId = await ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        vin: "FINANCEOTH001",
        make: "Honda",
        model: "Accord",
        year: 2023,
        mileage: 15_000,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 19_000,
        status: "AVAILABLE",
      });
      const otherCompanyId = await ctx.db.insert("financeCompanies", {
        orgId: otherOrgId,
        name: "External Finance",
        profitRate: 7,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        isActive: true,
      });
      return { otherVehicleId, otherCompanyId };
    });

    await expect(
      asOwner.mutation(api.finance.saveValuation, {
        orgId,
        vehicleId: otherVehicleId,
        companyId,
        valuationAmount: 18_500,
      })
    ).rejects.toThrow(/vehicle not found/i);

    await expect(
      asOwner.mutation(api.finance.saveValuation, {
        orgId,
        vehicleId,
        companyId: otherCompanyId,
        valuationAmount: 18_500,
      })
    ).rejects.toThrow(/finance company not found/i);
  });
});
