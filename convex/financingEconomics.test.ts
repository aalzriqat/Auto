import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

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
  estimatedExpenses: 625,
  quotation: 12_500,
  ltvPercent: 85,
};

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  customerId: Id<"customers">;
  vehicleId: Id<"vehicles">;
  companyId: Id<"financeCompanies">;
  asUser: AuthenticatedTestConvex;
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

  return { t, orgId, userId, customerId, vehicleId, companyId, asUser };
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
    source: "CALCULATED",
    targetSellingAmountMinor: jod(DEAL.targetSelling),
    estimatedExpensesMinor: jod(DEAL.estimatedExpenses),
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
      estimatedExpensesMinor: jod(DEAL.estimatedExpenses),
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
        estimatedExpensesMinor: jod(DEAL.estimatedExpenses),
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
        estimatedExpensesMinor: jod(DEAL.estimatedExpenses),
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

    await seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
    await seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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

    await seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
    expect(app.approvedPurchaseApprovedBy).toBe(seed.userId);
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
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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

describe("overrides and audit", () => {
  test("a manually entered quotation must record why", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_000),
        source: "MANUAL",
      })
    ).rejects.toThrow(/must record why/i);
  });

  test("changing a recorded quotation logs the previous value, reason and user", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL",
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
    await seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
        source: "MANUAL",
        overrideReason: "Too late.",
      })
    ).rejects.toThrow(/already approved a purchase amount/i);
  });

  test("a manually approved purchase amount must record why", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    await expect(
      seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
    await seed.asUser.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
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
        source: "CALCULATED",
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
          source: "CALCULATED",
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

    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});

    const app = await readApp(seed, applicationId);
    expect(app.creditDecision).toBe("APPROVED");
    expect(app.handoverStatus).toBe("HANDED_OVER");
    expect(app.settlementStatus).toBe("FULLY_SETTLED");
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

  test("maps each legacy status to the right credit decision and handover state", async () => {
    const seed = await seedDealer();
    const pending = await seedLegacyApplication(seed, { status: "PENDING_DOCS" });
    const approved = await seedLegacyApplication(seed, { status: "APPROVED" });
    const cancelled = await seedLegacyApplication(seed, { status: "CANCELLED" });

    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});

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

    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});
    const afterFirst = await readApp(seed, legacyId);

    const second = await seed.t.mutation(
      internal.migrateFinancingEconomics.backfillFinancingEconomics,
      {}
    );

    expect(second.applicationsBackfilled).toBe(0);
    expect(second.applicationsSkipped).toBeGreaterThanOrEqual(2);
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

    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});
    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {});

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
    // Falls back to the only LTV a legacy company had, rather than none at all.
    expect(versions[0]?.snapshot.defaultLtvPercent).toBe(80);
  });
});
