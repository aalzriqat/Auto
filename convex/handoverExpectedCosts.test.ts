import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { deriveExpectedFees } from "./financeDealCosts";
import { MAX_FEE_TEMPLATES, MAX_LIVE_DEAL_FEE_LINES } from "./utils/dealCostLimits";

/**
 * The handover-cost checklist the finance company's FROZEN policy implies
 * (owner product correction, #scrum-215 2026-09-12 21:05, Slack
 * p1789236333469999).
 *
 * The rules a deal was created under are the rules it is costed against:
 * expected rows and their total come READ-ONLY from the application's own
 * `companyRuleSnapshot.feeTemplates`; the operator records ACTUALS only, and
 * the server copies every other field of a configured line from the snapshot
 * entry. Nothing here reads the live company after the deal exists, and
 * nothing the client says about policy is trusted.
 *
 * Every case is a direct call. The UI's checklist is a rendering of this
 * payload; the authority is here.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

/** JOD minor units (scale 3), matching getOrgCurrency's default. */
const jod = (major: number): number => Math.round(major * 1000);

type Template = {
  feeType:
    | "APPRAISAL_FEE"
    | "OWNERSHIP_TRANSFER"
    | "LICENSING"
    | "STAMPS"
    | "LIEN_REGISTRATION"
    | "INSPECTION"
    | "INSURANCE"
    | "COMMISSION"
    | "OTHER_CLOSING_EXPENSE";
  description?: string;
  estimatedAmountMinor: number;
  paidBy: "DEALER" | "CUSTOMER" | "FINANCE_COMPANY";
  paidTo: "GOVERNMENT" | "APPRAISER" | "FINANCE_COMPANY" | "OTHER";
  includedInQuotation: boolean;
  deductedFromSettlement: boolean;
  refundable: boolean;
  accountingTreatment:
    | "APPRAISAL_EXPENSE"
    | "OWNERSHIP_TRANSFER_EXPENSE"
    | "FINANCE_COMPANY_COMMISSION"
    | "SELLING_EXPENSE";
};

/** The owner's own example: valuation 120, plates 250, commission 175, legal stamps 90. */
const COMPANY_A_TEMPLATES: Template[] = [
  {
    feeType: "APPRAISAL_FEE",
    description: "Valuation",
    estimatedAmountMinor: jod(120),
    paidBy: "DEALER",
    paidTo: "APPRAISER",
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "APPRAISAL_EXPENSE",
  },
  {
    feeType: "LICENSING",
    description: "Plates",
    estimatedAmountMinor: jod(250),
    paidBy: "DEALER",
    paidTo: "GOVERNMENT",
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
  },
  {
    feeType: "COMMISSION",
    description: "Commission",
    estimatedAmountMinor: jod(175),
    paidBy: "DEALER",
    paidTo: "FINANCE_COMPANY",
    includedInQuotation: false,
    deductedFromSettlement: true,
    refundable: false,
    accountingTreatment: "FINANCE_COMPANY_COMMISSION",
  },
  {
    feeType: "STAMPS",
    description: "Legal stamps",
    estimatedAmountMinor: jod(90),
    paidBy: "DEALER",
    paidTo: "GOVERNMENT",
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
  },
];

/** A second company with a different policy: two fees, different amounts. */
const COMPANY_B_TEMPLATES: Template[] = [
  { ...COMPANY_A_TEMPLATES[0], estimatedAmountMinor: jod(80) },
  { ...COMPANY_A_TEMPLATES[2], estimatedAmountMinor: jod(300) },
];

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  asUser: AuthenticatedTestConvex;
  customerId: Id<"customers">;
  customerStatusId: Id<"orgCustomerStatuses">;
  vehicleId: Id<"vehicles">;
}

async function seedDealer(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Expected Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `exp_user_${suffix}`, email: `exp${suffix}@x.com` })
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
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `EXPVIN${suffix}`,
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
    ctx.db.insert("customers", { orgId, firstName: "Expected", lastName: "Customer" })
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
    asUser: t.withIdentity({ subject: `exp_user_${suffix}` }),
    customerId,
    customerStatusId,
    vehicleId,
  };
}

async function createCompany(seed: Seed, name: string, feeTemplates: Template[]) {
  return await seed.t.run(async (ctx) => {
    return await ctx.db.insert("financeCompanies", {
      orgId: seed.orgId,
      name,
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      defaultLtvPercent: 80,
      isActive: true,
      ruleVersion: 1,
      adminFees: 0,
      feeTemplates: feeTemplates.length > 0 ? feeTemplates : undefined,
    });
  });
}

/** An application created THROUGH the product, so the snapshot is the real one. */
async function createApplicationFor(seed: Seed, companyId: Id<"financeCompanies">) {
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId: seed.vehicleId,
    vehiclePrice: 20_000,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId,
    customerEligibilityStatusIds: [seed.customerStatusId],
    totalFinancedAmount: 20_000,
  });
  const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
  const company = await seed.t.run((ctx) => ctx.db.get(companyId));
  if (company?.feeTemplates && company.feeTemplates.length > 0) {
    await seed.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (app && app.companyRuleSnapshot) {
        await ctx.db.patch(applicationId, {
          companyRuleSnapshot: {
            ...app.companyRuleSnapshot,
            adminFees: undefined,
            feeTemplates: company.feeTemplates,
          },
        });
      }
    });
  }
  return applicationId;
}

async function costsOf(seed: Seed, applicationId: Id<"financeApplications">) {
  return await seed.asUser.query(api.financeDealCosts.listDealCosts, {
    orgId: seed.orgId,
    applicationId,
  });
}

