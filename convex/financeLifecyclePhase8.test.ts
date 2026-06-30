import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.*s");

async function seedFinanceLifecycleDealer(tag = "fl8") {
  const t = convexTest(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `FL-8 Dealer ${tag}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_user`,
      email: `${tag}@example.com`,
      name: `${tag} User`,
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Sales",
      permissions: ["create:sales", "view:sales"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

  return { t, orgId, userId, asUser };
}

async function seedVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  vin: string
) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2025,
      mileage: 100,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 18000,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );
}

async function seedQuote(
  t: ReturnType<typeof convexTest>,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    userId: Id<"users">;
    companyId?: Id<"financeCompanies">;
    totalFinancedAmount?: number;
    monthlyInstallment?: number;
  }
) {
  const quote = {
    orgId: args.orgId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    vehiclePrice: 22000,
    downPayment: 2000,
    termMonths: 48,
    status: "ACCEPTED" as const,
    createdBy: args.userId,
    createdAt: Date.now(),
    ...(args.companyId ? { companyId: args.companyId } : {}),
    ...(args.totalFinancedAmount !== undefined
      ? { totalFinancedAmount: args.totalFinancedAmount }
      : {}),
    ...(args.monthlyInstallment !== undefined
      ? { monthlyInstallment: args.monthlyInstallment }
      : {}),
  };

  return await t.run((ctx) => ctx.db.insert("quotes", quote));
}

describe("Finance lifecycle Phase 8 — underwriting snapshot", () => {
  test("creating an application from a quote stores customer employment and financial snapshot", async () => {
    const { t, orgId, userId, asUser } = await seedFinanceLifecycleDealer("full");

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Maya",
        lastName: "Saleh",
        employment: {
          employer: "AutoFlow Bank",
          title: "Operations Manager",
          salary: 5000,
        },
        financials: {
          totalMonthlyDebt: 700,
          dbr: 0.14,
        },
      })
    );
    const vehicleId = await seedVehicle(t, orgId, "FL8FULL001");
    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Snapshot Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("vehicleValuations", {
        orgId,
        vehicleId,
        companyId,
        valuationAmount: 20000,
      })
    );
    const quoteId = await seedQuote(t, {
      orgId,
      customerId,
      vehicleId,
      userId,
      companyId,
      totalFinancedAmount: 15000,
      monthlyInstallment: 1000,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    const application = await t.run((ctx) => ctx.db.get(applicationId));
    const snapshot = application?.underwritingSnapshot;

    expect(snapshot).toBeDefined();
    expect(snapshot?.salaryAtSubmission).toBe(5000);
    expect(snapshot?.employerAtSubmission).toBe("AutoFlow Bank");
    expect(snapshot?.jobTitleAtSubmission).toBe("Operations Manager");
    expect(snapshot?.totalMonthlyDebtAtSubmission).toBe(700);
    expect(snapshot?.proposedMonthlyInstallment).toBe(1000);
    expect(snapshot?.dbrAtSubmission).toBeCloseTo(0.34);
    expect(snapshot?.vehicleValuationAtSubmission).toBe(20000);
    expect(snapshot?.ltvAtSubmission).toBe(75);
  });

  test("customer guarantors are snapshotted at submission time", async () => {
    const { t, orgId, userId, asUser } = await seedFinanceLifecycleDealer("guarantors");

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Haddad" })
    );
    const vehicleId = await seedVehicle(t, orgId, "FL8GUAR001");
    const guarantorId = await t.run((ctx) =>
      ctx.db.insert("guarantors", {
        orgId,
        customerId,
        firstName: "Lina",
        lastName: "Haddad",
        nationalId: "G-001",
        phone: "555-0101",
        income: 2500,
        relationship: "Sister",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("guarantors", {
        orgId,
        customerId,
        firstName: "Deleted",
        lastName: "Guarantor",
        nationalId: "G-002",
        phone: "555-0102",
        isDeleted: true,
      })
    );
    const quoteId = await seedQuote(t, {
      orgId,
      customerId,
      vehicleId,
      userId,
      monthlyInstallment: 500,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });
    await t.run((ctx) => ctx.db.patch(guarantorId, { firstName: "Changed" }));

    const application = await t.run((ctx) => ctx.db.get(applicationId));
    const guarantors = application?.underwritingSnapshot?.guarantorsAtSubmission;

    expect(guarantors).toHaveLength(1);
    expect(guarantors?.[0]).toEqual({
      guarantorId,
      firstName: "Lina",
      lastName: "Haddad",
      nationalIdLastFour: "-001",
      phone: "555-0101",
      income: 2500,
      relationship: "Sister",
    });
  });

  test("snapshot is stored when salary and guarantors are missing", async () => {
    const { t, orgId, userId, asUser } = await seedFinanceLifecycleDealer("missing");

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Nour", lastName: "Khaled" })
    );
    const vehicleId = await seedVehicle(t, orgId, "FL8MISS001");
    const quoteId = await seedQuote(t, {
      orgId,
      customerId,
      vehicleId,
      userId,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    const application = await t.run((ctx) => ctx.db.get(applicationId));
    const snapshot = application?.underwritingSnapshot;

    expect(snapshot).toBeDefined();
    expect(snapshot?.salaryAtSubmission).toBeUndefined();
    expect(snapshot?.dbrAtSubmission).toBeUndefined();
    expect(snapshot?.proposedMonthlyInstallment).toBe(0);
    expect(snapshot?.guarantorsAtSubmission).toEqual([]);
  });

  test("existing applications without snapshots still load", async () => {
    const { t, orgId, userId, asUser } = await seedFinanceLifecycleDealer("legacy");

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Legacy", lastName: "Customer" })
    );
    const vehicleId = await seedVehicle(t, orgId, "FL8LEG001");
    const quoteId = await seedQuote(t, {
      orgId,
      customerId,
      vehicleId,
      userId,
      monthlyInstallment: 450,
    });
    const applicationId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId,
        quoteId,
        customerId,
        vehicleId,
        salespersonId: userId,
        status: "PENDING_DOCS",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const application = await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    });

    expect(application).not.toBeNull();
    expect(application?.underwritingSnapshot).toBeUndefined();
    expect(application?.customer?.firstName).toBe("Legacy");
  });
});
