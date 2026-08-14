import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import {
  CORRECTED_APPROVAL_SEQUENCE,
  EXPENSE_ONLY_QUOTATION_CORRECTION,
  withoutRuntimeIdentity,
} from "../test-utils/fixtures/correctionHistory";

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

/**
 * A baseline recorded as MANUAL_ENTRY, for cases that go on to move an input
 * the solver reads.
 *
 * `recordBaselineQuotation` records SYSTEM_CALCULATED, which the server refuses
 * to accept once the figure no longer equals what the calculator produces — so
 * a case that changes the expenses cannot re-record under that label without
 * also changing the amount, and would then be proving something else.
 */
async function recordManualBaseline(
  seed: Seed,
  applicationId: Id<"financeApplications">
): Promise<void> {
  await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: seed.orgId,
    applicationId,
    submittedQuotationMinor: jod(DEAL.quotation),
    source: "MANUAL_ENTRY",
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

/**
 * The override rows AS STORED, newest first.
 *
 * Read from the table rather than off `getEconomics`, because these assertions
 * are about the AUDIT RECORD — that a change left a trace, and what that trace
 * says. The query returns a presentation projection instead: the stored strings
 * embed the whole decision (`"150000000 (MANUAL @ 85% LTV, approved by pd78…)"`)
 * and shipping that to a screen showed a raw minor-unit integer and an internal
 * user id, so the query now extracts the figure and drops the prose. The prose
 * is still the audit trail, and this is where it is checked.
 */
async function readOverrides(seed: Seed, applicationId: Id<"financeApplications">) {
  const rows = await seed.t.run((ctx) =>
    ctx.db
      .query("financeApplicationOverrides")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .collect()
  );
  // Same tiebreak the query uses. Two corrections can share a millisecond, and
  // sorting on `changedAt` alone made "which came first" a coin toss — in the
  // assertions as much as on the screen.
  return rows.sort((a, b) => b.changedAt - a.changedAt || b._creationTime - a._creationTime);
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

describe("a manually named approval", () => {
  /**
   * MANUAL exists for a figure the finance company named independently of any
   * appraisal — by phone, at a third number. Adopting the appraisal on file
   * anyway wrote a self-contradictory record: basis MANUAL, and beside it a
   * link to evidence the amount was explicitly not based on, with that
   * evidence's own status flipped to APPROVED.
   *
   * Unreachable in production until SCRUM-68: `approveDealerPurchaseAmount`
   * had no caller outside tests, and the tests that exercised this path only
   * asserted on the override log.
   */
  test("does not adopt or approve an appraisal it was not based on", async () => {
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

    // A third figure: not the appraisal, not the quotation.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_200),
      basis: "MANUAL",
      notes: "Approved at 12,200 by the branch credit officer, over the phone.",
    });

    const after = await readApp(seed, applicationId);
    expect(after.approvedDealerPurchaseAmountMinor).toBe(jod(12_200));
    expect(after.approvedPurchaseBasis).toBe("MANUAL");
    // The record must not claim an appraisal basis it does not have.
    expect(after.approvedPurchaseAppraisalId).toBeUndefined();

    const appraisals = await seed.t.run((ctx) =>
      ctx.db
        .query("financeAppraisals")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    // Nor may it mark the finance company's appraisal as the one approved.
    expect(appraisals[0]?.status).toBe("RECORDED");
  });

  /**
   * The appraisal has TWO roles, and they are not the same role.
   *
   * One is EVIDENCE of what the approval was based on — that is the basis, and a
   * manually named amount has none. The other is the LTV BASE: for a company
   * whose rule multiplies the appraisal rather than the approved amount, the
   * funding split cannot be computed without it, whatever the basis says.
   *
   * Dropping the appraisal entirely under MANUAL conflated the two and cost the
   * second: `deriveEconomics` could not resolve an LTV base, so the funding
   * split was blanked and the deal flagged for reconciliation — and SCRUM-61's
   * guard refuses handover and finalization when
   * `financeCompanyFundedPortionMinor` is undefined. A legitimate third,
   * manually approved figure became unfinishable.
   */
  test("keeps the appraisal as the LTV BASE for a company that lends against it", async () => {
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
      customerFirstPaymentOffsetsUnfinancedShare: true,
      ltvBasis: "INDEPENDENT_APPRAISAL",
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
      approvedAmountMinor: jod(12_200),
      basis: "MANUAL",
      notes: "Approved at 12,200 by the branch credit officer, over the phone.",
    });

    const after = await readApp(seed, applicationId);
    // The BASIS is still what the operator said it was...
    expect(after.approvedPurchaseBasis).toBe("MANUAL");
    // ...and the funding split is still computable, because the company's rule
    // needs the appraisal as its base and one is on file.
    expect(after.financeCompanyFundedPortionMinor).not.toBeUndefined();
    expect(after.needsFinancingReconciliation).not.toBe(true);

    const appraisals = await seed.t.run((ctx) =>
      ctx.db
        .query("financeAppraisals")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    // Used as a base, NOT endorsed as the approval's evidence. Flipping it to
    // APPROVED would claim the company approved against it, which is the thing
    // the MANUAL basis says did not happen.
    expect(appraisals[0]?.status).toBe("RECORDED");
    // ...and the APPLICATION's own dimension must not say otherwise. Adopting
    // the appraisal as an LTV base made this claim FINALIZED, so the row said
    // "never approved against" while the application said "concluded" about the
    // same event — two records disagreeing, which is the class of defect this
    // whole area keeps producing when one field is asked to mean three things.
    expect(after.appraisalStatus).not.toBe("FINALIZED");
  });

  test("still honours an appraisal the caller names explicitly", async () => {
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
    const appraisalId = (
      await seed.t.run((ctx) =>
        ctx.db
          .query("financeAppraisals")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      )
    )[0]._id;

    // The control: not-auto-resolving must not become can-never-link.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(12_200),
      basis: "MANUAL",
      appraisalId,
      notes: "Approved above their own appraisal, which is on file.",
    });

    const after = await readApp(seed, applicationId);
    expect(after.approvedPurchaseAppraisalId).toBe(appraisalId);
    // The named path shares the status guard with the auto-resolved one, and
    // only the other test covered it — so a future edit that special-cased the
    // two could reopen this one silently.
    const appraisals = await seed.t.run((ctx) =>
      ctx.db
        .query("financeAppraisals")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    expect(appraisals[0]?.status).toBe("RECORDED");
    expect(after.appraisalStatus).not.toBe("FINALIZED");
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
    ).rejects.toThrow(/rounds to zero/i);
  });

  test("rejects a per-deal LTV too small to survive the engine's precision", async () => {
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

    // The settings door was closed; this is the per-deal door. Positive, so it
    // passes the > 0 check, then scales to zero inside the engine — which would
    // fund nothing and silently make the dealer contribution the ENTIRE
    // approved purchase amount, with no throw and no reconciliation flag.
    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(12_500),
        basis: "APPRAISAL",
        appliedLtvPercent: 0.0000004,
      })
    ).rejects.toThrow(/rounds to zero/i);

    const app = await readApp(seed, applicationId);
    expect(app.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(app.dealerContributionMinor).toBeUndefined();
  });

  test("accepts the smallest percentage the engine can still represent", async () => {
    const seed = await seedDealer();
    // 0.0000005 is the boundary: it rounds UP to 1 at six decimals, so it
    // survives the arithmetic. The old message promised 0.000001% as the
    // minimum, which was twice the truth — the kind of drift that comes from
    // restating a scale instead of asking the engine for it.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 0.0000005,
    });
    const company = await seed.t.run((ctx) => ctx.db.get(seed.companyId));
    expect(company?.defaultLtvPercent).toBe(0.0000005);
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
    const after = await readApp(seed, applicationId);
    expect(after.handoverStatus).toBe("READY");

    // A re-approval after the approval was CLEARED must re-stamp. The only
    // thing that makes it do so is the `approvedPurchaseApprovedAt === undefined`
    // fallback beside the conditional stamp — so if a later edit preserves the
    // approver in either clear-list "for history", every subsequent approval
    // would silently keep the previous approver and timestamp with the whole
    // suite still green.
    expect(after.approvedPurchaseApprovedAt).toBeDefined();
    expect(after.approvedPurchaseApprovedBy).toBe(seed.approverId);
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
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain("MANUAL");
  });

  test("records an approval that changes only its LTV", async () => {
    const { seed, applicationId } = await seedApproved();
    const before = await readApp(seed, applicationId);
    expect(before.appliedLtvPercent).toBe(DEAL.ltvPercent);

    // Identical amount, basis, appraisal and notes. Only the LTV moves — and
    // the LTV is what the funded portion, the dealer contribution and the
    // expected remittance are all derived from, so this rewrites every money
    // figure on the deal.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
      appliedLtvPercent: 80,
    });

    const after = await readApp(seed, applicationId);
    expect(after.appliedLtvPercent).toBe(80);
    expect(after.financeCompanyFundedPortionMinor).not.toBe(
      before.financeCompanyFundedPortionMinor
    );

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    // The row has to say which input moved. "11500 → 11500" reads as a no-op.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain("85% LTV");
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain("80% LTV");
  });

  test("a second approver re-submitting an identical approval leaves a trace", async () => {
    const { seed, applicationId } = await seedApproved();
    const first = await readApp(seed, applicationId);
    expect(first.approvedPurchaseApprovedBy).toBe(seed.approverId);

    // A third member re-submits byte-identical arguments — a double-submit, a
    // retry after a dropped connection, or a colleague confirming.
    const secondApproverId = await seed.t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "econ_approver2_1",
        email: "econ.approver2@example.com",
        name: "Second Approver",
      })
    );
    const roleId = await seed.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", seed.orgId))
        .first();
      return membership!.roleId;
    });
    await seed.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: seed.orgId, userId: secondApproverId, roleId })
    );

    await seed.t
      .withIdentity({ subject: "econ_approver2_1" })
      .mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(11_500),
        basis: "APPRAISAL",
      });

    // The approver of record moved, so the separation-of-duties evidence for a
    // money decision changed. Keying the audit on the compared values alone
    // recorded none of it.
    const after = await readApp(seed, applicationId);
    expect(after.approvedPurchaseApprovedBy).toBe(secondApproverId);
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    // A row is not a trace. Asserting only its existence passed on a row whose
    // previousValue and newValue were the identical string, leaving the prior
    // approver as unrecoverable as before — this table is the only history.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(seed.approverId));
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain(String(secondApproverId));
  });

  test("the same approver re-submitting does not advance the approval timestamp", async () => {
    const { seed, applicationId } = await seedApproved();
    const first = await readApp(seed, applicationId);

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_500),
      basis: "APPRAISAL",
    });

    // A retry is not a new decision. Advancing the stamp made "when was this
    // approved" answer the retry instead of the approval.
    const after = await readApp(seed, applicationId);
    expect(after.approvedPurchaseApprovedAt).toBe(first.approvedPurchaseApprovedAt);
    expect(after.approvedPurchaseApprovedBy).toBe(first.approvedPurchaseApprovedBy);
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(0);
  });

  /**
   * The correction that actually happened in production, end to end.
   *
   * A manager recorded 150,000 JOD against a ~12,500 deal, reopened it, and put
   * 15,000 back. The audit table came out of that holding ONE row — the
   * withdrawal — because `approvalMateriallyChanged` requires the field to
   * already be set, and `reopenApproval` clears it. So the history recorded that
   * 150,000 was taken off the record and never that 15,000 replaced it, who
   * recorded it, or when. A history missing the replacement cannot explain the
   * deal, which is the only thing it exists to do.
   *
   * Through the real writers, deliberately: the projection this feeds is only
   * worth testing against rows the server genuinely emits.
   */
  test("a correction records the replacement, not only the withdrawal", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // A figure unlike anything on this deal — acknowledged, because AutoFlow
    // challenges it but is not entitled to refuse the finance company's number.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(150_000),
      basis: "MANUAL",
      notes: "Read off the advice note.",
      outlierAcknowledged: true,
    });
    // The FIRST approval is not a correction. Nothing was replaced, and
    // approvedPurchaseApprovedBy/At already record who and when — a row here
    // would put a correction entry on every healthy deal.
    expect(await readOverrides(seed, applicationId)).toHaveLength(0);

    await seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
      orgId: seed.orgId,
      applicationId,
      reason: "The amount entered was wrong.",
    });

    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(15_000),
      basis: "MANUAL",
      notes: "Recorded the amount the company actually approved.",
    });

    const rows = await readOverrides(seed, applicationId);
    // TWO events: the withdrawal and the replacement. One is the defect.
    expect(rows).toHaveLength(2);

    const [replacement, withdrawal] = rows;
    expect(withdrawal?.newValue).toBe("reopened");
    expect(withdrawal?.previousValue).toContain(String(jod(150_000)));

    // The replacement names the new amount, its actor and its time — the three
    // facts the withdrawal row cannot carry.
    expect(replacement?.field).toBe("approvedDealerPurchaseAmountMinor");
    expect(replacement?.newValue).toContain(String(jod(15_000)));
    expect(replacement?.changedBy).toBe(seed.approverId);
    expect(replacement?.changedAt).toBeGreaterThanOrEqual(withdrawal!.changedAt);
    expect(replacement?.reason).toBe("Recorded the amount the company actually approved.");
    // Nothing was on record to move FROM: the withdrawal already said what left.
    expect(replacement?.previousValue).toBeUndefined();

    // And the deal itself carries the corrected figure, so the history is
    // explaining a real change rather than describing one that did not land.
    expect((await readApp(seed, applicationId)).approvedDealerPurchaseAmountMinor).toBe(
      jod(15_000)
    );

    // The sequence reaches the screen in the order it happened. These two rows
    // are written a moment apart and routinely share a millisecond, so ordering
    // on `changedAt` alone printed the replacement above the withdrawal about as
    // often as not — and a history out of order is not a history.
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides.map((entry) => entry.event)).toEqual([
      "CORRECTED",
      "WITHDRAWN",
    ]);
    expect(economics.overrides[0]?.newAmountMinor).toBe(jod(15_000));
    // Nothing was on record to move FROM once it had been withdrawn.
    expect(economics.overrides[0]?.previousAmountMinor).toBeUndefined();
    expect(economics.overrides[1]?.previousAmountMinor).toBe(jod(150_000));
    expect(economics.overrides[1]?.newAmountMinor).toBeUndefined();

    // And this whole projection is what the cockpit's history tests render.
    // Pinning it here is what stops those tests proving anything about a screen
    // the server cannot produce — which is exactly what they did when the rows
    // they rendered were written by hand.
    expect(economics.overrides.map(withoutRuntimeIdentity)).toEqual(
      CORRECTED_APPROVAL_SEQUENCE.map(withoutRuntimeIdentity)
    );
  });

  /**
   * The other way an approval leaves the record: superseded by new evidence.
   *
   * Same defect, different door — `recordAppraisal` clears the approved amount
   * when a new appraisal invalidates it, so the approval that follows was
   * equally unrecorded.
   */
  test("an approval replacing one a new appraisal withdrew is recorded too", async () => {
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

    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_000),
      providerType: "FINANCE_COMPANY",
      appraisedAt: Date.now(),
      reappraisalReason: "Company re-inspected the vehicle.",
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_000),
      basis: "APPRAISAL",
    });

    const rows = await readOverrides(seed, applicationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.newValue).toBe("cleared");
    expect(rows[0]?.newValue).toContain(String(jod(11_000)));
    expect(rows[0]?.changedBy).toBe(seed.approverId);
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

    const flagged = await seed.asUser.query(
      api.financingEconomics.listNeedingReconciliation,
      { orgId: seed.orgId, paginationOpts: { cursor: null, numItems: 20 } }
    );
    expect(flagged.page).toHaveLength(1);
    expect(flagged.page[0]?._id).toBe(applicationId);
    expect(flagged.page[0]?.financingReconciliationReason).toBe(
      "Legacy figures need checking."
    );

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
      (
        await seed.asUser.query(api.financingEconomics.listNeedingReconciliation, {
          orgId: seed.orgId,
          paginationOpts: { cursor: null, numItems: 20 },
        })
      ).page
    ).toHaveLength(0);
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides.some((o) => o.subject === "RECONCILIATION_FLAG")).toBe(true);
  });
});

