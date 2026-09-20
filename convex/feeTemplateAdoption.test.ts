/**
 * Verification of the retirement of `adoptCompanyFeeTemplates`.
 *
 * Old business rule:
 * - Deals frozen before a finance company had fee templates could call
 *   `financeDealCosts.adoptCompanyFeeTemplates` to populate the empty template slot.
 *
 * Why obsolete:
 * - Duplicate company fee templates and adoption UX have been retired in favor
 *   of company `adminFees` (Execution Fees / مصاريف التنفيذ) as the single
 *   authoritative expected dealer-borne fee figure.
 *
 * New invariant:
 * - Calling `financeDealCosts.adoptCompanyFeeTemplates` is retired and throws
 *   a ConvexError indicating retirement and pointing to Execution Fees.
 * - Snapshots remain immutable and itemized actual deal cost tracking via
 *   `financeDealFees` is preserved.
 */
import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;
const MODULES = import.meta.glob("./**/*.*s");

const jod = (major: number): number => Math.round(major * 1000);

const TEMPLATES = [
  {
    feeType: "LICENSING" as const,
    description: "Plates",
    estimatedAmountMinor: jod(250),
    paidBy: "DEALER" as const,
    paidTo: "GOVERNMENT" as const,
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
  },
];

const COMPANY_FIELDS = {
  profitRate: 5,
  maxTermMonths: 60,
  gracePeriodMonths: 0,
  insuranceRate: 3,
  commission: 0,
  maxFinancingLTV: 90,
  isActive: true,
};

type Seed = {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  asOwner: AuthenticatedTestConvex;
  customerId: Id<"customers">;
  customerStatusId: Id<"orgCustomerStatuses">;
  vehicleId: Id<"vehicles">;
};

async function seedDealer(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Adopt Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `adopt_user_${suffix}`, email: `adopt${suffix}@x.com` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `ADOPTVIN${suffix}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 10,
      color: "White",
      fuelType: "Gas",
      transmission: "Auto",
      purchasePrice: 15_000,
      sellingPrice: 20_000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Adopt", lastName: "Customer" })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", {
      orgId,
      label: "Eligible",
      isActive: true,
      order: 1,
    })
  );
  return {
    t,
    orgId,
    userId,
    asOwner: t.withIdentity({ subject: `adopt_user_${suffix}` }),
    customerId,
    customerStatusId,
    vehicleId,
  };
}

/** A company created WITHOUT fees, an application frozen under it, THEN the fees configured. */
async function dealFrozenBeforeFees(s: Seed) {
  const companyId = await s.asOwner.mutation(api.finance.createCompany, {
    orgId: s.orgId,
    name: "Late Fees Finance",
    defaultLtvPercent: 80,
    ...COMPANY_FIELDS,
    adminFees: 0,
  });
  const quoteId = await s.asOwner.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: 20_000,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId,
    customerEligibilityStatusIds: [s.customerStatusId],
    totalFinancedAmount: 20_000,
  });
  const applicationId = await s.asOwner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.asOwner.mutation(api.finance.updateCompany, {
    id: companyId,
    orgId: s.orgId,
    name: "Late Fees Finance",
    ...COMPANY_FIELDS,
    expectedCurrency: "JOD",
    expectedRuleVersion: 1,
    adminFees: 500,
  });
  return { companyId, applicationId };
}

describe("fee-template adoption retirement", () => {
  test("a deal frozen before fees reports NO_TEMPLATES immutability", async () => {
    const s = await seedDealer("1");
    const { applicationId } = await dealFrozenBeforeFees(s);
    const costs = await s.asOwner.query(api.financeDealCosts.listDealCosts, {
      orgId: s.orgId,
      applicationId,
    });
    expect(costs.expected.source).toBe("NO_TEMPLATES");
    expect(costs.expected.expectedTotalMinor).toBeNull();
  });

  test("adoptCompanyFeeTemplates rejects with retirement message directing to Execution Fees", async () => {
    const s = await seedDealer("2");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, {
        orgId: s.orgId,
        applicationId,
        reason: "Company fees were configured later",
      })
    ).rejects.toThrow(/Company fee templates have been retired/);
  });

  test("empty reason is rejected before retirement check", async () => {
    const s = await seedDealer("3");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, {
        orgId: s.orgId,
        applicationId,
        reason: "   ",
      })
    ).rejects.toThrow(/Say why this deal is adopting/);
  });
});
