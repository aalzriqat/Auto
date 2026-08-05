import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs the migration to completion.
 *
 * It self-schedules: companies first, then applications, a bounded page at a
 * time. A direct call therefore returns after the first page only, so the
 * scheduled continuations have to be drained before anything is asserted.
 * Fake timers must be installed BEFORE the first call — vitest only controls
 * timers created after `useFakeTimers()`, so installing them at drain time
 * would leave the scheduler on the real clock with nothing to fire.
 */
async function runMigration(t: TestConvex): Promise<void> {
  vi.useFakeTimers();
  await t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** JOD minor units (scale 3), matching getOrgCurrency's default. */
const jod = (major: number): number => Math.round(major * 1000);

/**
 * The dealer's confirmed baseline, as one object so each test varies one thing.
 *
 *   cost 9,500 · target 10,500 · first payment 500 · expenses 625 · LTV 85%
 *   → quotation 12,500 → funded 10,625 + customer 500 + dealer 1,375
 */
const DEAL = {
  vehicleCost: 9_500,
  targetSelling: 10_500,
  customerFirstPayment: 500,
  quotation: 12_500,
  ltvPercent: 85,
  /**
   * INFERRED, not supplied — the residual that makes the solver reproduce the
   * example's 12,500. Not a production default and not a domain rule; it exists
   * here only so this scenario is reproducible.
   */
  exampleDealerBorneExpenses: 625,
};

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  approverId: Id<"users">;
  customerId: Id<"customers">;
  vehicleId: Id<"vehicles">;
  companyId: Id<"financeCompanies">;
  asUser: AuthenticatedTestConvex;
  /** Approving your own application is blocked, as it is for the credit decision. */
  asApprover: AuthenticatedTestConvex;
}