/**
 * A real salesperson: the default SALES template, not the owner role the seed
 * hands out. Module-scoped because two describes need it — the permission cases
 * below, and the LTV-authority cases, where the whole question is what a role
 * that is NOT an approver may establish about a deal's economics.
 */
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

describe("permissions", () => {
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

  test("reports an unconfigured LTV as an unavailable calculation, not as a thrown error", async () => {
    const seed = await seedDealer();
    const { applicationId } = await createUnconfiguredLtvApplication(seed);

    // This query answers "is there a figure to suggest, and if not why" — a
    // shape it already has for two other unsolvable cases. Throwing instead
    // put a Convex stack trace where the deal cockpit should be: `useQuery`
    // throws during render, which loses the WHOLE screen rather than one
    // suggestion. Its sibling `suggestQuotation` keeps its throw; that one is
    // called from the wizard with caller-supplied inputs, not mounted beside a
    // screen it can take down.
    const suggestion = await seed.asUser.query(
      api.financingEconomics.suggestQuotationForApplication,
      { orgId: seed.orgId, applicationId }
    );
    expect(suggestion.available).toBe(false);
    expect(suggestion.reason).toMatch(/LTV/i);
  });

  /**
   * An application snapshots its company's rules at creation and never re-reads
   * them — deliberately, so editing a company next month cannot rewrite a deal
   * it already governs. The consequence is that a deal created while the
   * company had no purchase rate CANNOT be repaired by adding one in settings:
   * the frozen snapshot still has none, and telling the operator to go to
   * settings is a recovery instruction that cannot recover this deal.
   *
   * The supported repair is per-deal: `recordSubmittedQuotation` accepts an
   * explicit `ltvPercent`, `resolveAppliedLtv` honours it over the (absent)
   * default within the snapshot's own bounds, and it is stored on the
   * application as `appliedLtvPercent` — so the deal moves without anyone
   * rewriting its immutable rule snapshot.
   */
  test("a deal created before its company had a purchase rate is repaired per-deal, not by the settings edit", async () => {
    const seed = await seedDealer();
    const { bareCompanyId, applicationId } = await createUnconfiguredLtvApplication(seed);

    // The operator does exactly what the old copy told them to.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: bareCompanyId,
      orgId: seed.orgId,
      name: "Unconfigured Finance Co",
      profitRate: 6,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 100,
      defaultLtvPercent: 90,
    });

    // ...and this deal is exactly as stuck as before, because its snapshot is
    // frozen. This half must keep passing: the immutability is the point.
    const stillFrozen = await readApp(seed, applicationId);
    expect(stillFrozen.companyRuleSnapshot?.defaultLtvPercent).toBeUndefined();
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_000),
        source: "MANUAL_ENTRY",
      })
    ).rejects.toThrow(/No LTV is configured/i);

    // The supported repair: name the rate that applies to THIS deal.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
      ltvPercent: 90,
    });

    const repaired = await readApp(seed, applicationId);
    expect(repaired.submittedQuotationMinor).toBe(jod(13_000));
    expect(repaired.appliedLtvPercent).toBe(90);
    // The snapshot is still untouched — the deal was repaired, not rewritten.
    expect(repaired.companyRuleSnapshot?.defaultLtvPercent).toBeUndefined();
  });

  /**
   * A deal frozen under a company that carried no purchase rate. The setup the
   * two authority cases below both need.
   */
  async function createUnconfiguredLtvApplication(seed: Seed): Promise<{
    bareCompanyId: Id<"financeCompanies">;
    applicationId: Id<"financeApplications">;
  }> {
    const bareCompanyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Unconfigured Finance Co",
        profitRate: 6,
        maxTermMonths: 48,
        gracePeriodMonths: 0,
        maxFinancingLTV: 100,
        isActive: true,
      })
    );
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerId,
      vehicleId: seed.vehicleId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: bareCompanyId,
      vehiclePrice: DEAL.targetSelling,
      downPayment: DEAL.customerFirstPayment,
      termMonths: 48,
      totalFinancedAmount: 10_736,
    });
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    return { bareCompanyId, applicationId };
  }

  /**
   * Recording the quotation is a transcription — "this is the figure we sent" —
   * and the SALES template may do it. Naming the rate the deal is financed at is
   * NOT: `appliedLtvPercent` drives the finance company's funded portion, the
   * unfinanced portion and therefore the dealership's own contribution, so a
   * salesperson who could set it could move the dealer's money by typing a
   * different number into a field beside the amount.
   *
   * The owner's ruling, recorded on SCRUM-68: the exceptional per-deal rate
   * requires `approve:finance_application`. The ordinary path — a company whose
   * rate is configured, a salesperson recording what was sent — is untouched,
   * and the case below proves that too.
   */
  test("SALES cannot establish the missing per-deal LTV; an approver can, and then SALES may quote at it", async () => {
    const seed = await seedDealer();
    const { applicationId } = await createUnconfiguredLtvApplication(seed);
    const asSales = await addSalesUser(seed);

    await expect(
      asSales.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_000),
        source: "MANUAL_ENTRY",
        ltvPercent: 90,
      })
    // The guard's OWN wording. `/approve/i` also matches the generic tenant-auth
    // refusal "Missing required permissions: approve:finance_application", so a
    // later change that moved this mutation behind a different permission would
    // leave the test green while it proved a different rule.
    ).rejects.toThrow(/may set the LTV this deal is financed at/i);

    // Refused BEFORE anything was written — not refused after recording the
    // quotation and leaving the rate behind, which would be the worse failure.
    const untouched = await readApp(seed, applicationId);
    expect(untouched.appliedLtvPercent).toBeUndefined();
    expect(untouched.submittedQuotationMinor).toBeUndefined();

    // The manager names the rate the financing was arranged at.
    await seed.asApprover.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
      ltvPercent: 90,
    });
    expect((await readApp(seed, applicationId)).appliedLtvPercent).toBe(90);

    // Once it is established, the deal is an ordinary one again: the
    // salesperson re-records the quotation at the SAME rate without needing an
    // approver, because that rate is no longer their decision to make.
    await asSales.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_400),
      source: "MANUAL_ENTRY",
      ltvPercent: 90,
    });
    const requoted = await readApp(seed, applicationId);
    expect(requoted.submittedQuotationMinor).toBe(jod(13_400));
    expect(requoted.appliedLtvPercent).toBe(90);
  });

  test("SALES may record a quotation under a configured rate, but not at a different one", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    const asSales = await addSalesUser(seed);

    // Departing from the company's configured rate moves exactly the same
    // money as filling in an absent one, so it needs the same authority.
    await expect(
      asSales.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(DEAL.quotation),
        source: "MANUAL_ENTRY",
        ltvPercent: 70,
      })
    // The guard's OWN wording. `/approve/i` also matches the generic tenant-auth
    // refusal "Missing required permissions: approve:finance_application", so a
    // later change that moved this mutation behind a different permission would
    // leave the test green while it proved a different rule.
    ).rejects.toThrow(/may set the LTV this deal is financed at/i);

    // The ordinary path is untouched: no rate argument, the snapshot's own rate
    // applies, and the salesperson records what was sent.
    await asSales.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
    });
    const recorded = await readApp(seed, applicationId);
    expect(recorded.submittedQuotationMinor).toBe(jod(DEAL.quotation));
    expect(recorded.appliedLtvPercent).toBe(DEAL.ltvPercent);
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

  /**
   * The same two rules `approveDealerPurchaseAmount` already keeps for its own
   * approver, which this writer did not.
   *
   * Both matter now in a way they did not before: until SCRUM-68 this mutation
   * had no caller outside tests, so no operator could reach either case. The
   * cockpit's recorder makes both ordinary — a retry after an uncertain
   * response, and a colleague re-entering the same figure from the same
   * paperwork.
   */
  test("a second person re-recording an identical quotation cannot become its author silently", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const before = await readApp(seed, applicationId);
    expect(before.submittedQuotationBy).toBe(seed.userId);

    // Byte-identical, by a different permitted user.
    await seed.asApprover.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "SYSTEM_CALCULATED",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const after = await readApp(seed, applicationId);
    expect(after.submittedQuotationBy).toBe(seed.approverId);

    // Who sent the finance company its quotation is the provenance of a real
    // external document. Rewriting it with no row left the original recorder
    // unrecoverable — this table is the only history.
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    // A row is not a trace if both sides read the same. Same lesson the
    // approver audit next door had to learn.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(seed.userId));
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain(String(seed.approverId));
  });

  test("the same person re-recording an identical quotation does not advance its timestamp", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    const first = await readApp(seed, applicationId);

    await recordBaselineQuotation(seed, applicationId);

    // A retry is not a new submission. Advancing the stamp made "when did we
    // send this quotation" answer the retry instead of the send.
    const after = await readApp(seed, applicationId);
    expect(after.submittedQuotationAt).toBe(first.submittedQuotationAt);
    expect(after.submittedQuotationBy).toBe(first.submittedQuotationBy);
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(0);
  });

  test("an identical retry does not restamp the calculation snapshot either", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    const first = await readApp(seed, applicationId);

    await recordBaselineQuotation(seed, applicationId);

    // Holding the top-level stamp while the snapshot's own `recordedAt` crept
    // forward left two provenance fields answering the same question
    // differently. A retry rewrites nothing.
    const after = await readApp(seed, applicationId);
    expect(after.quotationCalculationSnapshot?.recordedAt).toBe(
      first.quotationCalculationSnapshot?.recordedAt
    );
  });

  test("changing a calculation input at the same amount is a change, and is audited", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(300),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    // Same amount, same source, same person — but the expenses behind it moved,
    // and those feed the derived economics. Comparing only the four headline
    // fields let that through with no row and no new stamp.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(900),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    // A ROW IS NOT A TRACE. Asserting only the count passed on a row whose two
    // value fields read identically and whose reason claimed a source/recorder
    // change that never happened — while the patch overwrote the old inputs, so
    // the cause of every moved derived figure was unrecoverable.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(jod(300)));
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain(String(jod(900)));
    expect(economics.overrides[0]?.reason).toMatch(/expenses/i);
    expect(economics.overrides[0]?.reason).not.toMatch(/source|recorder/i);
    expect((await readApp(seed, applicationId)).estimatedDealerBorneExpensesMinor).toBe(jod(900));
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

  test("an unrecorded offset rule is unavailable, not assumed", async () => {
    const seed = await seedDealer();
    // Unset, not false. This is the state of every finance company that existed
    // before this PR — `buildRuleSnapshot` applies no default to it on purpose —
    // so it is the common case in production and needs the same end-to-end
    // proof as the explicit `false` above, which is a deliberate answer.
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.companyId, {
        customerFirstPaymentOffsetsUnfinancedShare: undefined,
      })
    );

    const applicationId = await createApplication(seed);
    const suggestion = await seed.asUser.query(api.financingEconomics.suggestQuotation, {
      orgId: seed.orgId,
      companyId: seed.companyId,
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });
    expect(suggestion.available).toBe(false);
    if (suggestion.available) throw new Error("expected the solver to be unavailable");
    expect(suggestion.reason).toBe("OFFSET_RULE_UNKNOWN");

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(12_500),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
    });

    const snapshot = (await readApp(seed, applicationId)).quotationCalculationSnapshot;
    expect(snapshot?.calculatedQuotationMinor).toBeUndefined();
    expect(snapshot?.solverUnavailableReason).toBe("OFFSET_RULE_UNKNOWN");
  });

  test("SYSTEM_CALCULATED cannot be claimed for a figure the solver did not produce", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // Same inputs that produce 12,500, but a different amount submitted under
    // the label that says a human did not touch it. Departing is allowed; it
    // just has to be called an override and say why.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_200),
        source: "SYSTEM_CALCULATED",
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/calculator produced/i);

    // Nothing was written: the label and the amount contradict each other, so
    // there is no version of this record worth keeping.
    expect((await readApp(seed, applicationId)).submittedQuotationMinor).toBeUndefined();

    // The same amount, honestly labelled, is accepted.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_200),
      source: "CALCULATED_WITH_OVERRIDE",
      overrideReason: "The company asked for a higher figure to cover its fees.",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });
    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBe(jod(13_200));
    expect(app.quotationCalculationSnapshot?.calculatedQuotationMinor).toBe(jod(DEAL.quotation));
  });

  test("SYSTEM_CALCULATED is refused when the solver never ran", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // No target selling amount anywhere, so there was no calculation to be the
    // source of. Recording it as the system's own figure would put a provenance
    // claim on a number a person typed.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(12_500),
        source: "SYSTEM_CALCULATED",
      })
    ).rejects.toThrow(/no target selling amount/i);
  });

  test("CALCULATED_WITH_OVERRIDE cannot claim a departure from a calculation that never ran", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // Guarding only SYSTEM_CALCULATED left this door open: supply any reason
    // and the snapshot records a calculated departure with no calculated
    // figure to have departed from.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_200),
        source: "CALCULATED_WITH_OVERRIDE",
        overrideReason: "The company asked for more.",
      })
    ).rejects.toThrow(/no target selling amount/i);

    // And when the solver ran but could not produce a figure. Patched on the
    // application's own rule snapshot, not the company: the snapshot is what
    // governs a deal in flight, which is the whole reason it is taken.
    const app = await readApp(seed, applicationId);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        companyRuleSnapshot: {
          ...app.companyRuleSnapshot!,
          customerFirstPaymentOffsetsUnfinancedShare: undefined,
        },
      })
    );
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(13_200),
        source: "CALCULATED_WITH_OVERRIDE",
        overrideReason: "The company asked for more.",
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/OFFSET_RULE_UNKNOWN/);

    expect((await readApp(seed, applicationId)).submittedQuotationMinor).toBeUndefined();
  });

  test("the suggestion for an existing deal is the figure the guard accepts, after the company moves on", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // The company is edited after the deal snapshotted its rules — a new LTV,
    // a new rule version. The deal is still governed by the old snapshot.
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: seed.companyId,
      orgId: seed.orgId,
      name: "Jordan Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 90,
      defaultLtvPercent: 90,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });

    const inputs = {
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    };

    // The company-scoped query answers under the LIVE company — 90% now.
    const liveSuggestion = await seed.asUser.query(api.financingEconomics.suggestQuotation, {
      orgId: seed.orgId,
      companyId: seed.companyId,
      ...inputs,
    });
    // The application-scoped one answers under the deal's own snapshot — 85%.
    const dealSuggestion = await seed.asUser.query(
      api.financingEconomics.suggestQuotationForApplication,
      { orgId: seed.orgId, applicationId, ...inputs }
    );
    if (!liveSuggestion.available || !dealSuggestion.available) {
      throw new Error("expected both suggestions to be available");
    }
    expect(dealSuggestion.appliedLtvPercent).toBe(DEAL.ltvPercent);
    expect(liveSuggestion.submittedQuotationMinor).not.toBe(
      dealSuggestion.submittedQuotationMinor
    );

    // Posting the LIVE figure as SYSTEM_CALCULATED is refused — the wizard
    // showing it was reading the wrong rules.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: liveSuggestion.submittedQuotationMinor,
        source: "SYSTEM_CALCULATED",
        ...inputs,
      })
    ).rejects.toThrow(/calculator produced/i);

    // The application-scoped figure is accepted. That is the property worth
    // pinning: what the user is shown is what the guard takes.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: dealSuggestion.submittedQuotationMinor,
      source: "SYSTEM_CALCULATED",
      ...inputs,
    });
    expect((await readApp(seed, applicationId)).submittedQuotationMinor).toBe(
      dealSuggestion.submittedQuotationMinor
    );
  });

  test("an override that matches the calculated figure is not an override", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // A reason explaining a difference that does not exist is worse than no
    // reason: it puts a departure on the record that never happened.
    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(DEAL.quotation),
        source: "CALCULATED_WITH_OVERRIDE",
        overrideReason: "Rounded up for the company.",
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/matches the calculated figure/i);
  });

  test("SYSTEM_CALCULATED is refused when the company's offset rule is unrecorded", async () => {
    const seed = await seedDealer();
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.companyId, {
        customerFirstPaymentOffsetsUnfinancedShare: undefined,
      })
    );
    const applicationId = await createApplication(seed);

    await expect(
      seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seed.orgId,
        applicationId,
        submittedQuotationMinor: jod(12_500),
        source: "SYSTEM_CALCULATED",
        targetSellingAmountMinor: jod(DEAL.targetSelling),
        estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
        customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      })
    ).rejects.toThrow(/OFFSET_RULE_UNKNOWN/);
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
    // Read from the TABLE: `changedBy` is an internal id and no longer leaves
    // the server — the projection carries the person's NAME instead, because an
    // id on screen tells an operator nothing. The actor is still audited, and
    // this is where that is checked.
    expect((await readOverrides(seed, applicationId))[0]).toMatchObject({
      field: "submittedQuotationMinor",
      changedBy: seed.userId,
    });
    // The row names the mode alongside the figure, because the mode is rewritten
    // by the same patch and has no history of its own.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(jod(12_500)));
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain(String(jod(13_000)));
    expect(economics.overrides[0]?.reason).toMatch(/revised quotation/);
  });

  test("audits a same-amount re-record that changes only the source and reason", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    // An override at 13,200 with a reason on the record.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_200),
      source: "CALCULATED_WITH_OVERRIDE",
      overrideReason: "The company asked for a higher figure to cover its own fee.",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    // Re-recorded at the SAME amount as a plain manual entry with no reason.
    // Convex deletes a field patched to an explicit undefined, so this erases
    // submittedQuotationOverrideReason, flips the mode, rewrites the recorder
    // and timestamp, and replaces the calculation snapshot — none of which has
    // a history table. Keying the audit on the amount alone recorded none of it.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_200),
      source: "MANUAL_ENTRY",
    });

    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationOverrideReason).toBeUndefined();
    expect(app.submittedQuotationSource).toBe("MANUAL_ENTRY");

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain("CALCULATED_WITH_OVERRIDE");
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain("cover its own fee");
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain("MANUAL_ENTRY");
  });

  /**
   * A row whose two target fields have drifted apart, which the audit must
   * describe honestly in BOTH directions.
   *
   * The mutation writes `targetSellingAmountMinor` and `targetNetProceedsMinor`
   * together from one argument, so they agree on every row this code can create
   * — the divergence below is seeded directly, because that is the only shape
   * legacy data could have arrived in and the whole purpose of an audit trail is
   * the rows nobody can produce any more.
   *
   * Both reviewers found a defect here, in opposite directions, one round apart:
   * comparing the SELLING field against a value that falls back to the NET one
   * reported a move that never happened when the argument was omitted; comparing
   * the NET field reported no move when an explicit argument moved the selling
   * field to the net field's value. Each field is now compared against its own
   * previous value, which is right in both cases and needs no third guess.
   */
  test("records the target move on a row whose selling and net-proceeds figures had drifted apart", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const recorded = await readApp(seed, applicationId);
    expect(recorded.targetSellingAmountMinor).toBe(jod(DEAL.targetSelling));
    expect(recorded.targetNetProceedsMinor).toBe(jod(DEAL.targetSelling));

    // Legacy shape: the two fields no longer agree.
    const driftedNetProceeds = jod(11_000);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { targetNetProceedsMinor: driftedNetProceeds })
    );

    // The same quotation, same source, same recorder — and an explicit target
    // equal to the DRIFTED net figure. The only thing that moves is the selling
    // amount, from 10,500 to 11,000, and the patch below overwrites it.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: driftedNetProceeds,
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    const override = (await readOverrides(seed, applicationId))[0];
    // The figure it moved FROM has to survive, because the patch has just
    // overwritten it and there is no other history of that field anywhere.
    expect(override?.previousValue).toContain(String(jod(DEAL.targetSelling)));
    expect(override?.newValue).toContain(String(driftedNetProceeds));
    expect(override?.reason).toMatch(/target/i);
  });

  /**
   * The same drifted row, moving the OTHER field — which the gate above the
   * audit has to notice, not just the description below it.
   *
   * Supplying a target equal to the selling figure moves nothing on that field
   * and everything on the net-proceeds one, because the patch writes both. The
   * gate compared the argument against the selling field alone, so it saw no
   * change, wrote no override row, and the per-field description was never
   * reached: a persisted financial figure moved with no trace at all. Found by
   * Codex on the round that fixed the description, and pre-existing rather than
   * caused by it — the gate has always compared one of the two fields it writes.
   *
   * Everything else is held identical on purpose: same amount, same source,
   * same recorder, no reason. If any of those moved, `materiallyChanged` would
   * be true for a different reason and this would pass without proving anything.
   */
  test("audits a target that moves only the net-proceeds figure on a drifted row", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const driftedNetProceeds = jod(11_000);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { targetNetProceedsMinor: driftedNetProceeds })
    );

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "SYSTEM_CALCULATED",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    // The net-proceeds figure has been overwritten from 11,000 back to 10,500.
    expect((await readApp(seed, applicationId)).targetNetProceedsMinor).toBe(
      jod(DEAL.targetSelling)
    );

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(driftedNetProceeds));
    expect(economics.overrides[0]?.reason).toMatch(/net proceeds/i);
  });

  /**
   * The same two cases for the OTHER fanned-out pair.
   *
   * `estimatedDealerBorneExpensesMinor` writes both itself and
   * `estimatedClosingExpensesMinor`, and carried the identical gate hole. It was
   * fixed by the shared table rather than by its own clause — which is worth
   * nothing unless the table is proved for this pair too. The round that
   * introduced the table exists because a rule maintained in two places drifted
   * three times; shipping the second pair on the strength of "same code path"
   * would be the same bet that lost those three times.
   */
  test("audits both expenses figures on a row where they had drifted apart", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    // MANUAL_ENTRY on both records: changing the expenses moves the solver's
    // own figure, and a SYSTEM_CALCULATED label is refused when it no longer
    // equals what the calculator produces. The provenance is not what this
    // case is about, and holding it identical keeps the expenses the only
    // thing that moved.
    await recordManualBaseline(seed, applicationId);

    const driftedClosing = jod(400);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { estimatedClosingExpensesMinor: driftedClosing })
    );

    // Moves the dealer-borne figure, and the closing figure from somewhere else
    // entirely. Everything else is held identical.
    const newExpenses = jod(900);
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: newExpenses,
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    // Both starting figures survive, because the patch has overwritten both.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(
      String(jod(DEAL.exampleDealerBorneExpenses))
    );
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(driftedClosing));
    expect(economics.overrides[0]?.reason).toMatch(/closing expenses/i);
  });

  test("audits an expenses change that moves only the closing figure", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    const driftedClosing = jod(400);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { estimatedClosingExpensesMinor: driftedClosing })
    );

    // Equal to the dealer-borne figure already on the row, so ONLY the closing
    // figure moves. The gate has to notice that, or a persisted number changes
    // with no audit row at all.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "SYSTEM_CALCULATED",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    expect((await readApp(seed, applicationId)).estimatedClosingExpensesMinor).toBe(
      jod(DEAL.exampleDealerBorneExpenses)
    );

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(driftedClosing));
    expect(economics.overrides[0]?.reason).toMatch(/closing expenses/i);
  });

  /**
   * The everyday case, pinned exactly rather than by `toContain`.
   *
   * Folding the expenses pair into the shared table made an ordinary expenses
   * change name both fields with the same figure — "expenses 300000, closing
   * expenses 300000" — where it had named one. That is one move described
   * twice, and no existing assertion noticed because they all match substrings.
   */
  test("names an ordinary expenses change once, not once per field it writes", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordManualBaseline(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(900),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides[0]?.reason).toBe("Re-recorded; changed: expenses.");
  });

  /**
   * The same everyday case for the target pair.
   *
   * The dedupe is shared, so both pairs would double-name an ordinary change if
   * it were ever removed — but only the expenses side had a test that noticed.
   * Removing the dedupe left 94 of 95 green, and the one failure was the
   * expenses case: a later edit that reintroduced double-naming on the target
   * side alone would have shipped with CI green. Found by Sonnet, which is
   * exactly the asymmetry this subsystem has now been bitten by three times —
   * except this time it was the tests that were asymmetric, not the rule.
   */
  test("names an ordinary target change once, not once per field it writes", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordManualBaseline(seed, applicationId);

    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(11_200),
      estimatedDealerBorneExpensesMinor: jod(DEAL.exampleDealerBorneExpenses),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides[0]?.reason).toBe("Re-recorded; changed: target.");
  });

  test("audits a recalculated quotation even when no reason is given", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // MANUAL_ENTRY, because that is what this actually is: a figure a person
    // entered with no reason attached. It was written as SYSTEM_CALCULATED,
    // which is now refused — the solver produces 12,500 from these inputs, and
    // the whole point of the mode is that it names where the number came from.
    // The behaviour under test is unchanged: no reason given, still audited.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(9_000),
      source: "MANUAL_ENTRY",
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0]?.subject).toBe("SUBMITTED_QUOTATION");
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(jod(12_500)));
    expect((await readOverrides(seed, applicationId))[0]?.newValue).toContain(String(jod(9_000)));
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

  /**
   * Puts a modern application into the one state that produced the defect: an
   * inline rule snapshot naming a version with no `financeCompanyRuleVersions`
   * row, and no link recorded. Reached in production when the company is edited
   * past that version before the migration runs, because the companies phase
   * writes a row for the CURRENT version only.
   */
  async function orphanTheRuleVersion(
    seed: Seed,
    applicationId: Id<"financeApplications">,
    orphanVersion = 7
  ): Promise<void> {
    const app = await readApp(seed, applicationId);
    if (!app.companyRuleSnapshot) throw new Error("expected a modern application");
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        companyRuleVersionId: undefined,
        companyRuleSnapshot: { ...app.companyRuleSnapshot!, ruleVersion: orphanVersion },
      })
    );
    // The company must actually have passed through that version. Orphaning an
    // application at a version AHEAD of its company is a different case, and
    // one the migration deliberately refuses — see the test below.
    await seed.t.run((ctx) => ctx.db.patch(seed.companyId, { ruleVersion: orphanVersion }));
  }

  test("accepts a continuation scheduled by the previous revision", async () => {
    const seed = await seedDealer();
    await seedLegacyApplication(seed, { status: "APPROVED" });

    // Exactly the report shape the previous deploy's scheduler would carry:
    // every counter it knew about, and none it did not. Convex runs a scheduled
    // function against whatever code is deployed when it fires, so a newly
    // required field here would fail argument validation and stop the chain
    // mid-migration — leaving the remaining applications unbackfilled and
    // still reading their company's rules live.
    vi.useFakeTimers();
    await seed.t.mutation(internal.migrateFinancingEconomics.backfillFinancingEconomics, {
      phase: "applications",
      report: {
        status: "SCHEDULED",
        companiesScanned: 3,
        companiesVersioned: 1,
        applicationsScanned: 2,
        applicationsBackfilled: 1,
        applicationsFlagged: 1,
        applicationsBoundToSnapshot: 1,
        applicationsSkipped: 0,
      },
    });
    await seed.t.finishAllScheduledFunctions(vi.runAllTimers);

    // The counter it did not carry is normalized rather than propagating NaN
    // through every later page.
    const report = await seed.t.mutation(
      internal.migrateFinancingEconomics.backfillFinancingEconomics,
      { phase: "applications" }
    );
    await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(Number.isFinite(report.applicationsUnlinked)).toBe(true);
  });

  test("recovers a rule version the company has already been edited past", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);

    await runMigration(seed.t);

    const app = await readApp(seed, applicationId);
    const versionId = app.companyRuleVersionId;
    if (!versionId) throw new Error("expected the rule version to have been linked");
    const version = await seed.t.run((ctx) => ctx.db.get(versionId));
    // Reconstructed from the deal's own inline copy, so it is exact rather than
    // inferred — the snapshot IS what the version row is meant to hold.
    expect(version?.version).toBe(7);
    expect(version?.snapshot.defaultLtvPercent).toBe(DEAL.ltvPercent);
    expect(version?.companyId).toBe(seed.companyId);
    expect(version?.orgId).toBe(seed.orgId);
    expect(app.financingBackfilledAt).toBeDefined();
  });

  test("leaves an application unmarked when its rule version cannot be linked", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    // Recovery needs a company to attribute the version to. Without one there
    // is nothing to reconstruct from that would not be manufactured history.
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));

    await runMigration(seed.t);

    const first = await readApp(seed, applicationId);
    // The defect was the opposite of this: the marker was written anyway, so
    // every later run read it and skipped the row before reaching the linking
    // code at all — the application stayed unbound permanently and silently
    // fell back to reading its company's rules live.
    expect(first.financingBackfilledAt).toBeUndefined();
    expect(first.companyRuleVersionId).toBeUndefined();
    expect(first.needsFinancingReconciliation).toBe(true);
    expect(first.financingReconciliationReason).toMatch(/no longer exists in this organization/i);

    // Still eligible on the next run rather than skipped forever.
    await runMigration(seed.t);
    expect((await readApp(seed, applicationId)).financingBackfilledAt).toBeUndefined();
  });

  test("clearing the queue item does not make an unlinkable deal invisible", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));
    await runMigration(seed.t);

    // A triager works the queue and clears the item, because the note asks for
    // something they cannot do. That writes `false`, not `undefined`.
    await seed.asUser.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: seed.orgId,
      applicationId,
      note: "The finance company record is gone; nothing to re-save.",
    });
    expect((await readApp(seed, applicationId)).needsFinancingReconciliation).toBe(false);

    // Testing the flag for `undefined` meant that single click hid a
    // permanently unlinkable deal for good — unbound AND invisible, the exact
    // outcome this branch exists to prevent, reached through the queue rather
    // than the marker.
    await runMigration(seed.t);
    const after = await readApp(seed, applicationId);
    expect(after.needsFinancingReconciliation).toBe(true);
    expect(after.financingBackfilledAt).toBeUndefined();
  });

  test("a cancelled deal stops being re-flagged, so 'or close it' is true", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));
    await runMigration(seed.t);
    expect((await readApp(seed, applicationId)).needsFinancingReconciliation).toBe(true);

    // The reason offers "or close it" as the way out. Without a terminal-state
    // guard that was false: closing changed nothing, the flag stayed up, and
    // every later run re-raised anything a triager cleared — the closed loop
    // relocated rather than broken.
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        status: "CANCELLED",
        needsFinancingReconciliation: false,
        financingReconciliationReason: undefined,
      })
    );

    await runMigration(seed.t);

    const after = await readApp(seed, applicationId);
    expect(after.needsFinancingReconciliation).toBe(false);
    expect(after.financingBackfilledAt).toBeDefined();
  });

  test("closing clears the queue item itself, without a second trip", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));
    await runMigration(seed.t);
    expect((await readApp(seed, applicationId)).needsFinancingReconciliation).toBe(true);

    // The triager does exactly what the note says — closes the deal — and
    // nothing else. Leaving the flag up made "or close it" a two-step exit
    // described as one: the row stayed in the queue carrying a reason that was
    // no longer true.
    await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

    await runMigration(seed.t);

    const after = await readApp(seed, applicationId);
    expect(after.needsFinancingReconciliation).toBe(false);
    expect(after.financingReconciliationReason).toBeUndefined();
    const queue = await seed.asUser.query(
      api.financingEconomics.listNeedingReconciliation,
      { orgId: seed.orgId, paginationOpts: { cursor: null, numItems: 20 } }
    );
    expect(queue.page).toHaveLength(0);

    // Cleared with a row, never silently — the flag's contract is that it is
    // reported on and not quietly dropped.
    const overrides = await seed.t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    expect(
      overrides.some((o) => o.field === "needsFinancingReconciliation")
    ).toBe(true);
  });

  test("a closed deal that moved money stays flagged rather than being abandoned", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));

    // Terminal, but it disbursed and finalized. Exempting every CLOSED row
    // regardless of money would abandon exactly the deal whose unresolved rules
    // somebody still needs told about — so the exemption matches
    // reconciliationReasonFor's test rather than status alone.
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, { status: "CLOSED", disbursedAt: Date.now() })
    );

    await runMigration(seed.t);

    const after = await readApp(seed, applicationId);
    expect(after.needsFinancingReconciliation).toBe(true);
    expect(after.financingBackfilledAt).toBeUndefined();
    // And the note does not tell them to close a deal that is already closed.
    expect(after.financingReconciliationReason).toMatch(/historical record/i);
  });

  test("tells the triager something they can actually do", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await orphanTheRuleVersion(seed, applicationId);
    await seed.t.run((ctx) => ctx.db.delete(seed.companyId));

    await runMigration(seed.t);

    // "Re-save the finance company" was impossible in the only state that
    // produces this: the company row is gone. An instruction that cannot be
    // carried out reads as actionable and wastes the one person who looked.
    const reason = (await readApp(seed, applicationId)).financingReconciliationReason ?? "";
    expect(reason).toMatch(/no longer exists in this organization/i);
    expect(reason).not.toMatch(/re-save the finance company/i);
  });

  test("refuses to manufacture a rule version the company never reached", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    const app = await readApp(seed, applicationId);
    // Version 7 on the deal, company still at 1 — the company never held these
    // rules at that version.
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        companyRuleVersionId: undefined,
        companyRuleSnapshot: { ...app.companyRuleSnapshot!, ruleVersion: 7 },
      })
    );

    await runMigration(seed.t);

    // Inserting one would be a landmine: by_company_version has no uniqueness
    // constraint and every reader takes .first(), so when updateCompany
    // eventually bumps the company to 7 it writes its own row and a brand-new
    // application could be handed THIS deal's historical terms instead.
    const manufactured = await seed.t.run((ctx) =>
      ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company_version", (q) =>
          q.eq("companyId", seed.companyId).eq("version", 7)
        )
        .collect()
    );
    expect(manufactured).toHaveLength(0);
    const after = await readApp(seed, applicationId);
    expect(after.companyRuleVersionId).toBeUndefined();
    expect(after.needsFinancingReconciliation).toBe(true);
    expect(after.financingReconciliationReason).toMatch(/ahead of/i);
  });
});