async function recordTemplateActual(
  seed: Seed,
  applicationId: Id<"financeApplications">,
  templateIndex: number,
  feeType: Template["feeType"],
  actualAmountMinor: number,
  extra: Partial<{ idempotencyKey: string; expectedCurrency: string }> = {}
) {
  return await seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
    orgId: seed.orgId,
    applicationId,
    templateIndex,
    feeType,
    actualAmountMinor,
    expectedCurrency: extra.expectedCurrency ?? "JOD",
    idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
  });
}

async function liveFees(seed: Seed, applicationId: Id<"financeApplications">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("financeDealFees").collect()).filter(
      (fee) => fee.applicationId === applicationId && fee.voidedAt === undefined
    )
  );
}

// ---------------------------------------------------------------------------

describe("the expected checklist comes from the application's frozen snapshot", () => {
  test("company A vs company B: different expected rows and totals for otherwise identical deals", async () => {
    // One vehicle carries one active application, so the two deals are the
    // same shape on two dealerships — the only thing that differs is the company.
    const seed = await seedDealer("ab");
    const seedB = await seedDealer("ab2");
    const companyA = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const companyB = await createCompany(seedB, "Company B", COMPANY_B_TEMPLATES);
    const dealA = await createApplicationFor(seed, companyA);
    const dealB = await createApplicationFor(seedB, companyB);

    const a = (await costsOf(seed, dealA)).expected;
    const b = (await costsOf(seedB, dealB)).expected;

    expect(a.source).toBe("COMPANY_RULE_SNAPSHOT");
    expect(a.rows.map((row) => [row.templateIndex, row.feeType, row.expectedAmountMinor])).toEqual([
      [0, "APPRAISAL_FEE", jod(120)],
      [1, "LICENSING", jod(250)],
      [2, "COMMISSION", jod(175)],
      [3, "STAMPS", jod(90)],
    ]);
    expect(a.expectedTotalMinor).toBe(jod(635));
    expect(a.rows.every((row) => row.actual === null)).toBe(true);
    // Recorded actuals only — nothing recorded, so zero, and the difference is
    // a comparison, never an amount payable.
    expect(a.actualTotalMinor).toBe(0);
    expect(a.differenceMinor).toBe(jod(635));
    expect(a.currency).toBe("JOD");

    expect(b.rows.map((row) => [row.feeType, row.expectedAmountMinor])).toEqual([
      ["APPRAISAL_FEE", jod(80)],
      ["COMMISSION", jod(300)],
    ]);
    expect(b.expectedTotalMinor).toBe(jod(380));
  });

  test("editing the live company after the deal exists does NOT rewrite the deal's expected rows", async () => {
    const seed = await seedDealer("live");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    const before = (await costsOf(seed, applicationId)).expected;

    const company = await seed.t.run((ctx) => ctx.db.get(companyId));
    if (!company) throw new Error("company vanished");
    await seed.t.run(async (ctx) => {
      await ctx.db.patch(companyId, { feeTemplates: COMPANY_B_TEMPLATES });
    });
    // The live row moved (control), the deal did not.
    const liveNow = (await seed.t.run((ctx) => ctx.db.get(companyId)))?.feeTemplates;
    expect(liveNow?.map((template) => template.estimatedAmountMinor)).toEqual([jod(80), jod(300)]);

    const after = (await costsOf(seed, applicationId)).expected;
    expect(after.rows.map((row) => row.expectedAmountMinor)).toEqual(
      before.rows.map((row) => row.expectedAmountMinor)
    );
    expect(after.expectedTotalMinor).toBe(jod(635));
  });

  test("a deal whose company configured nothing is reported as unconfigured, never as zero", async () => {
    const seed = await seedDealer("none");
    const companyId = await createCompany(seed, "Bare Company", []);
    const applicationId = await createApplicationFor(seed, companyId);

    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.source).toBe("NO_TEMPLATES");
    expect(expected.rows).toEqual([]);
    expect(expected.expectedTotalMinor).toBeNull();
    expect(expected.differenceMinor).toBeNull();
  });

  test("a legacy deal with no snapshot at all is reported as unconfigured too", async () => {
    const seed = await seedDealer("legacy");
    const applicationId = await seed.t.run(async (ctx) => {
      const quoteId = await ctx.db.insert("quotes", {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId: seed.vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        status: "ACCEPTED",
        createdBy: seed.userId,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("financeApplications", {
        orgId: seed.orgId,
        quoteId,
        customerId: seed.customerId,
        vehicleId: seed.vehicleId,
        salespersonId: seed.userId,
        status: "APPROVED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.source).toBe("NO_SNAPSHOT");
    expect(expected.expectedTotalMinor).toBeNull();
  });
});

describe("the denomination of a configured expectation (SCRUM-319)", () => {
  /**
   * Templates store `estimatedAmountMinor` with NO currency of their own —
   * they are minor units in the organisation's currency of the day. The org
   * currency lock (`orgSettings.upsert`) watched applications, cost lines,
   * custody and the ledger, but not `financeCompanies`: an org could configure
   * a company with JOD templates while otherwise fresh, switch to USD, and
   * every application created afterwards would snapshot the same integers and
   * this feature would read 120,000 minor (120.000 JOD) as 1,200.00 USD — a
   * ten-fold expectation on every deal, financially live the moment an actual
   * is compared against it. Reproduced before it was fixed: with the lock
   * missing, the switch succeeded and the checklist reported USD.
   *
   * The fix is the existing lock's own shape — a conservative EXISTENCE lock
   * on `financeCompanies` (`by_org`, first row): a company that exists at all
   * carries minor-unit rules (templates, minimum first payment) denominated in
   * the org currency of its day, so presence of the row is the invariant.
   * Onboarding stays open: a fresh org has no company.
   */
  test("the org currency is locked once a finance company exists, so a snapshotted template can never be re-read at another scale", async () => {
    const seed = await seedDealer("ccyLock");
    await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);

    await expect(
      seed.asUser.mutation(api.orgSettings.upsert, { orgId: seed.orgId, currency: "USD", currencySymbol: "$" })
    ).rejects.toThrow(/cannot be changed after financial records exist/i);

    // Control: the org is still JOD and the checklist is denominated in it.
    const applicationId = await createApplicationFor(
      seed,
      (await seed.t.run((ctx) => ctx.db.query("financeCompanies").collect()))[0]._id
    );
    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.currency).toBe("JOD");
    expect(expected.rows[0].expectedAmountMinor).toBe(jod(120));
  });

  test("a fresh org with no company can still choose its currency (onboarding control)", async () => {
    const seed = await seedDealer("ccyFresh");
    await seed.asUser.mutation(api.orgSettings.upsert, { orgId: seed.orgId, currency: "USD", currencySymbol: "$" });
    const settings = await seed.asUser.query(api.orgSettings.get, { orgId: seed.orgId });
    expect(settings?.currency).toBe("USD");
  });
});

describe("recording the actual for a configured fee", () => {
  test("copies the template's every field from the snapshot and keeps the expectation beside the actual", async () => {
    const seed = await seedDealer("copy");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);

    // Plates cost 265, not the configured 250.
    const feeId = await recordTemplateActual(seed, applicationId, 1, "LICENSING", jod(265));
    const row = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(row).toMatchObject({
      source: "COMPANY_TEMPLATE",
      templateIndex: 1,
      feeType: "LICENSING",
      description: "Plates",
      estimatedAmountMinor: jod(250),
      actualAmountMinor: jod(265),
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      includedInQuotation: false,
      deductedFromSettlement: false,
      refundable: false,
      currency: "JOD",
    });

    const expected = (await costsOf(seed, applicationId)).expected;
    const plates = expected.rows[1];
    // Configured expected survives an actual that differs from it.
    expect(plates.expectedAmountMinor).toBe(jod(250));
    expect(plates.actual).toMatchObject({ feeId, actualAmountMinor: jod(265), status: "ACTUAL_RECORDED" });
    expect(expected.expectedTotalMinor).toBe(jod(635));
    expect(expected.actualTotalMinor).toBe(jod(265));
    expect(expected.differenceMinor).toBe(jod(635) - jod(265));
    expect(expected.unplannedLineIds).toEqual([]);
  });

  test("an unplanned actual is clearly outside the checklist and never changes the expected total", async () => {
    const seed = await seedDealer("unplanned");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);

    const feeId = await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
      orgId: seed.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      description: "Towing to the customer's town",
      actualAmountMinor: jod(40),
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      source: "MANUAL",
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });

    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.expectedTotalMinor).toBe(jod(635));
    expect(expected.rows.every((row) => row.actual === null)).toBe(true);
    expect(expected.unplannedLineIds).toEqual([feeId]);
    // Actual total counts it; the comparison moves; the expectation does not.
    expect(expected.actualTotalMinor).toBe(jod(40));
    expect(expected.differenceMinor).toBe(jod(635) - jod(40));
  });

  test("the caller cannot author the expectation: the line carries the template's estimate whatever the receipt says", async () => {
    const seed = await seedDealer("author");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(999));
    const [row] = await liveFees(seed, applicationId);
    expect(row.estimatedAmountMinor).toBe(jod(120));
    expect(row.actualAmountMinor).toBe(jod(999));
    // And re-recording the actual on that line leaves the expectation alone.
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId,
      feeId: row._id,
      actualAmountMinor: jod(130),
      expectedCurrency: "JOD",
    });
    const again = await seed.t.run((ctx) => ctx.db.get(row._id));
    expect(again?.estimatedAmountMinor).toBe(jod(120));
    expect(again?.actualAmountMinor).toBe(jod(130));
  });

  test.each([
    { label: "NaN", index: Number.NaN },
    { label: "Infinity", index: Number.POSITIVE_INFINITY },
    { label: "a fraction", index: 1.5 },
    { label: "negative", index: -1 },
    { label: "beyond the last template", index: 4 },
    { label: "unsafe", index: 2 ** 53 },
  ])("a reference that is $label is refused, and nothing is written", async ({ index }) => {
    const seed = await seedDealer(`ref${Math.random().toString(36).slice(2, 6)}`);
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await expect(
      recordTemplateActual(seed, applicationId, index, "APPRAISAL_FEE", jod(120))
    ).rejects.toThrow(/configured fee|whole number/i);
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });

  test("a reference whose feeType is not the one at that position is refused as stale", async () => {
    const seed = await seedDealer("stale");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await expect(
      recordTemplateActual(seed, applicationId, 1, "STAMPS", jod(90))
    ).rejects.toThrow(/not the one you were shown/i);
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });

  test("a deal with no configured fees refuses the configured-fee writer and points at the additional-cost path", async () => {
    const seed = await seedDealer("noneW");
    const companyId = await createCompany(seed, "Bare Company", []);
    const applicationId = await createApplicationFor(seed, companyId);
    await expect(
      recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(120))
    ).rejects.toThrow(/configured no fees/i);
  });

  test("the same intent replays the same line; a new intent against a recorded position is refused; a void frees it", async () => {
    const seed = await seedDealer("retry");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);

    const key = crypto.randomUUID();
    const first = await recordTemplateActual(seed, applicationId, 2, "COMMISSION", jod(175), { idempotencyKey: key });
    const replay = await recordTemplateActual(seed, applicationId, 2, "COMMISSION", jod(175), { idempotencyKey: key });
    expect(replay).toBe(first);
    expect(await liveFees(seed, applicationId)).toHaveLength(1);

    // Same key, different amount: a different intent under a reused key.
    await expect(
      recordTemplateActual(seed, applicationId, 2, "COMMISSION", jod(180), { idempotencyKey: key })
    ).rejects.toThrow(/different request content/i);
    // Same key, different position: refused for the same reason.
    await expect(
      recordTemplateActual(seed, applicationId, 3, "STAMPS", jod(175), { idempotencyKey: key })
    ).rejects.toThrow(/different request content/i);
    // New key, same position: one live line per configured fee.
    await expect(
      recordTemplateActual(seed, applicationId, 2, "COMMISSION", jod(175))
    ).rejects.toThrow(/already recorded/i);
    expect(await liveFees(seed, applicationId)).toHaveLength(1);

    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, {
      orgId: seed.orgId,
      feeId: first,
      reason: "recorded against the wrong receipt",
    });
    const second = await recordTemplateActual(seed, applicationId, 2, "COMMISSION", jod(170));
    expect(second).not.toBe(first);
    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.rows[2].actual).toMatchObject({ feeId: second, actualAmountMinor: jod(170) });
  });

  test("the amount must be counted in the deal's currency (SCRUM-319 preserved)", async () => {
    const seed = await seedDealer("ccy");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await expect(
      recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", 12_000, { expectedCurrency: "USD" })
    ).rejects.toThrow(/costs are kept in JOD/i);
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });

  test("permission and tenancy: create:finance_application is the door, and another organisation's deal is not reachable", async () => {
    const seed = await seedDealer("tenant");
    const companyId = await createCompany(seed, "Company A", COMPANY_A_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);

    const viewerId = await seed.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "exp_viewer", email: "viewer@x.com" })
    );
    const viewerRole = await seed.t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: seed.orgId,
        name: "VIEWER",
        permissions: ["view:sales", "view:finance_applications"],
      })
    );
    await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId: seed.orgId, userId: viewerId, roleId: viewerRole }));
    const asViewer = seed.t.withIdentity({ subject: "exp_viewer" });
    await expect(
      asViewer.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId,
        applicationId,
        templateIndex: 0,
        feeType: "APPRAISAL_FEE",
        actualAmountMinor: jod(120),
        expectedCurrency: "JOD",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    const other = await seedDealer("tenant2");
    await expect(
      other.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: other.orgId,
        applicationId,
        templateIndex: 0,
        feeType: "APPRAISAL_FEE",
        actualAmountMinor: jod(120),
        expectedCurrency: "JOD",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/not found/i);
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });
});

