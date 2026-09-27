import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  PERMISSIONS,
  type Permission,
} from "./utils/permissions";

/**
 * SCRUM-404 — the wizard records the AutoFlow-calculated quotation when it
 * creates a financed deal, on the operator's explicit confirmation.
 *
 * The invariant: a financed deal carries a submitted quotation only if a person
 * with quotation authority confirmed that exact figure; for SYSTEM_CALCULATED
 * the figure equals what the server's solver produces from the application's
 * own frozen inputs at the moment of writing; creation and recording commit
 * atomically or not at all.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type Caller = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

afterEach(() => {
  vi.useRealTimers();
});

/** JOD minor units (scale 3), matching getOrgCurrency's default. */
const jod = (major: number): number => Math.round(major * 1000);

/**
 * cost 9,500 · target 10,500 · first payment 500 · execution fees 625 · LTV 85%
 * → quotation 12,500 (the confirmed deal in financingEconomics.test.ts, with its
 * 625 carried by the company's execution fees instead of by hand).
 */
const DEAL = {
  targetSelling: 10_500,
  customerFirstPayment: 500,
  executionFees: 625,
  quotation: 12_500,
  ltvPercent: 85,
};

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  customerId: Id<"customers">;
  customerStatusId: Id<"orgCustomerStatuses">;
  vehicleId: Id<"vehicles">;
  companyId: Id<"financeCompanies">;
  /** System OWNER: every permission, `view:finance` included. */
  asOwner: Caller;
  asRole: (permissions: Permission[]) => Promise<{ caller: Caller; userId: Id<"users"> }>;
}

async function seedDealer(
  company: Partial<{
    defaultLtvPercent: number;
    minimumCustomerFirstPaymentMinor: number;
    adminFees: number;
  }> = {},
  vehicleSellingPrice = DEAL.targetSelling
): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "SCRUM-404 Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s404_owner", email: "s404@example.com", name: "Owner" })
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
  const asOwner = t.withIdentity({ subject: "s404_owner" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "S404VIN",
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 9_500,
      sellingPrice: vehicleSellingPrice,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Quote", lastName: "Customer" })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  // A document rule, so a creation that commits writes an applicationDocuments
  // row — without one the rollback assertions below would be vacuous for it.
  await t.run((ctx) =>
    ctx.db.insert("companyDocumentRules", { orgId, documentName: "National ID", isRequired: true })
  );

  const companyId = await asOwner.mutation(api.finance.createCompany, {
    orgId,
    name: "Jordan Finance",
    profitRate: 5,
    maxTermMonths: 60,
    gracePeriodMonths: 0,
    isActive: true,
    adminFees: company.adminFees ?? DEAL.executionFees,
    maxFinancingLTV: 85,
    defaultLtvPercent: company.defaultLtvPercent ?? DEAL.ltvPercent,
    customerFirstPaymentOffsetsUnfinancedShare: true,
    ...(company.minimumCustomerFirstPaymentMinor !== undefined
      ? { minimumCustomerFirstPaymentMinor: company.minimumCustomerFirstPaymentMinor }
      : {}),
  });

  let seq = 0;
  const asRole = async (permissions: Permission[]) => {
    seq += 1;
    const clerkId = `s404_role_${seq}`;
    const roleUserId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        clerkId,
        email: `${clerkId}@example.com`,
        name: clerkId,
      });
      const rid = await ctx.db.insert("roles", { orgId, name: `ROLE_${seq}`, permissions });
      await ctx.db.insert("memberships", { orgId, userId: id, roleId: rid });
      return id;
    });
    return { caller: t.withIdentity({ subject: clerkId }), userId: roleUserId };
  };

  return { t, orgId, userId, customerId, customerStatusId, vehicleId, companyId, asOwner, asRole };
}

const template = (name: string): Permission[] => {
  const found = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name);
  if (!found) throw new Error(`no ${name} template`);
  return [...found.permissions];
};