/**
 * The two guards that must live on the server — SCRUM-77.
 *
 * Both were raised independently by two adversarial reviewers against the
 * first cut of the correction workflow, which enforced them in the React card
 * alone. A mutation is reachable without the screen that fronts it, so a rule
 * that exists only in a component is not a rule about the data.
 */
describe("the correction workflow's guards are enforced by the server", () => {
  test("a salesperson who can approve still cannot reopen their OWN deal", async () => {
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
    // The realistic shape: an owner or manager who personally sells. They hold
    // `approve:finance_application` AND are the application's salesperson.
    await seed.t.run((ctx) => ctx.db.patch(applicationId, { salespersonId: seed.approverId }));

    await expect(
      seed.asApprover.mutation(api.financingEconomics.reopenApproval, {
        orgId: seed.orgId,
        applicationId,
        reason: "I want to change my own deal's number.",
      })
    ).rejects.toThrow(/your own application/i);

    // And the amount and its derived cluster are untouched — the refusal lands
    // before any write, so a blocked reopen cannot leave the deal half-cleared.
    // (Handover state is deliberately NOT asserted here: a MANUAL approval on a
    // deal with no appraisal already sits BLOCKED for SCRUM-61's reasons, so it
    // says nothing about whether this reopen was stopped.)
    const after = await readApp(seed, applicationId);
    expect(after.approvedDealerPurchaseAmountMinor).toBe(jod(11_800));
    expect(after.approvedPurchaseBasis).toBe("MANUAL");
    expect(after.financeCompanyFundedPortionMinor).toBeDefined();
  });

  test("an amount unlike every figure on file is refused until it is acknowledged", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // The production failure, to scale: 10x the quotation, with a note that
    // satisfies the MANUAL basis's only rule.
    await expect(
      seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seed.orgId,
        applicationId,
        approvedAmountMinor: jod(125_000),
        basis: "MANUAL",
        notes: "Done",
      })
    ).rejects.toThrow(/far from this deal's/i);

    // Nothing was written: no amount, and therefore no funding split derived
    // from one. This is the half that matters — the refusal has to land before
    // recomputeAndPatchEconomics, not after.
    const refused = await readApp(seed, applicationId);
    expect(refused.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(refused.expectedDealerRemittanceMinor).toBeUndefined();
  });

  test("an acknowledged outlier is recorded exactly as given", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // A warning, never a cap. A finance company may approve an amount unlike
    // anything the dealership showed it, and the acknowledgement is the
    // operator saying so — after which the figure is stored untouched.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(125_000),
      basis: "MANUAL",
      notes: "Confirmed by the company in writing.",
      outlierAcknowledged: true,
    });

    expect((await readApp(seed, applicationId)).approvedDealerPurchaseAmountMinor).toBe(
      jod(125_000)
    );
  });

  test("an ordinary figure is never challenged, right up to the boundary", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);

    // Exactly half again the 12,500 quotation. Inclusive on purpose: an
    // operator must not meet a challenge at a boundary they cannot see, and
    // every ordinary negotiated figure sits well inside it. Nagging here is how
    // people learn to click through the challenge that matters.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(18_750),
      basis: "MANUAL",
      notes: "Negotiated up; no appraisal on this deal.",
    });

    expect((await readApp(seed, applicationId)).approvedDealerPurchaseAmountMinor).toBe(
      jod(18_750)
    );
  });

  test("agreeing with the appraisal clears the question even when the quotation is far away", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(40_000),
      providerType: "FINANCE_COMPANY",
      providerName: "Company assessor",
      appraisedAt: Date.now(),
    });

    // 40,000 is far from the 12,500 quotation but IS the appraisal. An
    // appraisal-based decision is the ordinary case, not an anomaly, so no
    // acknowledgement is required.
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(40_000),
      basis: "MANUAL",
      notes: "Matched their own appraisal.",
    });

    expect((await readApp(seed, applicationId)).approvedDealerPurchaseAmountMinor).toBe(
      jod(40_000)
    );
  });
});