describe("duplicate templates", () => {
  const DUPLICATES: Template[] = [COMPANY_A_TEMPLATES[3], { ...COMPANY_A_TEMPLATES[3] }];

  test("are two positions, addressed exactly: an actual on one never satisfies the other", async () => {
    const seed = await seedDealer("dup");
    const companyId = await createCompany(seed, "Twice Stamps", DUPLICATES);
    const applicationId = await createApplicationFor(seed, companyId);

    const feeId = await recordTemplateActual(seed, applicationId, 1, "STAMPS", jod(90));
    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.rows.map((row) => row.duplicateIdentity)).toEqual([true, true]);
    expect(expected.rows[0].actual).toBeNull();
    expect(expected.rows[1].actual).toMatchObject({ feeId });
    expect(expected.expectedTotalMinor).toBe(jod(180));
  });

  test("a template line with no position is never attached to a configured row — unique identity or not — and stays visible as unplanned", () => {
    const line = (overrides: Record<string, unknown>) =>
      ({
        _id: `fee_${Math.random()}` as Id<"financeDealFees">,
        _creationTime: 0,
        orgId: "org" as Id<"organizations">,
        applicationId: "app" as Id<"financeApplications">,
        feeType: "STAMPS",
        description: "Legal stamps",
        currency: "JOD",
        actualAmountMinor: jod(90),
        paidBy: "DEALER",
        paidTo: "GOVERNMENT",
        accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        includedInQuotation: false,
        deductedFromSettlement: false,
        refundable: false,
        source: "COMPANY_TEMPLATE",
        createdBy: "user" as Id<"users">,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
      }) as never;
    const snapshot = (templates: Template[]) =>
      ({ ruleVersion: 1, companyName: "X", feeTemplates: templates }) as never;

    // Unique identity, exact feeType + description match: still not attached.
    // Attaching it would show the fee as recorded and hide the exact record
    // action while closure (positions only) refused; the line is history.
    const legacy = line({});
    const unique = deriveExpectedFees({
      snapshot: snapshot([COMPANY_A_TEMPLATES[3]]),
      fees: [legacy],
      currency: "JOD",
      actualTotalMinor: jod(90),
    });
    expect(unique.rows[0].actual).toBeNull();
    expect(unique.unplannedLineIds).toEqual([(legacy as { _id: Id<"financeDealFees"> })._id]);
    // Its actual still counts in the recorded total the caller passed in.
    expect(unique.actualTotalMinor).toBe(jod(90));

    // Duplicated identity: the same answer, for the same reason.
    const twin = line({});
    const duplicated = deriveExpectedFees({
      snapshot: snapshot(DUPLICATES),
      fees: [twin],
      currency: "JOD",
      actualTotalMinor: jod(90),
    });
    expect(duplicated.rows.map((row) => row.actual)).toEqual([null, null]);
    expect(duplicated.unplannedLineIds).toEqual([(twin as { _id: Id<"financeDealFees"> })._id]);
  });
});