/**
 * Can create a deal (`create:sales`) and read the quote (`view:customers`),
 * but holds no quotation-workflow permission at all.
 */
const SALES_WITHOUT_FINANCE: Permission[] = [
  PERMISSIONS.VIEW_CUSTOMERS,
  PERMISSIONS.VIEW_SALES,
  PERMISSIONS.CREATE_SALES,
];

async function saveQuote(
  seed: Seed,
  overrides: Partial<{ vehiclePrice: number; downPayment: number }> = {}
): Promise<Id<"quotes">> {
  return await seed.asOwner.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId: seed.vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: seed.companyId,
    customerEligibilityStatusIds: [seed.customerStatusId],
    vehiclePrice: overrides.vehiclePrice ?? DEAL.targetSelling,
    downPayment: overrides.downPayment ?? DEAL.customerFirstPayment,
    termMonths: 48,
    totalFinancedAmount: 10_736,
  });
}

async function preview(caller: Caller, seed: Seed, quoteId: Id<"quotes">) {
  return await caller.query(api.financingEconomics.previewCreationQuotation, {
    orgId: seed.orgId,
    quoteId,
  });
}

/** Every row a financed-deal creation writes, counted, so a rollback is provable. */
async function footprint(seed: Seed) {
  return await seed.t.run(async (ctx) => ({
    financeApplications: (await ctx.db.query("financeApplications").collect()).length,
    applicationStatusLog: (await ctx.db.query("applicationStatusLog").collect()).length,
    applicationDocuments: (await ctx.db.query("applicationDocuments").collect()).length,
    commitmentRoots: (await ctx.db.query("commitmentRoots").collect()).length,
    vehicleCommitmentClaims: (await ctx.db.query("vehicleCommitmentClaims").collect()).length,
    notifications: (await ctx.db.query("notifications").collect()).length,
    financeApplicationOverrides: (await ctx.db.query("financeApplicationOverrides").collect())
      .length,
    scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
  }));
}

async function readApp(seed: Seed, applicationId: Id<"financeApplications">) {
  const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
  if (!app) throw new Error("application vanished");
  return app;
}

async function availableFigure(caller: Caller, seed: Seed, quoteId: Id<"quotes">) {
  const answer = await preview(caller, seed, quoteId);
  if (!answer.available) throw new Error(`preview unavailable: ${answer.reason}`);
  return answer.submittedQuotationMinor;
}

// ---------------------------------------------------------------------------

