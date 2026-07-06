import { convexTest, TestConvex as ConvexTestInstance } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

interface SetupResult {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  approverId: Id<"users">;
  customerId: Id<"customers">;
  vehicleId: Id<"vehicles">;
  companyId: Id<"financeCompanies">;
  asUser: AuthenticatedTestConvex;
  asApprover: AuthenticatedTestConvex;
}

async function seedFinanceLifecycleDealer(): Promise<SetupResult> {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "FL-1 Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "fl1_user", email: "fl1@example.com", name: "FL1 User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "fl1_approver",
      email: "fl1.approver@example.com",
      name: "FL1 Approver",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Lifecycle",
      permissions: [
        "view:sales",
        "create:sales",
        "approve:requests",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "view:customers",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "fl1_user", clerkId: "fl1_user" });
  const asApprover = t.withIdentity({ subject: "fl1_approver", clerkId: "fl1_approver" });

  const vehicleId = await createVehicle(t, orgId, "FL1VIN001");
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Finance", lastName: "Lifecycle" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Configured Finance Co",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, companyId, asUser, asApprover };
}

async function createVehicle(
  t: TestConvex,
  orgId: Id<"organizations">,
  vin: string
): Promise<Id<"vehicles">> {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 24000,
      sellingPrice: 31000,
      status: "AVAILABLE",
    })
  );
}

async function finalizeQuote(
  asUser: AuthenticatedTestConvex,
  asApprover: AuthenticatedTestConvex,
  orgId: Id<"organizations">,
  quoteId: Id<"quotes">
): Promise<Id<"sales">> {
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "CASH",
    expectedDate: Date.now(),
  });
  return await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });
}

describe("Finance lifecycle phase 1 quote mode", () => {
  test("createQuote with mode=CASH does not require companyId", async () => {
    const { orgId, customerId, vehicleId, asUser } = await seedFinanceLifecycleDealer();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      mode: "CASH",
      vehiclePrice: 31000,
      downPayment: 31000,
      termMonths: 0,
    });

    const quote = await asUser.query(api.quotes.get, { orgId, quoteId });
    expect(quote.mode).toBe("CASH");
    expect(quote.companyId).toBeUndefined();
  });

  test("createQuote with mode=CONFIGURED_FINANCE_COMPANY requires companyId", async () => {
    const { orgId, customerId, vehicleId, companyId, asUser } = await seedFinanceLifecycleDealer();

    await expect(
      asUser.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        mode: "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: 31000,
        downPayment: 5000,
        termMonths: 48,
      })
    ).rejects.toThrow(/finance company/i);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      companyId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      vehiclePrice: 31000,
      downPayment: 5000,
      termMonths: 48,
    });

    const quote = await asUser.query(api.quotes.get, { orgId, quoteId });
    expect(quote.mode).toBe("CONFIGURED_FINANCE_COMPANY");
    expect(quote.companyId).toBe(companyId);
  });

  test("createQuote with mode=MANUAL_FINANCE_COMPANY persists manual finance fields", async () => {
    const { orgId, customerId, vehicleId, asUser } = await seedFinanceLifecycleDealer();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Manual Bank",
      manualProfitRate: 6.25,
      manualInsuranceRate: 2.5,
      manualAdminFees: 150,
      manualCommission: 300,
      manualIncludesCommissionInDebt: true,
      vehiclePrice: 31000,
      downPayment: 7000,
      termMonths: 48,
      totalFinancedAmount: 24000,
    });

    const quote = await asUser.query(api.quotes.get, { orgId, quoteId });
    expect(quote.mode).toBe("MANUAL_FINANCE_COMPANY");
    expect(quote.manualProviderName).toBe("Manual Bank");
    expect(quote.manualProfitRate).toBe(6.25);
    expect(quote.manualInsuranceRate).toBe(2.5);
    expect(quote.manualAdminFees).toBe(150);
    expect(quote.manualCommission).toBe(300);
    expect(quote.manualIncludesCommissionInDebt).toBe(true);
  });

  test("finalizeDeal on a MANUAL_FINANCE_COMPANY quote sets financingType=FINANCED", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await seedFinanceLifecycleDealer();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Manual Bank",
      manualProfitRate: 6.25,
      manualInsuranceRate: 2.5,
      manualAdminFees: 150,
      manualCommission: 300,
      manualIncludesCommissionInDebt: false,
      vehiclePrice: 31000,
      downPayment: 7000,
      termMonths: 48,
      totalFinancedAmount: 24000,
      monthlyInstallment: 610,
      totalProfit: 5280,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    await t.run(async (ctx) => {
      const application = await ctx.db.get(applicationId);
      expect(application?.quoteModeAtSubmission).toBe("MANUAL_FINANCE_COMPANY");
      expect(application?.manualFinanceSnapshot).toMatchObject({
        providerName: "Manual Bank",
        profitRate: 6.25,
        insuranceRate: 2.5,
        adminFees: 150,
        commission: 300,
        includesCommissionInDebt: false,
        totalFinancedAmount: 24000,
        monthlyInstallment: 610,
        totalProfit: 5280,
      });

      const sale = await ctx.db.query("sales").withIndex("by_quote", (q) => q.eq("quoteId", quoteId)).first();
      expect(sale?.financingType).toBe("FINANCED");
    });
  });

  test("finalizeDeal on a CASH quote sets financingType=CASH", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await seedFinanceLifecycleDealer();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      mode: "CASH",
      vehiclePrice: 31000,
      downPayment: 31000,
      termMonths: 0,
    });

    await finalizeQuote(asUser, asApprover, orgId, quoteId);

    await t.run(async (ctx) => {
      const sale = await ctx.db.query("sales").withIndex("by_quote", (q) => q.eq("quoteId", quoteId)).first();
      expect(sale?.financingType).toBe("CASH");
    });
  });

  test("existing quote without mode field still finalizes with legacy financing behavior", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser, asApprover } = await seedFinanceLifecycleDealer();
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 31000,
        downPayment: 5000,
        termMonths: 36,
        totalFinancedAmount: 26000,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    await finalizeQuote(asUser, asApprover, orgId, quoteId);

    await t.run(async (ctx) => {
      const sale = await ctx.db.query("sales").withIndex("by_quote", (q) => q.eq("quoteId", quoteId)).first();
      expect(sale?.financingType).toBe("CASH");
    });
  });
});
