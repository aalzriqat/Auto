import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type FinanceApplicationStatus =
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "CLOSED";

const FINANCE_LIFECYCLE_PERMISSIONS = {
  VIEW: "view:finance_applications",
  CREATE: "create:finance_application",
  REVIEW: "review:finance_application",
  APPROVE: "approve:finance_application",
  FINALIZE: "finalize:financed_deal",
  CONFIRM_DISBURSEMENT: "confirm:finance_disbursement",
  REGISTER_HANDOVER: "register:vehicle_handover",
  REGISTER_EXPECTED_PAYMENT: "register:expected_payment",
} as const;

let applicationSeedCounter = 0;

async function seedFinanceLifecycleDealer(tag = "fl4") {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Finance Lifecycle ${tag}`, createdAt: Date.now() })
  );

  const salespersonId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_sales`,
      email: `${tag}.sales@example.com`,
      name: "Sales User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_approver`,
      email: `${tag}.approver@example.com`,
      name: "Approver User",
    })
  );
  const limitedUserId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_limited`,
      email: `${tag}.limited@example.com`,
      name: "Limited User",
    })
  );
  const finalizerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_finalizer`,
      email: `${tag}.finalizer@example.com`,
      name: "Finalizer User",
    })
  );
  const accountantId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_accountant`,
      email: `${tag}.accountant@example.com`,
      name: "Accountant User",
    })
  );

  const salesRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Sales",
      permissions: [
        FINANCE_LIFECYCLE_PERMISSIONS.VIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.CREATE,
        FINANCE_LIFECYCLE_PERMISSIONS.REVIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.APPROVE,
      ],
    })
  );
  const approverRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Approver",
      permissions: [
        FINANCE_LIFECYCLE_PERMISSIONS.VIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.REVIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.APPROVE,
      ],
    })
  );
  const limitedRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Limited",
      permissions: [FINANCE_LIFECYCLE_PERMISSIONS.VIEW],
    })
  );
  const finalizerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finalizer",
      permissions: [
        FINANCE_LIFECYCLE_PERMISSIONS.VIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.FINALIZE,
        FINANCE_LIFECYCLE_PERMISSIONS.REGISTER_HANDOVER,
        FINANCE_LIFECYCLE_PERMISSIONS.REGISTER_EXPECTED_PAYMENT,
      ],
    })
  );
  const accountantRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Accountant",
      permissions: [
        FINANCE_LIFECYCLE_PERMISSIONS.VIEW,
        FINANCE_LIFECYCLE_PERMISSIONS.CONFIRM_DISBURSEMENT,
      ],
    })
  );

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salespersonId, roleId: salesRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: limitedUserId, roleId: limitedRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: finalizerId, roleId: finalizerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: accountantId, roleId: accountantRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Finance", lastName: "Customer" })
  );

  return {
    t,
    orgId,
    salespersonId,
    customerId,
    asSalesperson: t.withIdentity({ subject: `${tag}_sales`, clerkId: `${tag}_sales` }),
    asApprover: t.withIdentity({ subject: `${tag}_approver`, clerkId: `${tag}_approver` }),
    asLimitedUser: t.withIdentity({ subject: `${tag}_limited`, clerkId: `${tag}_limited` }),
    asFinalizer: t.withIdentity({ subject: `${tag}_finalizer`, clerkId: `${tag}_finalizer` }),
    asAccountant: t.withIdentity({ subject: `${tag}_accountant`, clerkId: `${tag}_accountant` }),
  };
}

async function seedFinanceApplication(
  t: ReturnType<typeof convexTest>,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    salespersonId: Id<"users">;
    status: FinanceApplicationStatus;
    withFinanceCompany?: boolean;
  }
) {
  const now = Date.now();
  const uniqueSuffix = `${now}-${applicationSeedCounter++}`;
  const financeCompanyId = args.withFinanceCompany
    ? await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: args.orgId,
        name: "Lifecycle Bank",
        isActive: true,
        profitRate: 5.5,
        maxTermMonths: 72,
        gracePeriodMonths: 3,
      })
    )
    : undefined;
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: args.orgId,
      vin: `FL4-${uniqueSuffix}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 0,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 15000,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: args.orgId,
      customerId: args.customerId,
      vehicleId,
      companyId: financeCompanyId,
      vehiclePrice: 22000,
      downPayment: 2000,
      termMonths: 36,
      totalFinancedAmount: 20000,
      status: "DRAFT",
      createdBy: args.salespersonId,
      createdAt: now,
    })
  );
  const applicationId = await t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId,
      customerId: args.customerId,
      vehicleId,
      companyId: financeCompanyId,
      salespersonId: args.salespersonId,
      status: args.status,
      createdAt: now,
      updatedAt: now,
    })
  );

  return { applicationId, quoteId, vehicleId, financeCompanyId };
}