describe("creating a financed deal with the confirmed calculated quotation (SCRUM-404)", () => {
  test("T1: records exactly the previewed figure as the creator's SYSTEM_CALCULATED quotation", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const figure = await availableFigure(seed.asOwner, seed, quoteId);
    expect(figure).toBe(jod(DEAL.quotation));

    const applicationId = await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      confirmedCalculatedQuotationMinor: figure,
    });

    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBe(figure);
    expect(app.submittedQuotationSource).toBe("SYSTEM_CALCULATED");
    expect(app.submittedQuotationBy).toBe(seed.userId);
    expect(app.submittedQuotationAt).toBeTypeOf("number");
    expect(app.appliedLtvPercent).toBe(DEAL.ltvPercent);
    expect(app.appraisalStatus).toBe("PENDING");
    expect(app.quotationCalculationSnapshot).toMatchObject({
      mode: "SYSTEM_CALCULATED",
      calculatedQuotationMinor: figure,
      finalQuotationMinor: figure,
      recordedVia: "DEAL_CREATION",
      recordedBy: seed.userId,
      appliedLtvPercent: DEAL.ltvPercent,
    });
  });

  test("T2: without a confirmation, creation is exactly today's — no quotation recorded", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);

    const applicationId = await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBeUndefined();
    expect(app.submittedQuotationSource).toBeUndefined();
    expect(app.quotationCalculationSnapshot).toBeUndefined();
    expect(app.appliedLtvPercent).toBeUndefined();
    expect(app.appraisalStatus).toBe("NOT_REQUESTED");
    expect(app.targetSellingAmountMinor).toBe(jod(DEAL.targetSelling));
    expect(app.customerFirstPaymentMinor).toBe(jod(DEAL.customerFirstPayment));
    expect(app.estimatedDealerBorneExpensesMinor).toBe(jod(DEAL.executionFees));
  });

  test("T3: a stale confirmation refuses and leaves NOTHING behind", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const shown = await availableFigure(seed.asOwner, seed, quoteId);

    // The quote moves after the operator saw the figure.
    await seed.t.run((ctx) => ctx.db.patch(quoteId, { downPayment: 900 }));
    const moved = await availableFigure(seed.asOwner, seed, quoteId);
    expect(moved).not.toBe(shown);

    const before = await footprint(seed);
    await expect(
      seed.asOwner.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
        confirmedCalculatedQuotationMinor: shown,
      })
    ).rejects.toThrow(/changed after it was shown/);
    expect(await footprint(seed)).toEqual(before);

    // Control: the same quote with the current figure commits every one of
    // those rows, so the equality above is not vacuous.
    await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      confirmedCalculatedQuotationMinor: moved,
    });
    const after = await footprint(seed);
    expect(after.financeApplications).toBe(before.financeApplications + 1);
    expect(after.applicationStatusLog).toBeGreaterThan(before.applicationStatusLog);
    expect(after.applicationDocuments).toBeGreaterThan(before.applicationDocuments);
    expect(after.vehicleCommitmentClaims).toBeGreaterThan(before.vehicleCommitmentClaims);
    expect(after.notifications).toBeGreaterThan(before.notifications);
  });

  test("T4: a creator without create:finance_application may not confirm, and nothing is written", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const figure = await availableFigure(seed.asOwner, seed, quoteId);
    const { caller: salesOnly } = await seed.asRole(SALES_WITHOUT_FINANCE);

    const before = await footprint(seed);
    await expect(
      salesOnly.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
        confirmedCalculatedQuotationMinor: figure,
      })
    ).rejects.toThrow(/needs finance-application access/);
    expect(await footprint(seed)).toEqual(before);

    // The same role, without a confirmation: today's creation, unchanged.
    const applicationId = await salesOnly.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    expect((await readApp(seed, applicationId)).submittedQuotationMinor).toBeUndefined();
  });

  test("T4b: the default MANAGER (create:finance_application, no view:finance) may confirm", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const { caller: manager, userId: managerId } = await seed.asRole(template("MANAGER"));
    const figure = await availableFigure(manager, seed, quoteId);

    const applicationId = await manager.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      confirmedCalculatedQuotationMinor: figure,
    });
    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBe(figure);
    expect(app.submittedQuotationBy).toBe(managerId);
  });
});