/**
 * The correction history is only as private as the figure inside it.
 *
 * `recordOverride` stringifies the approved amount into `previousValue` and
 * `newValue`. `redactSettlementEvidence` names this query's `overrides[]` as
 * one of three routes by which a `view:sales` caller recovers a number the row
 * itself withholds — harmless while nothing rendered them, and a leak in front
 * of the exact role it is withheld from the moment a screen does.
 */
describe("the correction history follows the amount it describes", () => {
  async function seedCorrectedDeal() {
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
      reason: "Entered from the wrong advice.",
    });
    return { seed, applicationId };
  }

  test("a caller who may see the amount gets the history, with the person named", async () => {
    const { seed, applicationId } = await seedCorrectedDeal();

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });

    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0]?.reason).toBe("Entered from the wrong advice.");
    // The id alone tells an operator nothing; a history that cannot say who is
    // not an audit trail.
    expect(economics.overrides[0]?.changedByName).toBeDefined();
    // And the replaced figure survives — this row is the only place it does.
    expect((await readOverrides(seed, applicationId))[0]?.previousValue).toContain(String(jod(11_800)));
  });

  test("a sales caller gets NO history, because the rows carry the amount withheld from them", async () => {
    const { seed, applicationId } = await seedCorrectedDeal();
    const asSales = await addSalesUser(seed);

    const forSales = await asSales.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });

    // The amount is withheld from this caller...
    expect(forSales.application.approvedDealerPurchaseAmountMinor).toBeUndefined();
    // ...so the rows that spell it out in prose must be withheld too. Returning
    // them would hand back, in a string, the number the line above removed.
    expect(forSales.overrides).toEqual([]);
    // The rest of the deal still serves — withholding the history must not
    // withhold the deal.
    expect(forSales.application.submittedQuotationMinor).toBe(jod(DEAL.quotation));
  });

  test("a correction to another figure still cannot carry the amount in its prose", async () => {
    const { seed, applicationId } = await seedCorrectedDeal();
    const asSales = await addSalesUser(seed);

    // The approval on this deal has been withdrawn, so the quotation is
    // writable again. Its SUBJECT is the quotation, which this caller may see —
    // and its reason is whatever a manager typed, which here is the figure they
    // may not. `overrideReason` is `v.optional(v.string())`: unrestricted.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(11_900),
      source: "MANUAL_ENTRY",
      overrideReason: "Matched approved amount 18,902.",
    });

    const forSales = await asSales.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });

    // Raised in adversarial review, against a version of this query that gated
    // per subject and returned this row. Withholding the figure while returning
    // the sentence hands over the figure in prose — the exact route
    // `redactSettlementEvidence` documents for `approvedPurchaseNotes`.
    expect(JSON.stringify(forSales.overrides)).not.toContain("18,902");
    expect(forSales.overrides).toEqual([]);

    // A finance caller reads all of it, so the assertion above is about the
    // GATE and not about a history that is empty for everyone.
    const forFinance = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(forFinance.overrides.map((row) => row.subject)).toContain("SUBMITTED_QUOTATION");
    expect(JSON.stringify(forFinance.overrides)).toContain("18,902");
  });

  test("a reconciliation note is withheld from sales for its REASON, not its figures", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        needsFinancingReconciliation: true,
        financingReconciliationReason: "Legacy deal.",
      })
    );
    // The note a finance user writes about what they checked quotes deal
    // figures as a matter of course — the same free-text route
    // `redactSettlementEvidence` already documents for `approvedPurchaseNotes`.
    await seed.asUser.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: seed.orgId,
      applicationId,
      note: "Agrees with the approved 18,902 on the advice.",
    });

    const asSales = await addSalesUser(seed);
    const forSales = await asSales.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    // The old all-or-nothing gate hid this row as a side effect. Moving to
    // per-subject gating would have opened it, so the reason it stays closed is
    // now a written rule rather than an accident of the previous design.
    expect(forSales.overrides.map((row) => row.subject)).toEqual([]);

    const forFinance = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    expect(forFinance.overrides.map((row) => row.subject)).toEqual(["RECONCILIATION_FLAG"]);
  });
});

