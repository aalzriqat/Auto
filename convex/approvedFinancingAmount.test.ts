import { TestConvex as ConvexTestInstance } from "convex-test";
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { recomputeEconomicsForApplication } from "./financingEconomics";

/**
 * SCRUM-613 / SCRUM-993: the approved financing amount F is ENTERED and is the
 * funded authority. Driven only through the public mutations. JOD x 1000.
 * Reference case D-000006: quotation 11,000, approved purchase value 10,500,
 * F 9,450, customer pays 1,240.
 */
type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);

async function seedDeal(opts: { quotation: number; firstPayment: number; suffix: string; sharedT?: TestConvex }) {
  const t: TestConvex = opts.sharedT ?? convexTestWithComponents(schema, MODULES);
  const s = opts.suffix;
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `AFA ${s}`, createdAt: Date.now() }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const mkUser = async (key: string) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `afa_${key}_${s}`, email: `afa.${key}${s}@example.com`, name: key })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: `afa_${key}_${s}` });
  };
  const asUser = await mkUser("user");
  const asApprover = await mkUser("approver");
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `AFAVIN${s}`, make: "Toyota", model: "Camry", year: 2024, mileage: 100, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", purchasePrice: 9_000, sellingPrice: opts.quotation, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B" }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const companyId = await asUser.mutation(api.finance.createCompany, {
    orgId, name: "Jordan Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true,
    adminFees: 0, maxFinancingLTV: 90, defaultLtvPercent: 85, customerFirstPaymentOffsetsUnfinancedShare: true,
  });
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, mode: "CONFIGURED_FINANCE_COMPANY", companyId,
    customerEligibilityStatusIds: [customerStatusId], vehiclePrice: opts.quotation, downPayment: opts.firstPayment,
    termMonths: 48, totalFinancedAmount: opts.quotation - opts.firstPayment,
  });
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(opts.quotation), source: "MANUAL_ENTRY",
    targetSellingAmountMinor: jod(opts.quotation), estimatedDealerBorneExpensesMinor: 0,
    customerFirstPaymentMinor: jod(opts.firstPayment),
  });
  return { t, orgId, applicationId, asUser, asApprover };
}

type Seed = Awaited<ReturnType<typeof seedDeal>>;
const read = async (s: Seed) => (await s.t.run((ctx) => ctx.db.get(s.applicationId)))!;
const approve = (s: Seed, approvedMajor: number, financingMajor: number | undefined, ltv = 85) =>
  s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId: s.applicationId, approvedAmountMinor: jod(approvedMajor),
    // Omission is cast through unknown on purpose: the type forbids it, the server must too.
    approvedFinancingAmountMinor: (financingMajor === undefined ? undefined : jod(financingMajor)) as unknown as number,
    basis: "MANUAL", notes: "Approval letter", appliedLtvPercent: ltv, outlierAcknowledged: true,
  });

describe("approved financing amount through approveDealerPurchaseAmount", () => {
  test("D-000006: funded is the entered 9,450 and the excess is 190, not 8,925 / 335", async () => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "d6" });
    await approve(s, 10_500, 9_450);
    const app = await read(s);
    expect(app.approvedFinancingAmountMinor).toBe(jod(9_450));
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(9_450));
    expect(app.unfinancedPortionMinor).toBe(jod(1_050));
    expect(app.dealerContributionMinor).toBe(0);
    expect(app.approvalExcessMinor).toBe(jod(190));
  });

  test("12,000 case: A 12,000 at 90% with first payment 2,000 gives funded 10,800, excess 800", async () => {
    const s = await seedDeal({ quotation: 12_000, firstPayment: 2_000, suffix: "c12" });
    await approve(s, 12_000, 10_800, 90);
    const app = await read(s);
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(10_800));
    expect(app.unfinancedPortionMinor).toBe(jod(1_200));
    expect(app.dealerContributionMinor).toBe(0);
    expect(app.approvalExcessMinor).toBe(jod(800));
  });

  test("a genuine gap leaves a contribution and no excess", async () => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 500, suffix: "gap" });
    await approve(s, 10_500, 9_450);
    const app = await read(s);
    expect(app.dealerContributionMinor).toBe(jod(550));
    expect(app.approvalExcessMinor).toBe(0);
  });

  test("a new approval without the amount is refused and writes nothing (the percentage basis is unreachable)", async () => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "leg" });
    await expect(approve(s, 10_500, undefined)).rejects.toThrow();
    const app = await read(s);
    expect(app.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(app.approvedFinancingAmountMinor).toBeUndefined();
  });

  test("a legacy row with no stored amount recomputes on the percentage basis", async () => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "leg2" });
    await approve(s, 10_500, 9_450);
    await s.t.run((ctx) => ctx.db.patch(s.applicationId, { approvedFinancingAmountMinor: undefined }));
    await s.t.run((ctx) => recomputeEconomicsForApplication(ctx, s.applicationId));
    const app = await read(s);
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(8_925));
    expect(app.dealerContributionMinor).toBe(jod(335));
    expect(app.approvalExcessMinor).toBe(0);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["above the approved value", 10_500.001],
  ])("refuses an entered amount that is %s and writes nothing", async (_label, financing) => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: `bad${String(financing)}` });
    await expect(
      s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId, applicationId: s.applicationId, approvedAmountMinor: jod(10_500), approvedFinancingAmountMinor: Math.round(financing * 1000), basis: "MANUAL", notes: "x", appliedLtvPercent: 85,
        outlierAcknowledged: true,
      })
    ).rejects.toThrow(/approved financing amount/i);
    const app = await read(s);
    expect(app.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(app.approvedFinancingAmountMinor).toBeUndefined();
  });

  test("finalizing an approval with an excess is refused with a coded message and writes nothing", async () => {
    const s = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "fin" });
    await approve(s, 10_500, 9_450);
    await s.t.run((ctx) => ctx.db.patch(s.applicationId, { status: "APPROVED" }));
    const refused = await s.asApprover
      .mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId: s.applicationId, idempotencyKey: "afa-fin-1" })
      .then(() => null, (e: unknown) => e as { data?: { code?: string } });
    expect(refused?.data?.code).toBe("APPROVAL_EXCESS_NOT_POSTABLE");
    const app = await read(s);
    expect(app.status).toBe("APPROVED");
    expect(app.finalizedSaleId).toBeUndefined();
  });

  test("a caller from another organization cannot write the amount", async () => {
    const a = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "ten" });
    // ONE harness for both orgs: two instances hand out identical ids, which would make this vacuous.
    const b = await seedDeal({ quotation: 11_000, firstPayment: 1_240, suffix: "ten2", sharedT: a.t });
    await expect(
      b.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: b.orgId, applicationId: a.applicationId as Id<"financeApplications">,
        approvedAmountMinor: jod(10_500), approvedFinancingAmountMinor: jod(9_450), basis: "MANUAL", notes: "x",
        appliedLtvPercent: 85, outlierAcknowledged: true,
      })
    ).rejects.toThrow();
    expect((await read(a)).approvedFinancingAmountMinor).toBeUndefined();
  });
});