/**
 * Codex-high MEDIUM on 229608039 — existing classifications bypass
 * configured-fee completion.
 *
 * `classifyDealAccounting` asks the snapshot for every configured fee, but
 * `finalizeDeal` trusted the `CLASSIFIED` flag it found. A deal classified under
 * the OLDER rule — before configured-fee completeness existed — still carries
 * a valid flag, and the posting plan reads recorded deductions only, so
 * finalization completed with every configured checklist position unrecorded.
 * Reproduced here the way the upgrade path produces it: the row carries a
 * classification no writer on this branch would grant, and finalization is
 * asked to post it. Failing-first: with the finalization re-check disabled the
 * sale was created; with it, finalization refuses before any write.
 */
describe("finalization re-checks configured fees, whichever rule the deal was classified under", () => {
  const PRICE = 20_000;

  async function seedFinalizable(tag: string) {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `Finalize ${tag}`, createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `fin_${tag}_user`, email: `fin.${tag}@x.com`, name: "Seller" })
    );
    const approverId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `fin_${tag}_appr`, email: `fin.${tag}.appr@x.com`, name: "Approver" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
      })
    );
    const asUser = t.withIdentity({ subject: `fin_${tag}_user`, clerkId: `fin_${tag}_user` });
    const asApprover = t.withIdentity({ subject: `fin_${tag}_appr`, clerkId: `fin_${tag}_appr` });

    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear,
      periodNumber: 1,
    });
    const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
    );
    const customerStatusId = await t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", {
        orgId,
        label: "Eligible",
        isActive: true,
        order: 1,
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `FINVIN${tag}`,
        make: "Kia",
        model: "Sportage",
        year: 2024,
        mileage: 10,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: PRICE,
        status: "AVAILABLE",
        sourceType: "STOCK" as const,
        purchasePrice: 15_000,
      })
    );
    // 100% LTV: the company funds the whole approval and the dealership
    // contributes nothing, so no NETTED refusal and a knowable remittance —
    // the fixture Codex described.
    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: `Finance ${tag}`,
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        defaultLtvPercent: 100,
        isActive: true,
        ruleVersion: 1,
        adminFees: 0,
        feeTemplates: COMPANY_B_TEMPLATES,
      })
    );
    return {
      t,
      orgId,
      userId,
      approverId,
      customerId,
      customerStatusId,
      vehicleId,
      companyId,
      asUser,
      asApprover,
    };
  }

  type Finalizable = Awaited<ReturnType<typeof seedFinalizable>>;

  /** Quote → application → APPROVED → quotation/approval at the price → handover → payment → invoice → one reconciled zero line. */
  async function walkToClassification(s: Finalizable) {
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId: s.vehicleId,
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: s.companyId,
      customerEligibilityStatusIds: [s.customerStatusId],
      totalFinancedAmount: PRICE,
    });
    const applicationId = await s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    await s.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (app && app.companyRuleSnapshot) {
        await ctx.db.patch(applicationId, {
          companyRuleSnapshot: {
            ...app.companyRuleSnapshot,
            adminFees: undefined,
            feeTemplates: COMPANY_B_TEMPLATES,
          },
        });
      }
    });
    await s.asUser.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await s.asApprover.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: jod(PRICE),
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: jod(PRICE),
      basis: "MANUAL",
      notes: "Approved at the quotation.",
    });
    const stamp = await s.asUser.query(api.applications.handoverStamp, { orgId: s.orgId, applicationId });
    await s.asUser.mutation(api.applications.registerVehicleHandover, {
      orgId: s.orgId,
      applicationId,
      economicsStamp: stamp as string,
    });
    await s.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    await s.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId,
      applicationId,
      legalInvoiceAmountMinor: jod(PRICE),
      legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    const zeroLine = await s.asUser.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: false,
      actualAmountMinor: 0,
      description: "No closing costs on this deal.",
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId: zeroLine, notes: "Nothing to match." });
    return applicationId;
  }

  const finalize = (s: Finalizable, applicationId: Id<"financeApplications">) =>
    s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
      idempotencyKey: crypto.randomUUID(),
    });
  const salesOf = (s: Finalizable) => s.t.run((ctx) => ctx.db.query("sales").collect());

  test("a deal classified under the older rule cannot finalize while a configured fee has no actual — and nothing is written", async () => {
    const s = await seedFinalizable("legacyClassified");
    const applicationId = await walkToClassification(s);

    // What the upgrade path leaves behind: a classification no writer on this
    // branch would grant. The line-based rules it was classified under are all
    // satisfied (one reconciled zero line); both configured fees are unrecorded.
    await expect(
      s.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: s.orgId, applicationId, notes: "established" })
    ).rejects.toThrow(/configured by this deal's finance company/i);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { accountingClassification: "CLASSIFIED" }));
    const expected = (await costsOf(s as never, applicationId)).expected;
    expect(expected.rows.map((row) => row.actual)).toEqual([null, null]);

    await expect(finalize(s, applicationId)).rejects.toThrow(/configured by this deal's finance company/i);
    expect(await salesOf(s)).toEqual([]);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("APPROVED");
    expect(app?.finalizedSaleId).toBeUndefined();
  });

  test("with every configured fee recorded and the deal classified under the stronger rule, the same deal finalizes (control)", async () => {
    const s = await seedFinalizable("recorded");
    const applicationId = await walkToClassification(s);

    const first = await s.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
      orgId: s.orgId,
      applicationId,
      templateIndex: 0,
      feeType: "APPRAISAL_FEE",
      actualAmountMinor: jod(80),
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    // Not charged: zero is a recorded fact, not a blank.
    const second = await s.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
      orgId: s.orgId,
      applicationId,
      templateIndex: 1,
      feeType: "COMMISSION",
      actualAmountMinor: 0,
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    for (const feeId of [first, second]) {
      await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "checked" });
    }
    await s.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: s.orgId, applicationId, notes: "established" });

    const saleId = await finalize(s, applicationId);
    expect(saleId).toBeTruthy();
    expect(await salesOf(s)).toHaveLength(1);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });
});