describe("the creation-time quotation preview's read boundary (SCRUM-404)", () => {
  test("T5: a role without quotation-workflow authority gets NOT_AUTHORIZED — decided before any read", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const { caller: salesOnly } = await seed.asRole(SALES_WITHOUT_FINANCE);

    expect(await preview(salesOnly, seed, quoteId)).toEqual({
      available: false,
      reason: "NOT_AUTHORIZED",
    });

    // BEFORE the read: a quote that does not belong to this org gets the same
    // answer, not a tenancy refusal — the role decided it, the row never did.
    const foreignQuoteId = await foreignQuote(seed);
    expect(await preview(salesOnly, seed, foreignQuoteId)).toEqual({
      available: false,
      reason: "NOT_AUTHORIZED",
    });
  });

  test("T5: a foreign quote throws for an authorized caller — tenancy is never 'unavailable'", async () => {
    const seed = await seedDealer();
    const foreignQuoteId = await foreignQuote(seed);
    await expect(preview(seed.asOwner, seed, foreignQuoteId)).rejects.toThrow(/Quote not found/);
  });

  test("T5: a manual-company quote is NOT_CONFIGURED_COMPANY", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    await seed.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        mode: "MANUAL_FINANCE_COMPANY",
        companyId: undefined,
        companyRuleSnapshot: undefined,
        manualProviderName: "Local Bank",
        manualAdminFees: 0,
      })
    );
    expect(await preview(seed.asOwner, seed, quoteId)).toEqual({
      available: false,
      reason: "NOT_CONFIGURED_COMPANY",
    });
  });

  test("T6: a rule refusal is RULES_UNAVAILABLE without view:finance, and the message with it", async () => {
    const seed = await seedDealer({ minimumCustomerFirstPaymentMinor: jod(1_000) });
    const quoteId = await saveQuote(seed, { downPayment: 500 });
    const { caller: manager } = await seed.asRole(template("MANAGER"));

    const forManager = await preview(manager, seed, quoteId);
    expect(forManager).toEqual({ available: false, reason: "RULES_UNAVAILABLE" });
    expect(JSON.stringify(forManager)).not.toContain(String(jod(1_000)));

    const forFinance = await preview(seed.asOwner, seed, quoteId);
    expect(forFinance.available).toBe(false);
    expect(!forFinance.available && forFinance.reason).toMatch(/first payment of at least/);
  });

  test("T7: an amount that overflows at a tiny LTV is unavailable for every role, never a throw", async () => {
    // 0.000001% is the smallest LTV the company validator accepts (it does not
    // round to zero). 100,000 JOD at that rate needs ~10^16 minor units, above
    // Number.MAX_SAFE_INTEGER, while the target and fees are representable.
    const seed = await seedDealer({ defaultLtvPercent: 0.000001, adminFees: 0 }, 100_000);
    const quoteId = await saveQuote(seed, { vehiclePrice: 100_000, downPayment: 500 });
    const { caller: manager } = await seed.asRole(template("MANAGER"));

    expect(await preview(manager, seed, quoteId)).toEqual({
      available: false,
      reason: "RULES_UNAVAILABLE",
    });
    const forFinance = await preview(seed.asOwner, seed, quoteId);
    expect(forFinance.available).toBe(false);
    expect(!forFinance.available && forFinance.reason).toMatch(/overflows safe integer/);

    // A forged confirmation on the same quote: refused, nothing written.
    const before = await footprint(seed);
    await expect(
      seed.asOwner.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
        confirmedCalculatedQuotationMinor: 1,
      })
    ).rejects.toThrow();
    expect(await footprint(seed)).toEqual(before);
  });

  test("T9: the previewed figure IS the figure createFromQuote records (fees and first payment)", async () => {
    const seed = await seedDealer({ adminFees: 700 });
    const quoteId = await saveQuote(seed, { downPayment: 1_250 });
    const figure = await availableFigure(seed.asOwner, seed, quoteId);

    const applicationId = await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      confirmedCalculatedQuotationMinor: figure,
    });
    const app = await readApp(seed, applicationId);
    expect(app.estimatedDealerBorneExpensesMinor).toBe(jod(700));
    expect(app.customerFirstPaymentMinor).toBe(jod(1_250));
    expect(app.submittedQuotationMinor).toBe(figure);

    // And the deal page's calculator, on the created deal, agrees.
    const onDeal = await seed.asOwner.query(
      api.financingEconomics.suggestQuotationForApplication,
      { orgId: seed.orgId, applicationId }
    );
    expect(onDeal.available && onDeal.submittedQuotationMinor).toBe(figure);
  });
});