/**
 * No writer's corrections can vanish from the panel without a test saying so.
 *
 * `financeApplicationOverrides` types `field` as `v.string()`, and SIX call
 * sites across two modules write to it. The projection recognises fields from a
 * registry and drops anything else, which is the right failure mode for a row it
 * cannot name — and a silent one, indistinguishable on screen from "nothing was
 * ever corrected here".
 *
 * That is not hypothetical. Raised in adversarial review of this branch and
 * confirmed: moving to the registry dropped four real financial corrections
 * written by `financeDealCosts.ts` — an accounting classification withdrawn, a
 * custody settlement reopened, a reconciled cost re-recorded, a legal invoice
 * replaced. Every one of them is exactly the kind of change this panel exists to
 * explain, and none reached it.
 *
 * So the writers are discovered from the source rather than listed by hand. A
 * seventh call site added later fails here instead of quietly disappearing.
 */
describe("every audit field a writer records can reach the panel", () => {
  const CONVEX_SOURCES = import.meta.glob("./**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /**
   * Every field name passed to an override insert, anywhere in convex/.
   *
   * Resolves CONSTANTS as well as literals, and throws on a call site it cannot
   * read. Reading only `field: "literal"` was the first attempt and both
   * adversarial reviewers took it apart independently: all three writers of
   * `approvedDealerPurchaseAmountMinor` name the field through
   * `APPROVED_AMOUNT_FIELD`, so the discovery silently returned six fields
   * without the one that matters most — while the "not vacuous" assertions
   * below still passed. A guard whose blind spot is the most consequential
   * subject in the table is worse than no guard, because it is believed.
   *
   * Throwing rather than skipping is the point: an unreadable call site must
   * fail this test, not quietly shrink the set it claims to cover.
   */
  function auditFieldsWrittenAnywhere(): string[] {
    const found = new Set<string>();
    for (const [path, source] of Object.entries(CONVEX_SOURCES)) {
      if (path.includes(".test.") || path.includes("/_generated/")) continue;
      // `recordOverride` is the shared writer, not a call site. Its own body
      // inserts `field: args.field` — whichever field its caller passed — and
      // every one of those callers is discovered separately below. Located by
      // name rather than waved through as "a dotted expression", so an
      // unreadable field ANYWHERE else still throws.
      const helper = source.indexOf("async function recordOverride(");
      const insideHelper = (index: number) =>
        helper !== -1 && index >= helper && index < helper + 900;
      const callSites = /insert\(\s*"financeApplicationOverrides"|recordOverride\(\s*ctx\s*,/g;
      let site: RegExpExecArray | null;
      while ((site = callSites.exec(source)) !== null) {
        if (insideHelper(site.index)) continue;
        // The `field:` belongs to the object literal that opens at the call, so
        // a window is enough and avoids parsing TypeScript to find one key.
        const window = source.slice(site.index, site.index + 700);
        const field = /field:\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(window);
        if (!field) {
          throw new Error(`Override write at ${path} names no field this test can read`);
        }
        if (field[1] !== undefined) {
          found.add(field[1]);
          continue;
        }
        // A constant. Resolved from its declaration in the same module — the
        // only form these writers use, and anything else must announce itself
        // rather than be dropped.
        const declared = new RegExp(`const ${field[2]}\\s*=\\s*"([^"]+)"`).exec(source);
        if (!declared) {
          throw new Error(`Override write at ${path} names field \`${field[2]}\`, which this test cannot resolve`);
        }
        found.add(declared[1]);
      }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  }

  test("the discovery itself still finds the writers, so this is not vacuous", () => {
    const fields = auditFieldsWrittenAnywhere();
    // A regex that stops matching would make every assertion below pass on an
    // empty list — the exact shape of a guard that guards nothing.
    expect(fields).toContain("submittedQuotationMinor");
    expect(fields).toContain("accountingClassification");
    expect(fields).toContain("financeDealCustody.status");
    // The approved purchase amount above all. Its three writers name the field
    // through a CONSTANT rather than a literal, and a discovery that reads only
    // literals silently omits the single most consequential subject in this
    // table while every other assertion here still passes. Both adversarial
    // reviewers found that independently.
    expect(fields).toContain("approvedDealerPurchaseAmountMinor");
    expect(fields.length).toBeGreaterThanOrEqual(6);
  });

  test("each one is named by the projection rather than silently dropped", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);

    for (const field of auditFieldsWrittenAnywhere()) {
      await seed.t.run((ctx) =>
        ctx.db.insert("financeApplicationOverrides", {
          orgId: seed.orgId,
          applicationId,
          field,
          previousValue: "1000 (something)",
          newValue: "2000 (something else)",
          reason: `a correction to ${field}`,
          changedBy: seed.approverId,
          changedAt: Date.now(),
        })
      );
    }

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    const named = new Set(economics.overrides.map((row) => row.reason));
    for (const field of auditFieldsWrittenAnywhere()) {
      expect(named.has(`a correction to ${field}`)).toBe(true);
    }
  });
});

/**
 * A correction to one figure is never rendered as a correction to another.
 *
 * `recordSubmittedQuotation` stringifies the quotation together with every
 * other input that moved, so a correction to the DEALER-BORNE EXPENSES stores
 * the same leading integer on both sides of the row. The projection this
 * replaces keyed on `field.endsWith("Minor")` and read that integer, so an
 * expense correction arrived at the screen as an unlabelled money movement from
 * 12,500 to 12,500 — a figure that did not change, presented next to approved
 * purchase amounts that had.
 */
describe("a correction names the figure it is about", () => {
  test("an expense-only correction shows no money movement, and is not approved money", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordManualBaseline(seed, applicationId);

    // Same quotation, same source. Only the expenses behind it move.
    await seed.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(DEAL.quotation),
      source: "MANUAL_ENTRY",
      targetSellingAmountMinor: jod(DEAL.targetSelling),
      estimatedDealerBorneExpensesMinor: jod(900),
      customerFirstPaymentMinor: jod(DEAL.customerFirstPayment),
      overrideReason: "Registration came in higher than estimated.",
    });

    // The trap is really in the data: both stored sides lead with the SAME
    // integer, so a projection that reads it renders 12,500 -> 12,500. Without
    // this the assertions below would pass on a row that never had the problem.
    const stored = (await readOverrides(seed, applicationId))[0];
    expect(stored?.field).toBe("submittedQuotationMinor");
    expect(stored?.previousValue?.startsWith(String(jod(DEAL.quotation)))).toBe(true);
    expect(stored?.newValue.startsWith(String(jod(DEAL.quotation)))).toBe(true);

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    const entry = economics.overrides[0];

    // Named as the quotation, so it can never be read as the approved amount.
    expect(entry?.subject).toBe("SUBMITTED_QUOTATION");
    // And carrying no movement, because the figure the writer serialized is not
    // the figure that changed. The reason is what explains this entry.
    expect(entry?.previousAmountMinor).toBeUndefined();
    expect(entry?.newAmountMinor).toBeUndefined();
    expect(entry?.reason).toBe("Registration came in higher than estimated.");

    // Pinned for the cockpit test that renders this case, so what it draws is
    // what this writer and this query actually produce.
    expect(economics.overrides.map(withoutRuntimeIdentity)).toEqual(
      EXPENSE_ONLY_QUOTATION_CORRECTION.map(withoutRuntimeIdentity)
    );
  });
});

