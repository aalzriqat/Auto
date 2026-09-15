import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";

/**
 * Adopting a finance company's configured fees onto a deal that was frozen
 * before the company had any.
 *
 * The snapshot is frozen at creation (owner ruling, #scrum-215 2026-09-12).
 * That is preserved here: nothing in a READ ever consults the live company for
 * a deal's expected fees, and a snapshot that already carries templates is
 * never rewritten. What this adds is an honest state on the read model and an
 * explicit, owner-only, audited act to fill an EMPTY slot before the deal is
 * costed — the one boundary at which adopting a policy rewrites nothing.
 */

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
  {
    feeType: "STAMPS" as const,
    description: "Legal stamps",
    estimatedAmountMinor: jod(90),
    paidBy: "DEALER" as const,
    paidTo: "GOVERNMENT" as const,
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
  },
];

const COMPANY_FIELDS = { profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true };

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  asOwner: AuthenticatedTestConvex;
  customerId: Id<"customers">;
  vehicleId: Id<"vehicles">;
}

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
  return { t, orgId, userId, asOwner: t.withIdentity({ subject: `adopt_user_${suffix}` }), customerId, vehicleId };
}

/** A company created WITHOUT fees, an application frozen under it, THEN the fees configured. */
async function dealFrozenBeforeFees(s: Seed) {
  const companyId = await s.asOwner.mutation(api.finance.createCompany, {
    orgId: s.orgId,
    name: "Late Fees Finance",
    defaultLtvPercent: 80,
    ...COMPANY_FIELDS,
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
    totalFinancedAmount: 20_000,
  });
  const applicationId = await s.asOwner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.asOwner.mutation(api.finance.updateCompany, {
    id: companyId,
    orgId: s.orgId,
    name: "Late Fees Finance",
    ...COMPANY_FIELDS,
    feeTemplates: TEMPLATES,
  });
  return { companyId, applicationId };
}

async function costsOf(s: Seed, applicationId: Id<"financeApplications">) {
  return await s.asOwner.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId });
}

