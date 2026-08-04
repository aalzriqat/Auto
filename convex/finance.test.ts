import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

async function setupFinanceOrg() {
  const t = convexTestWithComponents(schema, MODULES);
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

/**
 * Adds a member whose role carries exactly the permissions of a default role
 * template, so these tests track the real templates rather than a hand-picked
 * permission list that could drift away from them.
 */
async function addMemberWithTemplateRole(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  templateName: string,
  clerkId: string
) {
  const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === templateName);
  if (!template) throw new Error(`No default role template named ${templateName}`);

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@example.com`,
      name: templateName,
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: templateName, permissions: [...template.permissions] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return t.withIdentity({ subject: clerkId });
}

async function seedVehicle(t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">) {
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

  test("deleting_a_customer_status_clears_it_from_finance_companies", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const keptStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId, label: "Salary Slip", isActive: true, order: 1 })
    );
    const doomedStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId, label: "Delivery Apps", isActive: true, order: 2 })
    );

    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Cascade Finance",
      profitRate: 4,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      isActive: true,
      acceptedStatuses: [keptStatusId, doomedStatusId],
    });

    await asOwner.mutation(api.orgCustomerStatuses.remove, { orgId, statusId: doomedStatusId });

    // The reference has to go with the row. Leaving it behind is what stranded
    // the company: an id pointing at nothing, invisible in the edit dialog.
    const company = await t.run((ctx) => ctx.db.get(companyId));
    expect(company?.acceptedStatuses).toEqual([keptStatusId]);
  });

  test("a_company_holding_a_deleted_status_id_can_still_be_saved", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const liveStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId, label: "ID Only", isActive: true, order: 1 })
    );

    // Reproduces the shipped state: a company whose acceptedStatuses names a
    // status row that no longer exists, written before deletes cascaded.
    const staleStatusId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("orgCustomerStatuses", {
        orgId,
        label: "Removed",
        isActive: true,
        order: 2,
      });
      await ctx.db.delete(id);
      return id;
    });

    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Stranded Finance",
        profitRate: 4,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        isActive: true,
        acceptedStatuses: [liveStatusId, staleStatusId],
      })
    );

    // Before the fix this threw "Accepted customer status not found in this
    // organization." and the record could never be edited again — the dialog
    // re-sent the dangling id on every save and offered no way to remove it.
    await asOwner.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId,
      name: "Stranded Finance Renamed",
      profitRate: 4.5,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      isActive: true,
      acceptedStatuses: [liveStatusId, staleStatusId],
    });

    const company = await t.run((ctx) => ctx.db.get(companyId));
    expect(company?.name).toBe("Stranded Finance Renamed");
    // Saving heals the row rather than persisting the ghost.
    expect(company?.acceptedStatuses).toEqual([liveStatusId]);
  });

  test("omitting_accepted_statuses_on_update_preserves_the_existing_restriction", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const statusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId, label: "Salary Slip", isActive: true, order: 1 })
    );

    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Restricted Finance",
      profitRate: 4,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      isActive: true,
      acceptedStatuses: [statusId],
    });

    // The argument is optional. Convex deletes a field patched to `undefined`,
    // so writing it unconditionally would erase the restriction and silently
    // widen the company to "accepts every customer".
    await asOwner.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId,
      name: "Restricted Finance Renamed",
      profitRate: 4,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      isActive: true,
    });

    const company = await t.run((ctx) => ctx.db.get(companyId));
    expect(company?.name).toBe("Restricted Finance Renamed");
    expect(company?.acceptedStatuses).toEqual([statusId]);
  });

  test("cleanup_migration_strips_dangling_accepted_statuses", async () => {
    const { t, orgId } = await setupFinanceOrg();
    const liveStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId, label: "Salary Slip", isActive: true, order: 1 })
    );
    const staleStatusId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("orgCustomerStatuses", {
        orgId,
        label: "Gone",
        isActive: true,
        order: 2,
      });
      await ctx.db.delete(id);
      return id;
    });

    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Quietly Broken Finance",
        profitRate: 4,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        isActive: true,
        acceptedStatuses: [liveStatusId, staleStatusId],
      })
    );

    const dry = await t.mutation(internal.migrations.cleanupDanglingAcceptedStatuses, { orgId });
    expect(dry.dryRun).toBe(true);
    expect(dry.isDone).toBe(true);
    expect(dry.continueCursor).toBeNull();
    expect(dry.repaired).toEqual([
      { companyId, name: "Quietly Broken Finance", removed: 1, remaining: 1 },
    ]);
    // A dry run changes nothing.
    expect((await t.run((ctx) => ctx.db.get(companyId)))?.acceptedStatuses).toHaveLength(2);

    await t.mutation(internal.migrations.cleanupDanglingAcceptedStatuses, { orgId, dryRun: false });
    expect((await t.run((ctx) => ctx.db.get(companyId)))?.acceptedStatuses).toEqual([liveStatusId]);
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

  test("sales_updates_a_valuation_directly_without_an_approval_request", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const vehicleId = await seedVehicle(t, orgId);
    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Sales-Facing Finance",
      profitRate: 6,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });

    const asSales = await addMemberWithTemplateRole(t, orgId, "SALES", "finance_sales");

    const valuationId = await asSales.mutation(api.finance.saveValuation, {
      orgId,
      vehicleId,
      companyId,
      valuationAmount: 19_750,
    });

    // The valuation is live immediately...
    const valuations = await asSales.query(api.finance.listValuations, { orgId, vehicleId });
    expect(valuations).toHaveLength(1);
    expect(valuations[0]).toMatchObject({ _id: valuationId, valuationAmount: 19_750 });

    // ...and crucially, no vehicle-edit approval request was created for it.
    const pendingEdits = await t.run((ctx) => ctx.db.query("vehicleEdits").collect());
    expect(pendingEdits).toHaveLength(0);
  });

  test("saveValuation_rejects_a_role_without_edit_vehicle_valuations", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const vehicleId = await seedVehicle(t, orgId);
    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "Reception Blocked Finance",
      profitRate: 6,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });

    // RECEPTION holds neither the view nor the edit valuation permission.
    const asReception = await addMemberWithTemplateRole(t, orgId, "RECEPTION", "finance_reception");

    await expect(
      asReception.mutation(api.finance.saveValuation, {
        orgId,
        vehicleId,
        companyId,
        valuationAmount: 19_750,
      })
    ).rejects.toThrow(/edit:vehicle_valuations/);
  });

  test("saveValuation_rejects_non_finite_amounts", async () => {
    const { t, orgId, asOwner } = await setupFinanceOrg();
    const vehicleId = await seedVehicle(t, orgId);
    const companyId = await asOwner.mutation(api.finance.createCompany, {
      orgId,
      name: "NaN Finance",
      profitRate: 6,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });

    // v.number() lets NaN/Infinity through, and NaN defeats `< 0` checks.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(
        asOwner.mutation(api.finance.saveValuation, {
          orgId,
          vehicleId,
          companyId,
          valuationAmount: bad,
        })
      ).rejects.toThrow(/non-negative number/i);
    }

    const valuations = await asOwner.query(api.finance.listValuations, { orgId, vehicleId });
    expect(valuations).toHaveLength(0);
  });
});
