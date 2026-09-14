import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { deriveExpectedFees } from "./financeDealCosts";

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
  return { t, orgId, userId, asUser: t.withIdentity({ subject: `exp_user_${suffix}` }), customerId, vehicleId };
}

async function createCompany(seed: Seed, name: string, feeTemplates: Template[]) {
  return await seed.asUser.mutation(api.finance.createCompany, {
    orgId: seed.orgId,
    name,
    profitRate: 5,
    maxTermMonths: 60,
    gracePeriodMonths: 0,
    defaultLtvPercent: 80,
    isActive: true,
    feeTemplates,
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
    totalFinancedAmount: 20_000,
  });
  return await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
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
    await seed.asUser.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId: seed.orgId,
      name: company.name,
      profitRate: company.profitRate,
      maxTermMonths: company.maxTermMonths,
      gracePeriodMonths: company.gracePeriodMonths,
      isActive: true,
      feeTemplates: COMPANY_B_TEMPLATES,
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