describe("fee-template adoption", () => {
  test("a deal frozen before the company had fees reports NO_TEMPLATES, and that the company now has some", async () => {
    const s = await seedDealer("1");
    const { applicationId } = await dealFrozenBeforeFees(s);
    const costs = await costsOf(s, applicationId);
    // The frozen snapshot is NOT rewritten by the company edit — the read
    // still says nothing is expected. That is the immutability property.
    expect(costs.expected.source).toBe("NO_TEMPLATES");
    expect(costs.expected.expectedTotalMinor).toBeNull();
    // ...and the honest state says why, and what can be done.
    expect(costs.expected.adoption).toEqual({
      state: "AVAILABLE",
      liveTemplateCount: 2,
      liveRuleVersion: 2,
      adopted: null,
    });
  });

  test("adoption fills the empty slot, is audited, and the checklist then expects the configured fees", async () => {
    const s = await seedDealer("2");
    const { applicationId } = await dealFrozenBeforeFees(s);
    const result = await s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, {
      orgId: s.orgId,
      applicationId,
      reason: "Company fees were configured the day after the deal opened.",
    });
    expect(result).toEqual({ adoptedCount: 2, fromRuleVersion: 2 });

    const costs = await costsOf(s, applicationId);
    expect(costs.expected.source).toBe("COMPANY_RULE_SNAPSHOT");
    expect(costs.expected.expectedTotalMinor).toBe(jod(340));
    expect(costs.expected.rows.map((r) => r.feeType)).toEqual(["LICENSING", "STAMPS"]);
    expect(costs.expected.adoption.state).toBe("NOT_NEEDED");
    expect(costs.expected.adoption.adopted?.fromRuleVersion).toBe(2);

    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    // The purchase rules keep their own frozen version; the snapshot records
    // that the FEES came from a later revision, by whom and when.
    expect(app?.companyRuleSnapshot?.ruleVersion).toBe(1);
    expect(app?.companyRuleSnapshot?.feeTemplatesAdoptedFromRuleVersion).toBe(2);
    expect(app?.companyRuleSnapshot?.feeTemplatesAdoptedBy).toBe(s.userId);
    expect(app?.companyRuleSnapshot?.defaultLtvPercent).toBe(80);

    const overrides = await s.t.run(async (ctx) =>
      (await ctx.db.query("financeApplicationOverrides").collect()).filter(
        (row) => row.applicationId === applicationId && row.field === "companyRuleSnapshot.feeTemplates"
      )
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0].reason).toContain("day after");
    expect(overrides[0].newValue).toContain("rule version 2");
  });

  test("adopted templates are frozen in turn: a later company edit does not reach the deal", async () => {
    const s = await seedDealer("3");
    const { companyId, applicationId } = await dealFrozenBeforeFees(s);
    await s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "late" });
    await s.asOwner.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId: s.orgId,
      name: "Late Fees Finance",
      ...COMPANY_FIELDS,
      feeTemplates: [{ ...TEMPLATES[0], estimatedAmountMinor: jod(999) }],
    });
    const costs = await costsOf(s, applicationId);
    expect(costs.expected.expectedTotalMinor).toBe(jod(340));
    expect(costs.expected.rows).toHaveLength(2);
    // And it cannot be adopted again — the slot is no longer empty.
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "again" })
    ).rejects.toThrow(/never replaced/);
  });

  test("a deal frozen WITH fees is NOT_NEEDED and is never rewritten", async () => {
    const s = await seedDealer("4");
    const companyId = await s.asOwner.mutation(api.finance.createCompany, {
      orgId: s.orgId,
      name: "Configured Finance",
      defaultLtvPercent: 80,
      ...COMPANY_FIELDS,
      feeTemplates: TEMPLATES,
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
      totalFinancedAmount: 20_000,
    });
    const applicationId = await s.asOwner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    const costs = await costsOf(s, applicationId);
    expect(costs.expected.source).toBe("COMPANY_RULE_SNAPSHOT");
    expect(costs.expected.adoption.state).toBe("NOT_NEEDED");
    expect(costs.expected.adoption.adopted).toBeNull();
  });

  test("blocked once a cost line exists — the deal was costed without a policy", async () => {
    const s = await seedDealer("5");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      description: "Courier",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      actualAmountMinor: jod(10),
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    const costs = await costsOf(s, applicationId);
    expect(costs.expected.adoption.state).toBe("BLOCKED_COSTS_RECORDED");
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow(/already been recorded/);
  });

  test("blocked once a custody record exists — one indexed row is all the mutation needs to know", async () => {
    const s = await seedDealer("11");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await s.t.run((ctx) =>
      ctx.db.insert("financeDealCustody", {
        orgId: s.orgId, applicationId, userId: s.userId, currency: "JOD",
        issuedMinor: 100_000, returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    expect((await costsOf(s, applicationId)).expected.adoption.state).toBe("BLOCKED_COSTS_RECORDED");
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow(/already been recorded/);
  });

  test("blocked once the vehicle is handed over or the deal is closed", async () => {
    const s = await seedDealer("6");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: Date.now(), handoverStatus: "HANDED_OVER" }));
    expect((await costsOf(s, applicationId)).expected.adoption.state).toBe("BLOCKED_DEAL_PROGRESSED");
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow(/handed over|closed/);
  });

  test("a company with no fees configured has nothing to adopt", async () => {
    const s = await seedDealer("7");
    const companyId = await s.asOwner.mutation(api.finance.createCompany, {
      orgId: s.orgId,
      name: "Bare Finance",
      defaultLtvPercent: 80,
      ...COMPANY_FIELDS,
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
      totalFinancedAmount: 20_000,
    });
    const applicationId = await s.asOwner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    expect((await costsOf(s, applicationId)).expected.adoption.state).toBe("COMPANY_HAS_NO_TEMPLATES");
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow(/no fees configured/);
  });

  test("a deactivated company is refused explicitly, whatever it has configured", async () => {
    const s = await seedDealer("10");
    const { companyId, applicationId } = await dealFrozenBeforeFees(s);
    await s.asOwner.mutation(api.finance.updateCompany, {
      id: companyId,
      orgId: s.orgId,
      name: "Late Fees Finance",
      ...COMPANY_FIELDS,
      isActive: false,
      feeTemplates: TEMPLATES,
    });
    expect((await costsOf(s, applicationId)).expected.adoption.state).toBe("COMPANY_INACTIVE");
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow(/deactivated/);
  });

  test("only the owner may adopt; a disbursement confirmer is refused", async () => {
    const s = await seedDealer("8");
    const { applicationId } = await dealFrozenBeforeFees(s);
    const userId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "adopt_acct", email: "adopt.acct@x.com", name: "Accountant" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "ACCOUNTANT",
        permissions: [PERMISSIONS.VIEW_FINANCE_APPLICATIONS, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT, PERMISSIONS.VIEW_FINANCE],
      })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    const accountant = s.t.withIdentity({ subject: "adopt_acct" });
    await expect(
      accountant.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "x" })
    ).rejects.toThrow();
    expect((await costsOf(s, applicationId)).expected.source).toBe("NO_TEMPLATES");
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction of a fils", 250_000.5],
    ["a negative amount", -250_000],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "a live template carrying %s (legacy or raw-edited) is refused before the audit row and the snapshot write",
    async (_label, corrupt) => {
      const s = await seedDealer(`c-${_label}`);
      const { companyId, applicationId } = await dealFrozenBeforeFees(s);
      // Not through `updateCompany`, which asserts the amount — the row is
      // patched raw, exactly as a template written before that guard, or an
      // admin raw edit, would leave it. `v.number()` admits every value here.
      await s.t.run(async (ctx) => {
        const company = await ctx.db.get(companyId);
        const [first, second] = company!.feeTemplates!;
        await ctx.db.patch(companyId, { feeTemplates: [first, { ...second, estimatedAmountMinor: corrupt }] });
      });
      expect((await costsOf(s, applicationId)).expected.adoption.state).toBe("COMPANY_TEMPLATES_UNREADABLE");

      await expect(
        s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "late" })
      ).rejects.toThrow(/cannot be read as money/);

      // Nothing moved: the slot is still empty, no adoption is recorded on the
      // snapshot, and no override row claims one happened.
      const app = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.companyRuleSnapshot?.feeTemplates).toBeUndefined();
      expect(app?.companyRuleSnapshot?.feeTemplatesAdoptedAt).toBeUndefined();
      expect(app?.companyRuleSnapshot?.feeTemplatesAdoptedFromRuleVersion).toBeUndefined();
      const overrides = await s.t.run(async (ctx) =>
        (await ctx.db.query("financeApplicationOverrides").collect()).filter((row) => row.applicationId === applicationId)
      );
      expect(overrides).toEqual([]);
      expect((await costsOf(s, applicationId)).expected.source).toBe("NO_TEMPLATES");
    }
  );

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction of a fils", 250_000.5],
    ["a negative amount", -250_000],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "the READ never advertises AVAILABLE for a company template carrying %s — it reports COMPANY_TEMPLATES_UNREADABLE, and the mutation refuses with the same reason",
    async (_label, corrupt) => {
      const s = await seedDealer(`r-${_label}`);
      const { companyId, applicationId } = await dealFrozenBeforeFees(s);
      await s.t.run(async (ctx) => {
        const company = await ctx.db.get(companyId);
        const [first, second] = company!.feeTemplates!;
        await ctx.db.patch(companyId, { feeTemplates: [first, { ...second, estimatedAmountMinor: corrupt }] });
      });
      const costs = await costsOf(s, applicationId);
      expect(costs.expected.adoption).toEqual({
        state: "COMPANY_TEMPLATES_UNREADABLE",
        liveTemplateCount: 2,
        liveRuleVersion: 2,
        adopted: null,
      });
      await expect(
        s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "late" })
      ).rejects.toThrow(/cannot be read as money/);
      expect((await costsOf(s, applicationId)).expected.source).toBe("NO_TEMPLATES");
    }
  );

  test("TEN-1: another organization's owner cannot adopt fees onto this deal, even naming their own org", async () => {
    const s = await seedDealer("x1");
    const { applicationId } = await dealFrozenBeforeFees(s);
    const other = await seedDealer("x2");
    // A foreign deal id under the caller's OWN orgId — the shape a forged
    // request takes. The ownership proof, not the permission check, refuses it.
    await expect(
      other.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, {
        orgId: other.orgId,
        applicationId,
        reason: "cross-org",
      })
    ).rejects.toThrow();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.companyRuleSnapshot?.feeTemplates).toBeUndefined();
    expect(app?.companyRuleSnapshot?.feeTemplatesAdoptedBy).toBeUndefined();
    expect((await costsOf(s, applicationId)).expected.source).toBe("NO_TEMPLATES");
  });

  test("a reason is required", async () => {
    const s = await seedDealer("9");
    const { applicationId } = await dealFrozenBeforeFees(s);
    await expect(
      s.asOwner.mutation(api.financeDealCosts.adoptCompanyFeeTemplates, { orgId: s.orgId, applicationId, reason: "   " })
    ).rejects.toThrow(/Say why/);
  });
});