/** A quote in a second organization, inserted raw — the preview must never read it. */
async function foreignQuote(seed: Seed): Promise<Id<"quotes">> {
  return await seed.t.run(async (ctx) => {
    const otherOrg = await ctx.db.insert("organizations", {
      name: "Other Dealer",
      createdAt: Date.now(),
    });
    return await ctx.db.insert("quotes", {
      orgId: otherOrg,
      customerId: seed.customerId,
      vehicleId: seed.vehicleId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: seed.companyId,
      vehiclePrice: DEAL.targetSelling,
      downPayment: DEAL.customerFirstPayment,
      termMonths: 48,
      status: "DRAFT",
      createdBy: seed.userId,
      createdAt: Date.now(),
    });
  });
}

describe("the recorder's public door keeps its pre-read authority (SCRUM-404 B2)", () => {
  test("T8: an unauthorized explicit LTV is refused identically for owned, missing and foreign ids, with zero writes", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const owned = await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    const { missing, foreign } = await seed.t.run(async (ctx) => {
      const template = (await ctx.db.get(owned))!;
      const { _id, _creationTime, ...fields } = template;
      const gone = await ctx.db.insert("financeApplications", fields);
      await ctx.db.delete(gone);
      const otherOrg = await ctx.db.insert("organizations", {
        name: "Foreign Dealer",
        createdAt: Date.now(),
      });
      const elsewhere = await ctx.db.insert("financeApplications", { ...fields, orgId: otherOrg });
      return { missing: gone, foreign: elsewhere };
    });
    // Records quotations, but may not name a rate: create:finance_application
    // without view:finance.
    const { caller: manager } = await seed.asRole(template("MANAGER"));

    const ownedBefore = await readApp(seed, owned);
    const before = await footprint(seed);
    const refusals: string[] = [];
    for (const applicationId of [owned, missing, foreign]) {
      const error = await manager
        .mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: seed.orgId,
          applicationId,
          submittedQuotationMinor: jod(DEAL.quotation),
          source: "SYSTEM_CALCULATED",
          ltvPercent: 80,
        })
        .then(
          () => null,
          (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown))
        );
      refusals.push(String(error));
    }
    expect(refusals[0]).toMatch(/Setting the LTV this deal is financed at/);
    expect(new Set(refusals).size).toBe(1);
    expect(await footprint(seed)).toEqual(before);
    expect(await readApp(seed, owned)).toEqual(ownedBefore);
  });

  test("T10: a re-record from the deal page is audited and names RECORD_DIALOG; an identical retry keeps DEAL_CREATION", async () => {
    const seed = await seedDealer();
    const quoteId = await saveQuote(seed);
    const figure = await availableFigure(seed.asOwner, seed, quoteId);
    const applicationId = await seed.asOwner.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      confirmedCalculatedQuotationMinor: figure,
    });

    // Identical retry by the same person: not a new record.
    await seed.asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: figure,
      source: "SYSTEM_CALCULATED",
    });
    expect((await readApp(seed, applicationId)).quotationCalculationSnapshot?.recordedVia).toBe(
      "DEAL_CREATION"
    );
    const auditBefore = await seed.t.run(async (ctx) =>
      (await ctx.db.query("financeApplicationOverrides").collect()).filter(
        (row) => row.applicationId === applicationId && row.field === "submittedQuotationMinor"
      )
    );
    expect(auditBefore).toHaveLength(0);

    // A correction from the Record dialog: a different figure, as an entry.
    await seed.asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: seed.orgId,
      applicationId,
      submittedQuotationMinor: jod(13_000),
      source: "MANUAL_ENTRY",
    });
    const app = await readApp(seed, applicationId);
    expect(app.submittedQuotationMinor).toBe(jod(13_000));
    expect(app.quotationCalculationSnapshot?.recordedVia).toBe("RECORD_DIALOG");
    const audit = await seed.t.run(async (ctx) =>
      (await ctx.db.query("financeApplicationOverrides").collect()).filter(
        (row) => row.applicationId === applicationId && row.field === "submittedQuotationMinor"
      )
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].previousValue).toContain(String(figure));
    expect(audit[0].newValue).toContain(String(jod(13_000)));
  });
});