/**
 * The lines every closure rule is judged on come from ONE bounded read
 * (`loadActiveFees`) over the deal's LIVE lines, and the bound fails CLOSED:
 * past `MAX_LIVE_DEAL_FEE_LINES` the read refuses instead of returning a
 * prefix that reads like the whole. Live lines, not rows: removing a line
 * brings a deal back under the cap, so no deal is ever unreadable for good.
 * The overflow is seeded RAW — it is not a state the product's writers are
 * presented as free to create.
 */
describe("the bounded fee read behind every closure rule", () => {
  /** Live additional-cost lines written straight to the table — the only way to stand a deal AT or past the cap without the product's writers. */
  async function seedLiveLines(seed: Seed, applicationId: Id<"financeApplications">, count: number) {
    return await seed.t.run(async (ctx) => {
      const ids: Id<"financeDealFees">[] = [];
      for (let n = 0; n < count; n++) {
        ids.push(
          await ctx.db.insert("financeDealFees", {
            orgId: seed.orgId,
            applicationId,
            feeType: "OTHER_CLOSING_EXPENSE",
            description: `line ${n}`,
            currency: "JOD",
            actualAmountMinor: 1,
            paidBy: "DEALER",
            paidTo: "OTHER",
            accountingTreatment: "SELLING_EXPENSE",
            includedInQuotation: false,
            deductedFromSettlement: false,
            refundable: false,
            source: "MANUAL",
            createdBy: seed.userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );
      }
      return ids;
    });
  }
  const voidLine = (seed: Seed, feeId: Id<"financeDealFees">) =>
    seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "Recorded on the wrong deal." });

  test("past the live-line cap the screen and the classification door refuse without writing; removing one line makes the deal readable again", async () => {
    const seed = await seedDealer("cap");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    // Classification asks for the invoice before it reads a single line.
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId,
      applicationId,
      legalInvoiceAmountMinor: jod(20_000),
      legalInvoiceNumber: "INV-CAP",
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });

    // One past the cap, every one of them live.
    const seeded = await seedLiveLines(seed, applicationId, MAX_LIVE_DEAL_FEE_LINES + 1);
    const snapshotOf = () =>
      seed.t.run(async (ctx) => ({
        app: await ctx.db.get(applicationId),
        rows: await ctx.db
          .query("financeDealFees")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect(),
      }));
    const before = await snapshotOf();

    // The screen and the closure door refuse — for the bound, not for the
    // configured fees the checklist still has unrecorded — and write nothing.
    const overflow = new RegExp(`more than ${MAX_LIVE_DEAL_FEE_LINES} live cost lines`);
    await expect(costsOf(seed, applicationId)).rejects.toThrow(overflow);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId, notes: "x" })
    ).rejects.toThrow(overflow);
    expect(await snapshotOf()).toEqual(before);

    // The real void — a patch, not a delete — takes the deal back to the cap,
    // and the read serves again: the cap counts live lines only.
    await voidLine(seed, seeded[0]);
    const served = await costsOf(seed, applicationId);
    expect(served.fees).toHaveLength(MAX_LIVE_DEAL_FEE_LINES);
    expect(served.fees.map((fee) => fee._id)).not.toContain(seeded[0]);
    expect(served.expected.rows.map((row) => row.actual)).toEqual([null, null]);
    expect((await snapshotOf()).rows).toHaveLength(MAX_LIVE_DEAL_FEE_LINES + 1);
  });

  /**
   * The product never creates the state the read refuses: AT the cap, both
   * writers that create a line refuse the 501st — before the classification
   * is touched and with no command record kept — and after one line is
   * removed the same write goes through, whose exact replay then still wins
   * at the cap, because the bound is checked inside the idempotent section.
   */
  test("at the live-line cap both writers refuse a new line with no classification or command artifact; one removal permits it, and its exact replay still wins", async () => {
    const seed = await seedDealer("capWriters");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    const seeded = await seedLiveLines(seed, applicationId, MAX_LIVE_DEAL_FEE_LINES);
    // A legacy classification: what a refused write must leave exactly as it is.
    await seed.t.run((ctx) => ctx.db.patch(applicationId, { accountingClassification: "CLASSIFIED" }));
    const stateOf = () =>
      seed.t.run(async (ctx) => ({
        app: await ctx.db.get(applicationId),
        commands: (await ctx.db.query("commandIdempotency").collect()).length,
        overrides: (await ctx.db.query("financeApplicationOverrides").collect()).length,
        live: (await ctx.db
          .query("financeDealFees")
          .withIndex("by_application_voidedAt", (q) => q.eq("applicationId", applicationId).eq("voidedAt", undefined))
          .collect()).length,
      }));
    const before = await stateOf();
    expect(before.live).toBe(MAX_LIVE_DEAL_FEE_LINES);

    const atCap = new RegExp(`already has ${MAX_LIVE_DEAL_FEE_LINES} live cost lines`);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
        orgId: seed.orgId,
        applicationId,
        feeType: "OTHER_CLOSING_EXPENSE",
        paidBy: "DEALER",
        paidTo: "OTHER",
        accountingTreatment: "SELLING_EXPENSE",
        deductedFromSettlement: false,
        actualAmountMinor: jod(5),
        expectedCurrency: "JOD",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(atCap);
    await expect(recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(80))).rejects.toThrow(atCap);
    expect(await stateOf()).toEqual(before);

    // One removal makes room; the configured actual is recorded, and THAT
    // write is the one that clears the classification.
    await voidLine(seed, seeded[0]);
    const key = crypto.randomUUID();
    const feeId = await recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(80), { idempotencyKey: key });
    const recorded = await stateOf();
    expect(recorded.live).toBe(MAX_LIVE_DEAL_FEE_LINES);
    expect(recorded.app?.accountingClassification).toBe("PENDING_CLASSIFICATION");
    expect(recorded.commands).toBe(before.commands + 1);

    // Full again — and the exact replay of the line just written still wins.
    expect(await recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(80), { idempotencyKey: key })).toBe(feeId);
    expect(await stateOf()).toEqual(recorded);
  });
});
/**
 * A policy with more fees than a deal can carry live is a deal that can never
 * close. It is refused where the policy is WRITTEN or FROZEN, before any
 * write; a policy already on the record is never rewritten or truncated —
 * a legacy company past the cap still takes an unrelated edit and is
 * repaired by an explicit compliant list. A deal already frozen past the
 * configuration limit is held only to closure CAPACITY (the live-line cap):
 * within it the deal is still closeable; past it the closure door refuses
 * with the cause.
 */