async function seedDealer(
  companyRules: Partial<{
    defaultLtvPercent: number;
    minimumLtvPercent: number;
    maxFinancingLTV: number;
    allowsQuotationAboveAppraisal: boolean;
    lowerAppraisalTolerancePercent: number;
    minimumCustomerFirstPaymentMinor: number;
  }> = {},
  suffix = "1"
): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Econ Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `econ_user_${suffix}`,
      email: `econ${suffix}@example.com`,
      name: "Econ User",
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
  const asUser = t.withIdentity({ subject: `econ_user_${suffix}` });

  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `econ_approver_${suffix}`,
      email: `econ.approver${suffix}@example.com`,
      name: "Econ Approver",
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: approverId, roleId })
  );
  const asApprover = t.withIdentity({ subject: `econ_approver_${suffix}` });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `ECONVIN${suffix}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: DEAL.vehicleCost,
      sellingPrice: DEAL.targetSelling,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Econ", lastName: "Customer" })
  );

  const companyId = await asUser.mutation(api.finance.createCompany, {
    orgId,
    name: "Jordan Finance",
    profitRate: 5,
    maxTermMonths: 60,
    gracePeriodMonths: 0,
    isActive: true,
    maxFinancingLTV: companyRules.maxFinancingLTV ?? 85,
    defaultLtvPercent: companyRules.defaultLtvPercent ?? DEAL.ltvPercent,
    customerFirstPaymentOffsetsUnfinancedShare: true,
    ...(companyRules.minimumLtvPercent !== undefined
      ? { minimumLtvPercent: companyRules.minimumLtvPercent }
      : {}),
    ...(companyRules.allowsQuotationAboveAppraisal !== undefined
      ? { allowsQuotationAboveAppraisal: companyRules.allowsQuotationAboveAppraisal }
      : {}),
    ...(companyRules.lowerAppraisalTolerancePercent !== undefined
      ? { lowerAppraisalTolerancePercent: companyRules.lowerAppraisalTolerancePercent }
      : {}),
    ...(companyRules.minimumCustomerFirstPaymentMinor !== undefined
      ? { minimumCustomerFirstPaymentMinor: companyRules.minimumCustomerFirstPaymentMinor }
      : {}),
  });

  return { t, orgId, userId, approverId, customerId, vehicleId, companyId, asUser, asApprover };
}

/** Creates the quote and the application the economics hang off. */
async function createApplication(seed: Seed): Promise<Id<"financeApplications">> {
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId: seed.vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: seed.companyId,
    vehiclePrice: DEAL.targetSelling,
    downPayment: DEAL.customerFirstPayment,
    termMonths: 48,
    totalFinancedAmount: 10_736,
  });
  return await seed.asUser.mutation(api.applications.createFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
}

async function recordBaselineQuotation(
  seed: Seed,
  applicationId: Id<"financeApplications">,
  quotationMajor = DEAL.quotation
): Promise<void> {
  await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: seed.orgId,
    applicationId,
    submittedQuotationMinor: jod(quotationMajor),
    source: "SYSTEM_CALCULATED",
    targetSellingAmountMinor: jod(DEAL.targetSelling),
    estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
    customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
  });
}

async function readApp(seed: Seed, applicationId: Id<"financeApplications">) {
  const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
  if (!app) throw new Error("application vanished");
  return app;
}

// ---------------------------------------------------------------------------

describe("suggested quotation", () => {
  test("suggests the dealer's confirmed 12,500 and shows the 1,375 contribution", async () => {
    const seed = await seedDealer();

    const suggestion = await seed.asUser.query(api.financingEconomics.suggestQuotation, {
      orgId: seed.orgId,
      companyId: seed.companyId,
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    expect(suggestion.submittedQuotationMinor).toBe(jod(12_500));
    expect(suggestion.appliedLtvPercent).toBe(85);
    expect(suggestion.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(suggestion.unfinancedPortionMinor).toBe(jod(1_875));
    expect(suggestion.dealerContributionMinor).toBe(jod(1_375));
    expect(suggestion.currency).toBe("JOD");
  });

  test("refuses a first payment below the company's minimum", async () => {
    const seed = await seedDealer({ minimumCustomerFirstPaymentMinor: jod(1_000) });

    await expect(
      seed.asUser.query(api.financingEconomics.suggestQuotation, {
        orgId: seed.orgId,
        companyId: seed.companyId,
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(500),
      })
    ).rejects.toThrow(/first payment of at least/i);
  });

  test("refuses an LTV outside the company's own bounds", async () => {
    const seed = await seedDealer({ minimumLtvPercent: 70, maxFinancingLTV: 85 });

    await expect(
      seed.asUser.query(api.financingEconomics.suggestQuotation, {
        orgId: seed.orgId,
        companyId: seed.companyId,
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
        ltvPercent: 95,
      })
    ).rejects.toThrow(/above this company's maximum/i);
  });
});

describe("base approval — the confirmed deal", () => {
  test("full approval at 12,500 funds 10,625 with a 1,375 dealer contribution and no gap", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_500),
      providerType: "FINANCE_COMPANY",
      providerName: "Jordan Finance Appraisals",
      appraisedAt: Date.now(),
    });

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "APPRAISAL",
    });

    const app = await readApp(seed, applicationId);
    expect(app.approvedDealerPurchaseAmountMinor).toBe(jod(12_500));
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(app.unfinancedPortionMinor).toBe(jod(1_875));
    expect(app.dealerContributionMinor).toBe(jod(1_375));
    expect(app.rawAppraisalGapMinor).toBe(0);
    expect(app.expectedDealerRemittanceMinor).toBe(jod(12_500));
    expect(app.gapResolution).toBe("NOT_REQUIRED");
    expect(app.appraisalStatus).toBe("FINALIZED");
  });

  test("a new application carries the five dimensions and a rule snapshot", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    const app = await readApp(seed, applicationId);
    expect(app.creditDecision).toBe("SUBMITTED");
    expect(app.appraisalStatus).toBe("NOT_REQUESTED");
    expect(app.settlementStatus).toBe("NOT_READY");
    expect(app.handoverStatus).toBe("BLOCKED");
    expect(app.companyRuleSnapshot?.defaultLtvPercent).toBe(85);
    expect(app.companyRuleVersionId).toBeDefined();
    // The legacy status is untouched, so every existing reader keeps working.
    expect(app.status).toBe("PENDING_DOCS");
  });
});

describe("lower appraisal", () => {
  test("an 11,500 approval opens a raw 1,000 gap and funds 9,775", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });

    const app = await readApp(seed, applicationId);
    // The negotiated amount is the raw 1,000, not the 850 the company's funding
    // fell by. Both are visible; only the first is what the parties argue over.
    expect(app.rawAppraisalGapMinor).toBe(jod(1_000));
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(9_775));
    expect(jod(10_625) - app.financeCompanyFundedPortionMinor!).toBe(jod(850));
    expect(app.dealerContributionMinor).toBe(jod(1_225));
    expect(app.gapResolution).toBe("PENDING_NEGOTIATION");
  });

  test("an approval on the appraisal basis must equal the appraisal", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_000),
        basis: "APPRAISAL",
      })
    ).rejects.toThrow(/must equal it/i);
  });
});

describe("financing-company exception", () => {
  test("a company whose tolerance allows it can approve at the full 12,500", async () => {
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "QUOTATION_EXCEPTION",
      notes: "Company accepted the quotation under its 10% tolerance.",
    });

    const app = await readApp(seed, applicationId);
    expect(app.approvedDealerPurchaseAmountMinor).toBe(jod(12_500));
    expect(app.approvedPurchaseBasis).toBe("QUOTATION_EXCEPTION");
    // Auditable: which rule version allowed it, who approved and when.
    expect(app.approvedPurchaseExceptionRuleVersion).toBe(1);
    expect(app.approvedPurchaseApprovedBy).toBe(seed.approverId);
    expect(app.approvedPurchaseApprovedAt).toBeTypeOf("number");
    // Expected remittance follows the approved purchase amount, not the
    // appraisal — the company is buying at 12,500.
    expect(app.expectedDealerRemittanceMinor).toBe(jod(12_500));
    expect(app.rawAppraisalGapMinor).toBe(0);
    expect(app.gapResolution).toBe("NOT_REQUIRED");
  });

  test("refuses the exception when the appraisal is outside the tolerance", async () => {
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 5,
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_500),
        basis: "QUOTATION_EXCEPTION",
      })
    ).rejects.toThrow(/outside .* tolerance of 5%/i);
  });

  test("refuses the exception for a company that does not grant one", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_400),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_500),
        basis: "QUOTATION_EXCEPTION",
      })
    ).rejects.toThrow(/does not accept the submitted quotation/i);
  });
});

describe("appraisal integrity", () => {
  test("a dealer estimate cannot become the approved purchase basis", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const estimateId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_500),
      providerType: "DEALER_ESTIMATE",
      appraisedAt: Date.now(),
    });

    // It does not even move the appraisal dimension.
    expect((await readApp(seed, applicationId)).appraisalStatus).toBe("PENDING");

    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_500),
        basis: "APPRAISAL",
        appraisalId: estimateId,
      })
    ).rejects.toThrow(/dealer estimate cannot be the basis/i);
  });

  test("a reappraisal supersedes rather than overwrites, and must say why", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const firstId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now() - 1_000,
    });

    await expect(
      seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
        orgId: seed.orgId,
        applicationId,
        appraisalAmountMinor: jod(12_100),
        providerType: "FINANCE_COMPANY",
        appraisedAt: Date.now(),
      })
    ).rejects.toThrow(/must record why/i);

    const secondId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_100),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
      reappraisalReason: "Customer disputed the first inspection.",
    });

    const first = await seed.t.run((ctx) => ctx.db.get(firstId));
    const second = await seed.t.run((ctx) => ctx.db.get(secondId));
    // The original survives with its own amount intact — the history a shared,
    // mutable vehicleValuations row could never keep.
    expect(first?.status).toBe("SUPERSEDED");
    expect(first?.appraisalAmountMinor).toBe(jod(11_500));
    expect(first?.supersededByAppraisalId).toBe(secondId);
    expect(second?.isReappraisal).toBe(true);
  });

  test("a later application on the same vehicle keeps its own appraisal history", async () => {
    const seed = await seedDealer();
    const firstApplicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, firstApplicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId: firstApplicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId: firstApplicationId,
      reason: "Customer postponed.",
    });

    const secondApplicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, secondApplicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId: secondApplicationId,
      appraisalAmountMinor: jod(12_300),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    const first = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId: firstApplicationId,
    });
    const second = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId: secondApplicationId,
    });

    expect(first.appraisals).toHaveLength(1);
    expect(first.appraisals[0]?.appraisalAmountMinor).toBe(jod(11_500));
    expect(second.appraisals).toHaveLength(1);
    expect(second.appraisals[0]?.appraisalAmountMinor).toBe(jod(12_300));
  });
});

describe("appraisal and approval interaction", () => {
  async function seedApprovedDeal(): Promise<{
    seed: Seed;
    applicationId: Id<"financeApplications">;
  }> {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });
    return { seed, applicationId };
  }

  test("a dealer estimate does not supersede the finance company's appraisal", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const realId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_000),
      providerType: "DEALER_ESTIMATE",
      appraisedAt: Date.now(),
    });

    // The real appraisal survives, so the approval is still reachable on the
    // APPRAISAL basis rather than being forced onto MANUAL, which skips the
    // rule guards entirely.
    expect((await seed.t.run((ctx) => ctx.db.get(realId)))?.status).toBe("RECORDED");
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });
    expect((await readApp(seed, applicationId)).approvedPurchaseBasis).toBe("APPRAISAL");
  });

  test("a dealer estimate recorded first does not make the real appraisal a reappraisal", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_000),
      providerType: "DEALER_ESTIMATE",
      appraisedAt: Date.now(),
    });

    // Estimating before quoting is the natural order and must not demand a
    // reappraisal reason for the first real appraisal on the deal.
    const realId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    expect((await seed.t.run((ctx) => ctx.db.get(realId)))?.isReappraisal).toBe(false);
  });

  test("re-approval works after the first approval marked the appraisal APPROVED", async () => {
    const { seed, applicationId } = await seedApprovedDeal();

    // The first approval flips the appraisal RECORDED -> APPROVED. Matching only
    // RECORDED made the auto-selector find nothing, so every re-approval threw
    // and the explicit appraisalId argument was the sole route through.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });

    // Re-approving at the same amount changed nothing, so it writes no audit
    // row — a double-clicked Approve should not read as a revision.
    const unchanged = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(unchanged.overrides).toHaveLength(0);
    expect(unchanged.application.approvedDealerPurchaseAmountMinor).toBe(jod(11_500));
  });

  test("a new appraisal clears the approval it invalidated rather than leaving it stale", async () => {
    const { seed, applicationId } = await seedApprovedDeal();
    expect((await readApp(seed, applicationId)).rawAppraisalGapMinor).toBe(jod(1_000));

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(9_000),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
      reappraisalReason: "Company re-inspected after the customer disputed it.",
    });

    const app = await readApp(seed, applicationId);
    // The old approval matched no live appraisal, so nothing derived from it
    // may survive — including the 1,000 gap somebody might have negotiated.
    expect(app.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(app.approvedPurchaseBasis).toBeUndefined();
    expect(app.rawAppraisalGapMinor).toBeUndefined();
    expect(app.gapResolution).toBeUndefined();
    expect(app.appraisalStatus).toBe("COMPLETED");
  });

  test("re-approving at a lower amount reopens the gap instead of keeping NOT_REQUIRED", async () => {
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "QUOTATION_EXCEPTION",
      notes: "Accepted under tolerance.",
    });
    expect((await readApp(seed, applicationId)).gapResolution).toBe("NOT_REQUIRED");

    // The company withdraws the exception and buys at the appraisal instead.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });

    const app = await readApp(seed, applicationId);
    expect(app.rawAppraisalGapMinor).toBe(jod(1_000));
    expect(app.gapResolution).toBe("PENDING_NEGOTIATION");
    // The exception's rule version must not linger on an APPRAISAL approval.
    expect(app.approvedPurchaseExceptionRuleVersion).toBeUndefined();
  });

  test("rejects a superseded appraisal named explicitly as the basis", async () => {
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const staleId = await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now() - 1_000,
    });
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(9_000),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
      reappraisalReason: "Second inspection found undisclosed damage.",
    });

    // The stale 11,500 sits inside the 10% tolerance where the live 9,000 does
    // not — naming it would buy an exception the current evidence forbids.
    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_500),
        basis: "QUOTATION_EXCEPTION",
        appraisalId: staleId,
      })
    ).rejects.toThrow(/superseded/i);
  });

  test("a manual approval with no appraisal does not claim a finalized one", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_800),
      basis: "MANUAL",
      notes: "Negotiated directly with the branch manager.",
    });

    const app = await readApp(seed, applicationId);
    expect(app.approvedDealerPurchaseAmountMinor).toBe(jod(11_800));
    // FINALIZED would assert an appraisal that never happened, in a dimension
    // handover readiness is gated on.
    expect(app.appraisalStatus).toBe("PENDING");
  });
});

describe("incomplete economics", () => {
  test("an unknown LTV basis is not treated as no gap", async () => {
    const seed = await seedDealer();
    // The company lends against the independent appraisal.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
      ltvBasis: "INDEPENDENT_APPRAISAL",
    });

    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // A manual approval below the quotation, with no appraisal on file. The
    // funding cannot be computed at all, so declaring the deal gap-free would
    // be a claim about economics that do not exist.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "MANUAL",
      notes: "Agreed directly with the branch manager.",
    });

    const app = await readApp(seed, applicationId);
    expect(app.financeCompanyFundedPortionMinor).toBeUndefined();
    expect(app.rawAppraisalGapMinor).toBeUndefined();
    expect(app.gapResolution).toBeUndefined();
    expect(app.needsFinancingReconciliation).toBe(true);
    expect(app.financingReconciliationReason).toMatch(/independent appraisal/i);
  });

  test("a deal whose funding split could not be calculated cannot be handed over", async () => {
    const seed = await seedDealer();
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
      ltvBasis: "INDEPENDENT_APPRAISAL",
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "MANUAL",
      notes: "Agreed directly with the branch manager.",
    });
    await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "APPROVED" }));

    // The approval is present, which used to be the whole gate. It is not
    // enough: the vehicle would go out against a funding split nobody has.
    await expect(
      seed.asUser.mutation(api.applications.registerVehicleHandover, {
        orgId: seed.orgId,
        applicationId,
      })
    ).rejects.toThrow(/funding split could not be calculated/i);
  });

  test("rejects an LTV too small to survive the engine's precision", async () => {
    const seed = await seedDealer();
    await expect(
      seed.asUser.mutation(api.finance.updateCompany, {
        id: seed.companyId,
        orgId: seed.orgId,
        name: "Jordan Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        maxFinancingLTV: 85,
        // Positive, so the > 0 check passes; rounds to zero at the engine's
        // six-decimal scale, so every later quotation would divide by zero.
        defaultLtvPercent: 0.0000001,
      })
    ).rejects.toThrow(/too small to be represented/i);
  });
});

describe("reopening an approval", () => {
  async function seedApproved(): Promise<{ seed: Seed; applicationId: Id<"financeApplications"> }> {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });
    return { seed, applicationId };
  }

  test("withdraws the approval so the quotation can change, without faking an appraisal", async () => {
    const { seed, applicationId } = await seedApproved();

    // Before this mutation existed, recordSubmittedQuotation told users to
    // "reopen the approval" and the only thing that cleared one was recording a
    // fresh appraisal — forcing manufactured evidence for a legitimate action.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(11_800),
        source: "MANUAL_ENTRY",
        overrideReason: "Withdrawing and resubmitting lower.",
      })
    ).rejects.toThrow(/already approved a purchase amount/i);

    await seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
      orgId: seed.orgId,
      applicationId,
      reason: "Company withdrew its offer; resubmitting lower.",
    });

    const reopened = await readApp(seed, applicationId);
    expect(reopened.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(reopened.rawAppraisalGapMinor).toBeUndefined();
    expect(reopened.gapResolution).toBeUndefined();
    expect(reopened.handoverStatus).toBe("BLOCKED");

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(11_800),
      source: "MANUAL_ENTRY",
      overrideReason: "Withdrawing and resubmitting lower.",
    });
    expect((await readApp(seed, applicationId)).submittedQuotationMinor).toBe(jod(11_800));
  });

  test("requires a reason, and refuses once the vehicle has gone out", async () => {
    const { seed, applicationId } = await seedApproved();

    await expect(
      seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
        orgId: seed.orgId,
        applicationId,
        reason: "   ",
      })
    ).rejects.toThrow(/must record why/i);

    await seed.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: Date.now() }));
    await expect(
      seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
        orgId: seed.orgId,
        applicationId,
        reason: "Too late.",
      })
    ).rejects.toThrow(/already been handed over/i);
  });

  test("does not claim a completed appraisal on a deal that never had one", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_800),
      basis: "MANUAL",
      notes: "Negotiated directly.",
    });

    await seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
      orgId: seed.orgId,
      applicationId,
      reason: "Reconsidered.",
    });

    expect((await readApp(seed, applicationId)).appraisalStatus).toBe("PENDING");
  });

  test("re-approving after a reappraisal restores handover readiness", async () => {
    const { seed, applicationId } = await seedApproved();
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { status: "APPROVED", handoverStatus: "READY" })
    );

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_000),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
      reappraisalReason: "Company re-inspected.",
    });
    expect((await readApp(seed, applicationId)).handoverStatus).toBe("BLOCKED");

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_000),
      basis: "APPRAISAL",
    });

    // Nothing else could put it back: updateStatus cannot run again because
    // APPROVED is terminal there, so the deal stayed un-handoverable forever.
    expect((await readApp(seed, applicationId)).handoverStatus).toBe("READY");
  });

  test("records an approval that changes only its basis", async () => {
    const { seed, applicationId } = await seedApproved();

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "MANUAL",
      notes: "Renegotiated verbally with the branch.",
    });

    // Same amount, different basis, approver and notes — all replaced. Keying
    // the audit row on the amount alone recorded none of it.
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0]?.newValue).toContain("MANUAL");
  });

  test("blocks approving your own application", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await expect(
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(11_800),
        basis: "MANUAL",
        notes: "Approving my own deal.",
      })
    ).rejects.toThrow(/your own application/i);
  });
});

describe("reconciliation queue", () => {
  test("a company that keeps the customer payment flags rather than blanking silently", async () => {
    const seed = await seedDealer();
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
      customerContributionSettlement: "RETAINED_BY_COMPANY",
    });

    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "APPRAISAL",
    });

    // Nothing records where the customer money went yet, so for such a company
    // this is every deal, permanently. An unflagged blank reads downstream
    // exactly like agreement.
    const app = await readApp(seed, applicationId);
    expect(app.expectedDealerRemittanceMinor).toBeUndefined();
    expect(app.needsFinancingReconciliation).toBe(true);
    expect(app.financingReconciliationReason).toMatch(/keeps the customer/i);
  });

  test("lists flagged deals, and clears one only with a note", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        needsFinancingReconciliation: true,
        financingReconciliationReason: "Legacy figures need checking.",
      })
    );

    expect(
      await seed.asUser.query(api.financingEconomics.listNeedingReconciliation, {
        orgId: seed.orgId,
      })
    ).toHaveLength(1);

    await expect(
      seed.asUser.mutation(api.financingEconomics.resolveFinancingReconciliation, {
        orgId: seed.orgId,
        applicationId,
        note: "  ",
      })
    ).rejects.toThrow(/what was checked/i);

    await seed.asUser.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: seed.orgId,
      applicationId,
      note: "Confirmed the remittance against the bank statement.",
    });

    expect(
      await seed.asUser.query(api.financingEconomics.listNeedingReconciliation, {
        orgId: seed.orgId,
      })
    ).toHaveLength(0);
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides.some((o) => o.field === "needsFinancingReconciliation")).toBe(true);
  });
});

describe("permissions", () => {
  async function addSalesUser(seed: Seed): Promise<AuthenticatedTestConvex> {
    const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "SALES");
    if (!template) throw new Error("no SALES template");
    const userId = await seed.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "econ_sales", email: "sales@example.com", name: "Sales" })
    );
    const roleId = await seed.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: seed.orgId, name: "SALES", permissions: [...template.permissions] })
    );
    await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId }));
    return seed.t.withIdentity({ subject: "econ_sales" });
  }

  test("SALES cannot record a finance company's appraisal, only a dealer estimate", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    const asSales = await addSalesUser(seed);

    // providerType is self-declared, so a SALES-writable real appraisal would
    // let a salesperson set it equal to their own quotation and erase the
    // customer's gap obligation.
    await expect(
      asSales.mutation(api.financingEconomics.recordAppraisal, {
        orgId: seed.orgId,
        applicationId,
        appraisalAmountMinor: jod(12_500),
        providerType: "FINANCE_COMPANY",
        appraisedAt: Date.now(),
      })
    ).rejects.toThrow(/permission/i);

    await asSales.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_000),
      providerType: "DEALER_ESTIMATE",
      appraisedAt: Date.now(),
    });
    expect((await readApp(seed, applicationId)).dealerEstimateMinor).toBe(jod(12_000));
  });

  test("a caller without VIEW_COST_PRICE does not receive the vehicle cost", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { vehiclePurchaseCostMinor: jod(9_500) })
    );
    const asSales = await addSalesUser(seed);

    const forSales = await asSales.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(forSales.application.vehiclePurchaseCostMinor).toBeUndefined();

    const forOwner = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(forOwner.application.vehiclePurchaseCostMinor).toBe(jod(9_500));
  });
});

describe("LTV configuration", () => {
  test("refuses to quote a company that has no applied LTV rather than borrowing its ceiling", async () => {
    const seed = await seedDealer();
    const bareCompanyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Unconfigured Finance Co",
        profitRate: 6,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        // What FinanceCompanyDialog writes for a company that never had one.
        maxFinancingLTV: 100,
        isActive: true,
      })
    );

    await expect(
      seed.asUser.query(api.financingEconomics.suggestQuotation, {
        orgId: seed.orgId,
        companyId: bareCompanyId,
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/No LTV is configured/i);
  });

  test("applies the LTV to the appraisal when that is the company's rule", async () => {
    const seed = await seedDealer();
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
      ltvBasis: "INDEPENDENT_APPRAISAL",
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });

    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "QUOTATION_EXCEPTION",
      notes: "Accepted under tolerance, but funded against the appraisal.",
    });

    const app = await readApp(seed, applicationId);
    // Buying at 12,500 but funding 85% of the 11,500 appraisal: the dealership
    // has to make up the difference, and a stored-but-ignored basis hid it.
    expect(app.approvedDealerPurchaseAmountMinor).toBe(jod(12_500));
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(9_775));
    expect(app.dealerContributionMinor).toBe(jod(2_225));
  });
});

describe("overrides and audit", () => {
  test("accepts a negotiated quotation with no solver involved", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // MANUAL_ENTRY is a first-class mode, not a deviation: the dealership
    // negotiated a figure and the solver was never consulted, so there is
    // nothing for it to explain a departure from.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
    });

    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBe(jod(13_000));
    expect(app.quotationCalculationSnapshot?.mode).toBe("MANUAL_ENTRY");
    // Nothing was back-solved to fill the blanks.
    expect(app.estimatedDealerBorneExpensesMinor).toBeUndefined();
    expect(app.quotationBufferMinor).toBeUndefined();
  });

  test("departing from a calculated quotation must record why", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_000),
        source: "CALCULATED_WITH_OVERRIDE",
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/must record why/i);
  });

  test("snapshots the mode, inputs, solver figure and override together", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "CALCULATED_WITH_OVERRIDE",
      overrideReason: "Company asked for a higher figure to cover its own fee.",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      quotationBufferMinor: 0,
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const snapshot = (await readApp(seed, applicationId)).quotationCalculationSnapshot;
    expect(snapshot?.mode).toBe("CALCULATED_WITH_OVERRIDE");
    expect(snapshot?.targetNetProceedsMinor).toBe(jod(DEAL.targetSelling));
    expect(snapshot?.estimatedDealerBorneExpensesMinor).toBe(
      jod(DEAL.exampleDealerBorneExpenses)
    );
    expect(snapshot?.quotationBufferMinor).toBe(0);
    expect(snapshot?.appliedLtvPercent).toBe(85);
    expect(snapshot?.ruleVersion).toBe(1);
    // Both figures kept, so the departure is auditable against what the solver
    // would have sent.
    expect(snapshot?.calculatedQuotationMinor).toBe(jod(12_500));
    expect(snapshot?.finalQuotationMinor).toBe(jod(13_000));
    expect(snapshot?.overrideReason).toMatch(/its own fee/);
  });

  test("records why the solver was unavailable rather than quoting anyway", async () => {
    const seed = await seedDealer();
    // A company that has not told us whether the customer's first payment
    // offsets the unfinanced share.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
      customerFirstPaymentOffsetsUnfinancedShare: false,
    });

    const applicationId = await createApplication(seed);
    const suggestion = await seed.asUser.query(api.financingEconomics.suggestQuotation, {
      orgId: seed.orgId,
      companyId: seed.companyId,
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });
    expect(suggestion.available).toBe(false);

    // The dealership types what it negotiated instead, and the snapshot records
    // that no calculated figure existed to depart from.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(12_500),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
    });

    const snapshot = (await readApp(seed, applicationId)).quotationCalculationSnapshot;
    expect(snapshot?.calculatedQuotationMinor).toBeUndefined();
    expect(snapshot?.solverUnavailableReason).toBe("OFFSET_RULE_DOES_NOT_APPLY");
  });

  test("changing a recorded quotation logs the previous value, reason and user", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
      overrideReason: "Company asked for a revised quotation after the inspection.",
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0]).toMatchObject({
      field: "submittedQuotationMinor",
      previousValue: String(jod(12_500)),
      newValue: String(jod(13_000)),
      changedBy: seed.userId,
    });
    expect(economics.overrides[0]?.reason).toMatch(/revised quotation/);
  });

  test("audits a recalculated quotation even when no reason is given", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(9_000),
      source: "SYSTEM_CALCULATED",
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0]).toMatchObject({
      field: "submittedQuotationMinor",
      previousValue: String(jod(12_500)),
      newValue: String(jod(9_000)),
    });
  });

  test("the quotation cannot be changed after the company has approved an amount", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(12_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "APPRAISAL",
    });

    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_000),
        source: "MANUAL_ENTRY",
        overrideReason: "Too late.",
      })
    ).rejects.toThrow(/already approved a purchase amount/i);
  });

  test("a manually approved purchase amount must record why", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(11_800),
        basis: "MANUAL",
      })
    ).rejects.toThrow(/must record why/i);
  });
});

describe("rule snapshots", () => {
  test("editing the company later cannot change a deal already in flight", async () => {
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_500),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
    });

    // The company tightens its tolerance to 1% and drops its LTV to 70%.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 70,
      defaultLtvPercent: 70,
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 1,
    });

    // The in-flight deal still runs under the snapshot it was created with.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_500),
      basis: "QUOTATION_EXCEPTION",
      notes: "Approved under the terms in force when the deal was submitted.",
    });

    const app = await readApp(seed, applicationId);
    expect(app.appliedLtvPercent).toBe(85);
    expect(app.financeCompanyFundedPortionMinor).toBe(jod(10_625));
  });

  test("a rule change writes a new immutable version; a name change does not", async () => {
    const seed = await seedDealer();

    const versionsAfterCreate = await seed.t.run((ctx) =>
      ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company", (q) => q.eq("companyId", seed.companyId))
        .collect()
    );
    expect(versionsAfterCreate).toHaveLength(1);

    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance (Amman)",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
    });
    expect(
      await seed.t.run((ctx) =>
        ctx.db
          .query("financeCompanyRuleVersions")
          .withIndex("by_company", (q) => q.eq("companyId", seed.companyId))
          .collect()
      )
    ).toHaveLength(1);

    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance (Amman)",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 80,
    });
    const versions = await seed.t.run((ctx) =>
      ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company", (q) => q.eq("companyId", seed.companyId))
        .collect()
    );
    expect(versions).toHaveLength(2);
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  test("saving from a client that does not know the dealer rules preserves them", async () => {
    // The existing settings dialog and the mobile app send none of the new
    // fields. If an omitted rule were written as undefined it would be deleted
    // and the next deal would silently be quoted under the defaults.
    const seed = await seedDealer({
      allowsQuotationAboveAppraisal: true,
      lowerAppraisalTolerancePercent: 10,
    });

    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Renamed By Old Client",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    });

    const company = await seed.t.run((ctx) => ctx.db.get(seed.companyId));
    expect(company?.name).toBe("Renamed By Old Client");
    // maxFinancingLTV is NOT in dealerRuleArgs, so unlike the fields below it
    // is not explicitly stripped — it survives because Convex omits an absent
    // optional argument entirely rather than passing it as `undefined`. Pinned
    // because a review argued the opposite, and because the distinction is
    // subtle: the `acceptedStatuses` guard further up IS needed, since
    // `sanitizeAcceptedStatuses` returns a real `undefined` that would delete
    // the field. Absent and undefined are different things here.
    expect(company?.maxFinancingLTV).toBe(85);
    expect(company?.defaultLtvPercent).toBe(85);
    expect(company?.allowsQuotationAboveAppraisal).toBe(true);
    expect(company?.lowerAppraisalTolerancePercent).toBe(10);
  });

  test("rejects a default LTV outside the company's own bounds", async () => {
    const seed = await seedDealer();

    await expect(
      seed.asUser.mutation(api.finance.updateCompany, {
        id: seed.companyId,
        orgId: seed.orgId,
        name: "Jordan Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        maxFinancingLTV: 80,
        defaultLtvPercent: 90,
      })
    ).rejects.toThrow(/above the maximum/i);
  });
});

describe("tenancy", () => {
  test("an application from another organization is not reachable", async () => {
    const seedA = await seedDealer({}, "a");
    const seedB = await seedDealer({}, "b");
    const applicationB = await createApplication(seedB);

    await expect(
      seedA.asUser.query(api.financingEconomics.getEconomics, {
        orgId: seedA.orgId,
        applicationId: applicationB,
      })
    ).rejects.toThrow(/not found in this organization/i);

    await expect(
      seedA.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seedA.orgId,
        applicationId: applicationB,
        submittedQuotationMinor: jod(12_500),
        source: "SYSTEM_CALCULATED",
      })
    ).rejects.toThrow(/not found in this organization/i);
  });
});

describe("input validation", () => {
  test("rejects NaN and negative money, which pass Convex's own validator", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    for (const amount of [Number.NaN, -1, 12_500.5]) {
      await expect(
        seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: seed.orgId,
          applicationId,
          submittedQuotationMinor: amount,
          source: "SYSTEM_CALCULATED",
        })
      ).rejects.toThrow(/whole number of minor units/i);
    }
  });
});

describe("migration", () => {
  /** An application exactly as it looked before any of this existed. */
  async function seedLegacyApplication(
    seed: Seed,
    overrides: Partial<{
      status: "APPROVED" | "CLOSED" | "CANCELLED" | "PENDING_DOCS";
      vehicleHandoverAt: number;
      finalizedSaleId: Id<"sales">;
      disbursedAt: number;
      companyId: Id<"financeCompanies">;
      /** Its own vehicle, for tests that also create a live application. */
      vehicleId: Id<"vehicles">;
    }> = {}
  ): Promise<Id<"financeApplications">> {
    const vehicleId = overrides.vehicleId ?? seed.vehicleId;
    const quoteId = await seed.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId,
        companyId: seed.companyId,
        vehiclePrice: 10_500,
        downPayment: 500,
        termMonths: 48,
        totalFinancedAmount: 10_736,
        status: "ACCEPTED",
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    return await seed.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: seed.orgId,
        quoteId,
        customerId: seed.customerId,
        vehicleId,
        companyId: overrides.companyId ?? seed.companyId,
        salespersonId: seed.userId,
        status: overrides.status ?? "CLOSED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(overrides.vehicleHandoverAt ? { vehicleHandoverAt: overrides.vehicleHandoverAt } : {}),
        ...(overrides.finalizedSaleId ? { finalizedSaleId: overrides.finalizedSaleId } : {}),
        ...(overrides.disbursedAt ? { disbursedAt: overrides.disbursedAt } : {}),
      })
    );
  }

  test("backfills the dimensions and flags a disbursed legacy deal without inventing money", async () => {
    const seed = await seedDealer();
    const applicationId = await seedLegacyApplication(seed, {
      status: "CLOSED",
      vehicleHandoverAt: Date.now(),
      disbursedAt: Date.now(),
    });

    await runMigration(seed.t);

    const app = await readApp(seed, applicationId);
    expect(app.creditDecision).toBe("APPROVED");
    expect(app.handoverStatus).toBe("HANDED_OVER");
    expect(app.settlementStatus).toBe("FULLY_SETTLED");
    expect(app.financingBackfilledAt).toBeTypeOf("number");
    expect(app.appraisalStatus).toBe("NOT_REQUESTED");
    // Nothing was guessed from totalFinancedAmount.
    expect(app.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(app.submittedQuotationMinor).toBeUndefined();
    expect(app.financeCompanyFundedPortionMinor).toBeUndefined();
    // gapResolution stays unset — NOT_REQUIRED would claim somebody checked.
    expect(app.gapResolution).toBeUndefined();
    expect(app.needsFinancingReconciliation).toBe(true);
    expect(app.financingReconciliationReason).toMatch(/customer's financing principal/i);
  });

  test("treats a legacy deal closed before handover timestamps existed as handed over", async () => {
    const seed = await seedDealer();
    // vehicleHandoverAt only exists from the commit that added the pre-finalize
    // handover step, 587 commits back. Every financed deal closed before it has
    // a real sale and a SOLD vehicle and no timestamp — reading those as BLOCKED
    // would declare the dealership's whole earlier history un-handoverable, and
    // PR 3 gates handover readiness on this dimension.
    const saleId = await seed.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: seed.orgId,
        vehicleId: seed.vehicleId,
        customerId: seed.customerId,
        salespersonId: seed.userId,
        salePrice: DEAL.targetSelling,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    const applicationId = await seedLegacyApplication(seed, {
      status: "CLOSED",
      finalizedSaleId: saleId,
    });

    await runMigration(seed.t);

    expect((await readApp(seed, applicationId)).handoverStatus).toBe("HANDED_OVER");
  });

  test("a legacy CLOSED row with no sale stays blocked rather than faking a handover", async () => {
    const seed = await seedDealer();
    // The old updateStatus could set CLOSED without creating a sale, stranding
    // the application. Inferring a handover from the status alone would make
    // those malformed rows indistinguishable from deals that completed.
    const applicationId = await seedLegacyApplication(seed, { status: "CLOSED" });

    await runMigration(seed.t);

    expect((await readApp(seed, applicationId)).handoverStatus).toBe("BLOCKED");
  });

  test("a cancelled legacy deal is owed nothing, even carrying a finalized sale", async () => {
    const seed = await seedDealer();
    const saleId = await seed.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: seed.orgId,
        vehicleId: seed.vehicleId,
        customerId: seed.customerId,
        salespersonId: seed.userId,
        salePrice: DEAL.targetSelling,
        saleDate: Date.now(),
        status: "CANCELLED",
      })
    );
    // cancelApplication keeps finalizedSaleId on a reversed deal and writes
    // NOT_READY. The backfill has to agree with it for the identical facts.
    const applicationId = await seedLegacyApplication(seed, {
      status: "CANCELLED",
      finalizedSaleId: saleId,
    });

    await runMigration(seed.t);

    expect((await readApp(seed, applicationId)).settlementStatus).toBe("NOT_READY");
  });

  test("completes a legacy row a live mutation touched mid-migration", async () => {
    const seed = await seedDealer();
    const applicationId = await seedLegacyApplication(seed, { status: "PENDING_DOCS" });

    // A salesperson advances the deal before the backfill reaches its page.
    // updateStatus writes creditDecision — which used to be the migration's own
    // completion sentinel, so the row was then skipped forever: no rule
    // snapshot, no settlement dimension, no reconciliation flag.
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });
    expect((await readApp(seed, applicationId)).creditDecision).toBe("UNDER_REVIEW");

    await runMigration(seed.t);

    const app = await readApp(seed, applicationId);
    // The live value is kept — it is more current than the derived one — while
    // everything the migration owns is filled in.
    expect(app.creditDecision).toBe("UNDER_REVIEW");
    expect(app.settlementStatus).toBe("NOT_READY");
    expect(app.appraisalStatus).toBe("NOT_REQUESTED");
    expect(app.companyRuleSnapshot).toBeDefined();
    expect(app.needsFinancingReconciliation).toBe(true);
  });

  test("maps each legacy status to the right credit decision and handover state", async () => {
    const seed = await seedDealer();
    const pending = await seedLegacyApplication(seed, { status: "PENDING_DOCS" });
    const approved = await seedLegacyApplication(seed, { status: "APPROVED" });
    const cancelled = await seedLegacyApplication(seed, { status: "CANCELLED" });

    await runMigration(seed.t);

    expect((await readApp(seed, pending)).creditDecision).toBe("SUBMITTED");
    expect((await readApp(seed, pending)).handoverStatus).toBe("BLOCKED");
    expect((await readApp(seed, approved)).creditDecision).toBe("APPROVED");
    expect((await readApp(seed, approved)).handoverStatus).toBe("READY");
    expect((await readApp(seed, cancelled)).creditDecision).toBe("CANCELLED");
  });

  test("is idempotent and leaves modern applications alone", async () => {
    const seed = await seedDealer();
    // Its own vehicle: an in-flight application blocks a second one on the
    // same car, which is the pre-existing rule and not what this test is about.
    const legacyVehicleId = await seed.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: seed.orgId,
        vin: "ECONVINLEGACY",
        make: "Toyota",
        model: "Corolla",
        year: 2023,
        mileage: 200,
        color: "Grey",
        fuelType: "Gasoline",
        transmission: "Automatic",
        purchasePrice: DEAL.vehicleCost,
        sellingPrice: DEAL.targetSelling,
        status: "AVAILABLE",
      })
    );
    const legacyId = await seedLegacyApplication(seed, {
      status: "APPROVED",
      vehicleId: legacyVehicleId,
    });
    const modernId = await createApplication(seed);

    await runMigration(seed.t);
    const afterFirst = await readApp(seed, legacyId);

    await runMigration(seed.t);

    expect(await readApp(seed, legacyId)).toMatchObject({
      creditDecision: afterFirst.creditDecision,
      handoverStatus: afterFirst.handoverStatus,
      settlementStatus: afterFirst.settlementStatus,
    });
    // A modern application was never flagged — it has real economics coming.
    expect((await readApp(seed, modernId)).needsFinancingReconciliation).toBeUndefined();
  });

  test("gives every existing company a rule version to snapshot, exactly once", async () => {
    const seed = await seedDealer();
    // A company inserted directly, as the 25 in production were — no ruleVersion.
    const legacyCompanyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Legacy Finance Co",
        profitRate: 6,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        maxFinancingLTV: 80,
        isActive: true,
      })
    );

    await runMigration(seed.t);
    await runMigration(seed.t);

    const company = await seed.t.run((ctx) => ctx.db.get(legacyCompanyId));
    expect(company?.ruleVersion).toBe(1);
    const versions = await seed.t.run((ctx) =>
      ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company", (q) => q.eq("companyId", legacyCompanyId))
        .collect()
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.snapshot.maximumLtvPercent).toBe(80);
    // Deliberately NOT defaulted to the maximum. The settings dialog writes
    // maxFinancingLTV: 100 for any company that never had one, so borrowing the
    // ceiling as the applied rate would quote at 100% LTV and report a dealer
    // contribution of zero. The dealership has to state the real rate.
    expect(versions[0]?.snapshot.defaultLtvPercent).toBeUndefined();
  });
});