/**
 * The history projection fails CLOSED on anything it does not understand.
 *
 * Raised in review: a `*Minor` row holding something non-numeric, unsafe or
 * out of range must not be formatted into plausible-looking money, and a future
 * override field must not acquire denomination semantics merely because its
 * stored prose happens to begin with digits. Showing nothing is always
 * recoverable; showing a confident wrong number is not.
 */
describe("the correction history refuses to invent money", () => {
  async function withStoredOverride(value: string, field = "approvedDealerPurchaseAmountMinor") {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await seed.t.run((ctx) =>
      ctx.db.insert("financeApplicationOverrides", {
        orgId: seed.orgId,
        applicationId,
        field,
        previousValue: value,
        newValue: value,
        reason: "crafted row",
        changedBy: seed.approverId,
        changedAt: Date.now(),
      })
    );
    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    return economics.overrides[0];
  }

  test("a truncated decimal is not shown as whole minor units", async () => {
    // `^(\d+)` alone reads this as 12 and renders twelve minor units — a
    // confident figure invented by dropping the fraction.
    const row = await withStoredOverride("12.5");
    expect(row?.previousAmountMinor).toBeUndefined();
    expect(row?.newAmountMinor).toBeUndefined();
    // The line still carries what a person wrote.
    expect(row?.reason).toBe("crafted row");
  });

  test("non-numeric, signed and empty values are omitted rather than guessed at", async () => {
    for (const value of ["", "   ", "unknown", "-5000", "+5000", "NaN", "Infinity", "1e6"]) {
      const row = await withStoredOverride(value);
      expect(row?.previousAmountMinor).toBeUndefined();
      expect(row?.newAmountMinor).toBeUndefined();
    }
  });

  test("a magnitude past exact integer arithmetic is omitted, not rounded", async () => {
    const row = await withStoredOverride("9007199254740993");
    expect(row?.previousAmountMinor).toBeUndefined();
  });

  test("a value with trailing junk is not read as the figure it starts with", async () => {
    // Raised in adversarial review. Matching a delimited PREFIX accepted every
    // one of these and rendered a confident 150,000 — and this column is a plain
    // string, so a repair script or a bad import can put anything in it. The
    // whole value has to be a form this module's writers actually produce.
    for (const value of [
      "150000000 garbage",
      "150000000 (truncated",
      "150000000 (MANUAL @ 85% LTV, approved by u_1) and then some",
      "150000000\t(MANUAL)",
      "150000000  (MANUAL)",
    ]) {
      const row = await withStoredOverride(value);
      expect(row?.previousAmountMinor).toBeUndefined();
      expect(row?.newAmountMinor).toBeUndefined();
    }
  });

  test("an audit field this product cannot name is not shown at all", async () => {
    // Not merely stripped of its figures — DROPPED. An unnamed entry rendered
    // beside named ones reads as if it were about the figure above it, and the
    // suffix rule it used to be judged by answered "does this string probably
    // start with a number" rather than "what did this row change".
    const row = await withStoredOverride("150000000 (whatever this becomes)", "someFutureField");
    expect(row).toBeUndefined();
  });

  test("the real stored shape still reads as money, so this is not vacuous", async () => {
    // The whole point of the guards above is that the GENUINE format keeps
    // working. Without this, every assertion here would pass on a projection
    // that presented nothing at all.
    const row = await withStoredOverride("150000000 (MANUAL @ 85% LTV, approved by u_1)");
    expect(row?.previousAmountMinor).toBe(150_000_000);
    const bare = await withStoredOverride("15000000");
    expect(bare?.previousAmountMinor).toBe(15_000_000);
  });
});