describe("the fee-template cap", () => {
  const templates = (count: number): Template[] =>
    Array.from({ length: count }, (_, n) => ({ ...COMPANY_A_TEMPLATES[1], description: `Fee ${n}` }));
  const companyFields = { profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 80 };
  const tooMany = new RegExp(`${MAX_FEE_TEMPLATES + 1} fee templates is more than the ${MAX_FEE_TEMPLATES} one finance company can configure`);
  const policyTables = (seed: Seed) =>
    seed.t.run(async (ctx) => ({
      companies: await ctx.db.query("financeCompanies").collect(),
      versions: await ctx.db.query("financeCompanyRuleVersions").collect(),
      applications: await ctx.db.query("financeApplications").collect(),
    }));

  test("create and update refuse feeTemplates configuration because fee templates are retired", async () => {
    expect(MAX_FEE_TEMPLATES).toBeLessThan(MAX_LIVE_DEAL_FEE_LINES);
    const seed = await seedDealer("templateCap");
    await expect(
      seed.asUser.mutation(api.finance.createCompany, {
        orgId: seed.orgId,
        name: "Retired",
        ...companyFields,
        feeTemplates: templates(1),
      })
    ).rejects.toThrow(/Configuring company fee templates is retired/i);

    const companyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Legacy",
        ...companyFields,
      })
    );
    await expect(
      seed.asUser.mutation(api.finance.updateCompany, {
        expectedEditRevision: 1,
        orgId: seed.orgId,
        id: companyId,
        name: "Legacy",
        ...companyFields,
        feeTemplates: templates(1),
      })
    ).rejects.toThrow(/Updating company fee templates is retired/i);
  });

  test("a legacy company past the cap: an unrelated edit still saves with the list verbatim, and adopting adminFees clears it", async () => {
    const seed = await seedDealer("legacyOversize");
    const oversized = templates(MAX_FEE_TEMPLATES + 1);
    const companyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", { orgId: seed.orgId, name: "Legacy", ...companyFields, feeTemplates: oversized })
    );

    await seed.asUser.mutation(api.finance.updateCompany, {
        expectedEditRevision: 1, orgId: seed.orgId, id: companyId, name: "Legacy, renamed", ...companyFields });
    const renamed = await seed.t.run((ctx) => ctx.db.get(companyId));
    expect(renamed?.name).toBe("Legacy, renamed");
    expect(renamed?.feeTemplates).toEqual(oversized);

    // Updating with feeTemplates is rejected as retired
    await expect(
      seed.asUser.mutation(api.finance.updateCompany, {
        expectedEditRevision: 2,
        orgId: seed.orgId,
        id: companyId,
        name: "Legacy, renamed",
        ...companyFields,
        feeTemplates: templates(2),
      })
    ).rejects.toThrow(/Updating company fee templates is retired/i);

    // Adopting adminFees clears legacy feeTemplates
    await seed.asUser.mutation(api.finance.updateCompany, {
        expectedEditRevision: 2,
      orgId: seed.orgId,
      id: companyId,
      name: "Legacy, modernized",
      ...companyFields,
      adminFees: 500,
    });
    const modernized = await seed.t.run((ctx) => ctx.db.get(companyId));
    expect(modernized?.adminFees).toBe(500);
    expect(modernized?.feeTemplates).toBeUndefined();
  });

  test("a deal already frozen past closure capacity is refused at the closure door with the cause, not a count of unrecorded fees", async () => {
    const seed = await seedDealer("frozenOversize");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    // Frozen before any cap existed, past what a deal can ever carry live.
    // (One past the CONFIGURATION limit would still be closeable and is not
    // what this door refuses.)
    await seed.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (!app?.companyRuleSnapshot) throw new Error("no snapshot");
      await ctx.db.patch(applicationId, {
        companyRuleSnapshot: { ...app.companyRuleSnapshot, feeTemplates: templates(MAX_LIVE_DEAL_FEE_LINES + 1) },
      });
    });
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId,
      applicationId,
      legalInvoiceAmountMinor: jod(20_000),
      legalInvoiceNumber: "INV-OVERSIZE",
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await recordTemplateActual(seed, applicationId, 0, "LICENSING", jod(250));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "checked" });
    const classify = () =>
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId, notes: "x" });

    await expect(classify()).rejects.toThrow(
      new RegExp(`frozen finance-company policy configures ${MAX_LIVE_DEAL_FEE_LINES + 1} fees, more than the ${MAX_LIVE_DEAL_FEE_LINES} live cost lines`)
    );

    // Control: one past the CONFIGURATION limit is within capacity — still
    // closeable, so the door asks for the unrecorded fees, not the cause above.
    await seed.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (!app?.companyRuleSnapshot) throw new Error("no snapshot");
      await ctx.db.patch(applicationId, {
        companyRuleSnapshot: { ...app.companyRuleSnapshot, feeTemplates: templates(MAX_FEE_TEMPLATES + 1) },
      });
    });
    await expect(classify()).rejects.toThrow(new RegExp(`^${MAX_FEE_TEMPLATES} fee\\(s\\) configured by this deal's finance company have no actual`));
  });
});