describe("Finance lifecycle Phase 4", () => {
  test("valid state transitions succeed", async () => {
    const { t, orgId, salespersonId, customerId, asSalesperson, asApprover } =
      await seedFinanceLifecycleDealer("valid");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "DRAFT",
    });

    await asSalesperson.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "PENDING_DOCS",
    });
    await asSalesperson.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });
    await asApprover.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "APPROVED",
    });

    const app = await t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("APPROVED");
    expect(app?.approvedBy).toBeTruthy();
  });

  test("invalid DRAFT to APPROVED transition throws", async () => {
    const { t, orgId, salespersonId, customerId, asApprover } =
      await seedFinanceLifecycleDealer("skip");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "DRAFT",
    });

    await expect(
      asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/DRAFT -> APPROVED/);
  });

  test("APPROVED to REJECTED transition is blocked", async () => {
    const { t, orgId, salespersonId, customerId, asApprover } =
      await seedFinanceLifecycleDealer("approved_rejected");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "APPROVED",
    });

    await expect(
      asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "REJECTED",
      })
    ).rejects.toThrow(/APPROVED -> REJECTED/);
  });

  test("CLOSED is terminal", async () => {
    const { t, orgId, salespersonId, customerId, asApprover } =
      await seedFinanceLifecycleDealer("closed_terminal");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "CLOSED",
    });

    await expect(
      asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "PENDING_DOCS",
      })
    ).rejects.toThrow(/CLOSED -> PENDING_DOCS/);
  });

  test("salesperson cannot self-approve", async () => {
    const { t, orgId, salespersonId, customerId, asSalesperson } =
      await seedFinanceLifecycleDealer("self_approval");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "UNDER_REVIEW",
    });

    await expect(
      asSalesperson.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/cannot approve your own application/i);
  });

  test("user without APPROVE_FINANCE_APPLICATION cannot approve", async () => {
    const { t, orgId, salespersonId, customerId, asLimitedUser } =
      await seedFinanceLifecycleDealer("missing_approve");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "UNDER_REVIEW",
    });

    await expect(
      asLimitedUser.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/approve:finance_application/);
  });

  test("finalizeDeal requires FINALIZE_FINANCED_DEAL permission", async () => {
    const { t, orgId, salespersonId, customerId, asLimitedUser, asFinalizer } =
      await seedFinanceLifecycleDealer("finalize");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "APPROVED",
    });

    await expect(
      asLimitedUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/finalize:financed_deal/);

    await asFinalizer.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asFinalizer.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });

    const saleId = await asFinalizer.mutation(api.applications.finalizeDeal, {
      orgId,
      applicationId,
    });
    expect(saleId).toBeTruthy();
  });

  test("confirmDisbursement requires CONFIRM_FINANCE_DISBURSEMENT permission", async () => {
    const { t, orgId, salespersonId, customerId, asLimitedUser, asAccountant } =
      await seedFinanceLifecycleDealer("disbursement");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "CLOSED",
      withFinanceCompany: true,
    });

    await expect(
      asLimitedUser.mutation(api.applications.confirmDisbursement, {
        orgId,
        applicationId,
        disbursedAmountMinor: 20_000_000,
      })
    ).rejects.toThrow(/confirm:finance_disbursement/);

    await asAccountant.mutation(api.applications.confirmDisbursement, {
      orgId,
      applicationId,
      disbursedAmountMinor: 20_000_000,
    });

    const app = await t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.disbursedAmountMinor).toBe(20_000_000);
  });

  test("REJECTED to PENDING_DOCS resubmission is allowed", async () => {
    const { t, orgId, salespersonId, customerId, asSalesperson } =
      await seedFinanceLifecycleDealer("resubmit");
    const { applicationId } = await seedFinanceApplication(t, {
      orgId,
      customerId,
      salespersonId,
      status: "REJECTED",
    });

    await asSalesperson.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "PENDING_DOCS",
    });

    const app = await t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("PENDING_DOCS");
  });
});