/**
 * A withdrawn approval says it was withdrawn.
 *
 * Found in adversarial review of PR #233. `recordAppraisal` writes the sentinel
 * `"cleared"` when new evidence supersedes the approval that rested on it
 * (`convex/financingEconomics.ts:1339`), and the first cut of the projection
 * knew only `"reopened"`. So the row came back with no amount and no state, and
 * the panel rendered a bare previous figure with no arrow and nothing saying it
 * had been withdrawn — on the one screen whose entire job is explaining why a
 * number changed, that reads as "unchanged".
 *
 * Distinct from a reopen on purpose: a reopen is a person correcting a figure,
 * this is new evidence invalidating one. Conflating them would answer "what
 * changed" and never "why".
 */
describe("an approval withdrawn by new evidence is reported as withdrawn", () => {
  test("the projection reports the cleared state, not a silent blank", async () => {
    const seed = await seedDealer();
    const applicationId = await createApplication(seed);
    await recordBaselineQuotation(seed, applicationId);
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(11_800),
      providerType: "FINANCE_COMPANY",
      providerName: "First assessor",
      appraisedAt: Date.now(),
    });
    await seed.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: seed.orgId,
      applicationId,
      approvedAmountMinor: jod(11_800),
      basis: "APPRAISAL",
    });

    // New evidence arrives and invalidates the approval that rested on it.
    await seed.asUser.mutation(api.financingEconomics.recordAppraisal, {
      orgId: seed.orgId,
      applicationId,
      appraisalAmountMinor: jod(10_500),
      providerType: "FINANCE_COMPANY",
      providerName: "Second assessor",
      appraisedAt: Date.now(),
      reappraisalReason: "Company re-inspected the vehicle.",
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    const cleared = economics.overrides.find(
      (row) => row.subject === "APPROVED_PURCHASE_AMOUNT"
    );

    expect(cleared).toBeDefined();
    // The figure it moved FROM survives...
    expect(cleared?.previousAmountMinor).toBe(jod(11_800));
    // ...and the row says what happened rather than going blank.
    expect(cleared?.event).toBe("SUPERSEDED");
    // The sentinel is a STATE, never presented as money.
    expect(cleared?.newAmountMinor).toBeUndefined();
  });

  test("a reopen and a clearance are not conflated", async () => {
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
      reason: "Entered from the wrong advice.",
    });

    const economics = await seed.asUser.query(api.financingEconomics.getEconomics, {
      orgId: seed.orgId,
      applicationId,
    });
    // A person correcting a figure — the other cause entirely.
    expect(economics.overrides[0]?.event).toBe("WITHDRAWN");
  });
});