describe("closing the deal", () => {
  async function invoiced(seed: Seed, applicationId: Id<"financeApplications">) {
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId,
      applicationId,
      legalInvoiceAmountMinor: jod(20_000),
      legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
  }
  async function reconcile(seed: Seed, feeId: Id<"financeDealFees">) {
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId,
      feeId,
      notes: "checked against the receipt",
    });
  }
  const classify = (seed: Seed, applicationId: Id<"financeApplications">) =>
    seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId,
      applicationId,
      notes: "established",
    });

  /**
   * The closure invariant the checklist alone cannot hold. Expected rows are
   * derived, not lines, so `linesAwaitingActual` cannot see a configured fee
   * nobody recorded: with two templates and ONE reconciled actual the old gate
   * saw one line, fully reconciled, and would have classified the deal with a
   * configured cost silently missing. The server asks the snapshot directly.
   */
  test("two configured fees, one actual recorded: classification is refused until the second is recorded too", async () => {
    const seed = await seedDealer("close");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await invoiced(seed, applicationId);

    const first = await recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(80));
    await reconcile(seed, first);
    // The line-based counts are satisfied — that is the point.
    const costs = await costsOf(seed, applicationId);
    expect(costs.summary?.linesAwaitingActual).toBe(0);
    expect(costs.summary?.linesAwaitingReconciliation).toBe(0);

    await expect(classify(seed, applicationId)).rejects.toThrow(/configured by this deal's finance company/i);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.accountingClassification).not.toBe("CLASSIFIED");

    // Not charged is a fact too: zero, recorded, reconciled.
    const second = await recordTemplateActual(seed, applicationId, 1, "COMMISSION", 0);
    await reconcile(seed, second);
    await classify(seed, applicationId);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  });

  /**
   * Client spoofing of the checklist. `recordDealFee` used to accept
   * `source: "COMPANY_TEMPLATE"` from the caller, and a line carrying that
   * source with a matching feeType + description reads exactly like a legacy
   * template line — so a client could author one and have the checklist, and
   * the closure gate, treat a configured fee as recorded. Two guards, both
   * asserted directly: the public writer refuses to mint that source at all,
   * and closure accepts only an EXACT (position-addressed) match, never an
   * identity match — a legacy line, or a spoofed one, can still be shown
   * beside its template, but it cannot close the deal.
   */
  test("recordDealFee cannot author a COMPANY_TEMPLATE line", async () => {
    const seed = await seedDealer("spoofWrite");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
        orgId: seed.orgId,
        applicationId,
        feeType: "APPRAISAL_FEE",
        description: "Valuation",
        actualAmountMinor: jod(80),
        paidBy: "DEALER",
        paidTo: "APPRAISER",
        accountingTreatment: "APPRAISAL_EXPENSE",
        source: "COMPANY_TEMPLATE",
        expectedCurrency: "JOD",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/configured fee/i);
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });

  test("a no-position COMPANY_TEMPLATE line — legacy or client-authored — cannot satisfy configured closure", async () => {
    const seed = await seedDealer("spoofClose");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    await invoiced(seed, applicationId);

    // One exact actual, one line that only LOOKS like the other template:
    // the legacy shape, written straight to the table with no position.
    const exact = await recordTemplateActual(seed, applicationId, 0, "APPRAISAL_FEE", jod(80));
    await reconcile(seed, exact);
    const lookalike = await seed.t.run((ctx) =>
      ctx.db.insert("financeDealFees", {
        orgId: seed.orgId,
        applicationId,
        feeType: "COMMISSION",
        description: "Commission",
        currency: "JOD",
        estimatedAmountMinor: jod(300),
        actualAmountMinor: jod(300),
        paidBy: "DEALER",
        paidTo: "FINANCE_COMPANY",
        accountingTreatment: "FINANCE_COMPANY_COMMISSION",
        includedInQuotation: false,
        deductedFromSettlement: true,
        refundable: false,
        source: "COMPANY_TEMPLATE",
        reconciledAt: Date.now(),
        reconciledBy: seed.userId,
        createdBy: seed.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    // The checklist does NOT attach it to the configured row: the row stays
    // open with its exact record action, and the look-alike is listed as an
    // unplanned line. The line-based counts are satisfied; closure refuses.
    const expected = (await costsOf(seed, applicationId)).expected;
    expect(expected.rows[1].actual).toBeNull();
    expect(expected.unplannedLineIds).toEqual([lookalike]);
    await expect(classify(seed, applicationId)).rejects.toThrow(/configured by this deal's finance company/i);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.accountingClassification).not.toBe("CLASSIFIED");

    // The exact recording is still possible — the look-alike did not take the
    // position — and once reconciled the deal closes. Both lines count toward
    // the recorded actual until somebody voids the look-alike: that is visible
    // in the totals, never hidden behind a filled row.
    const exactSecond = await recordTemplateActual(seed, applicationId, 1, "COMMISSION", jod(300));
    await reconcile(seed, exactSecond);
    const after = (await costsOf(seed, applicationId)).expected;
    expect(after.rows[1].actual).toMatchObject({ feeId: exactSecond });
    expect(after.unplannedLineIds).toEqual([lookalike]);
    expect(after.actualTotalMinor).toBe(jod(80) + jod(300) + jod(300));
    await classify(seed, applicationId);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  });

  test("paidAt on a configured actual must be a real timestamp", async () => {
    const seed = await seedDealer("paidAt");
    const companyId = await createCompany(seed, "Two Fees", COMPANY_B_TEMPLATES);
    const applicationId = await createApplicationFor(seed, companyId);
    for (const paidAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 53]) {
      await expect(
        seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
          orgId: seed.orgId,
          applicationId,
          templateIndex: 0,
          feeType: "APPRAISAL_FEE",
          actualAmountMinor: jod(80),
          expectedCurrency: "JOD",
          paidAt,
          idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toThrow(/paid/i);
    }
    expect(await liveFees(seed, applicationId)).toEqual([]);
  });

  test("a deal whose company configured no fees is held to the line rules only (control)", async () => {
    const seed = await seedDealer("closeNone");
    const companyId = await createCompany(seed, "Bare Company", []);
    const applicationId = await createApplicationFor(seed, companyId);
    await invoiced(seed, applicationId);
    const feeId = await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
      orgId: seed.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      actualAmountMinor: 0,
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      source: "MANUAL",
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    await reconcile(seed, feeId);
    await classify(seed, applicationId);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  });
});
