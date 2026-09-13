/**
 * SCRUM-117 — the finance-application read boundary, swept per ROLE.
 *
 * The defect this pins closed: `redactSettlementEvidence` was a blocklist over
 * a 111-field row. It named six fields; everything else travelled. So the
 * appraisal gap, its customer/dealer split, all three payment destinations, who
 * settled it, when, the free-text note, the submitted quotation, the LTV, the
 * funded portion and the override history all reached the default SALES and
 * MANAGER templates — neither of which holds `view:finance` — through
 * `applications.get` (view:sales), `applications.list`,
 * `financingEconomics.getEconomics` and the reconciliation queue.
 *
 * The owner-proxy ruling is explicit about how this is tested, because the
 * previous attempt asserted a boundary its own fixture could never establish:
 *
 *   • roles built from `DEFAULT_ROLE_TEMPLATES`, not a hand-written permission
 *     list — a synthetic list is what let a test claim SALES could not read a
 *     figure while omitting the very permission that makes it readable;
 *   • the WHOLE serialized response scanned for UNIQUE SENTINEL values, not a
 *     property-by-property check — a leak rendered in major units, formatted,
 *     stringified into an override row or nested one level deeper walks past
 *     every named-property assertion;
 *   • positive controls, so the sweep cannot pass by returning nothing.
 *
 * Every sentinel below is a value that appears nowhere else in the fixture, so
 * a hit is always this deal's protected figure and never a coincidence.
 */
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import * as applicationsModule from "./applications";
import * as financingEconomicsModule from "./financingEconomics";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS, type Permission } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

/**
 * Values chosen so that a substring scan cannot produce a false positive: none
 * of them is a round number, a scale factor, a timestamp the fixture also uses,
 * or a prefix of another sentinel.
 */
const SENTINEL = {
  quotation: 12_531_007,
  approved: 11_517_003,
  rawGap: 1_014_004,
  customerShare: 606_011,
  dealerShare: 407_993,
  cashToDealer: 306_017,
  installmentsToDealer: 200_019,
  toFinanceCompany: 99_975,
  funded: 9_788_021,
  unfinanced: 1_729_023,
  dealerContribution: 1_226_027,
  remittance: 4_412_029,
  netReceivable: 8_115_031,
  supplierDisbursed: 13_517_033,
  targetSelling: 10_531_037,
  cost: 9_517_039,
  ltvPercent: 83.7,
  notes: "APPROVEDNOTE-SENTINEL-11517003",
  reference: "WIRE-SENTINEL-7714",
  gapNote: "GAPNOTE-SENTINEL-customer-took-606011",
  overrideReason: "OVERRIDEREASON-SENTINEL-was-11517003",
  overrideNew: "OVERRIDENEW-SENTINEL-11517003",
} as const;

/** Every sentinel a caller without `view:finance` must never receive. */
const FINANCE_SENTINELS: string[] = [
  String(SENTINEL.quotation),
  String(SENTINEL.rawGap),
  String(SENTINEL.customerShare),
  String(SENTINEL.dealerShare),
  String(SENTINEL.cashToDealer),
  String(SENTINEL.installmentsToDealer),
  String(SENTINEL.toFinanceCompany),
  String(SENTINEL.remittance),
  String(SENTINEL.supplierDisbursed),
  String(SENTINEL.targetSelling),
  SENTINEL.notes,
  SENTINEL.reference,
  SENTINEL.gapNote,
  SENTINEL.overrideReason,
  SENTINEL.overrideNew,
];

/**
 * The two figures the supplier-disbursement confirmation must prefill. Gated at
 * `view:finance` OR `confirm:finance_disbursement` — the product's existing
 * tier-2 rule, kept deliberately: a role whose whole job is confirming that
 * payment cannot do it against a blank amount. Asserted SEPARATELY so the
 * wider gate is visible in the test rather than hidden inside the finance set.
 */
const DISBURSEMENT_SENTINELS: string[] = [
  String(SENTINEL.approved),
  String(SENTINEL.netReceivable),
  // The approved amount's decomposition: `funded + contribution` IS the
  // approved amount, so the two classes cannot be separated without either
  // disclosing the whole figure with an extra step or blanking a confirmation
  // screen entitled to it. Reconstructs the APPROVAL only — the appraisal gap
  // also needs the submitted quotation, which stays finance-gated.
  String(SENTINEL.funded),
  String(SENTINEL.unfinanced),
  String(SENTINEL.dealerContribution),
];

/**
 * The applied LTV, asserted SEPARATELY and deliberately.
 *
 * It is finance-gated on the ROW — it travels there beside the amounts, and the
 * division `funded ÷ (ltv / 100)` is the documented first recovery route for
 * the approved amount. But `suggestQuotationForApplication` is the pre-approval
 * CALCULATOR: it exists so a SALES caller can work out what to quote, it
 * returns a suggested amount by design, and it echoes the rate it used. Gating
 * the rate there while returning the suggestion would be theatre.
 *
 * The route stays closed regardless, because the operand it needs — the funded
 * portion — is withheld from that same caller. This constant keeps the
 * exception visible in the test rather than hidden by a missing assertion.
 */
const LTV_SENTINEL = String(SENTINEL.ltvPercent);
const LTV_CALCULATOR_DOORS = [
  "financingEconomics.suggestQuotationForApplication",
  "financingEconomics.suggestQuotation",
];
const isCalculator = (door: string) => LTV_CALCULATOR_DOORS.some((name) => door.startsWith(name));

const templateFor = (name: string): Permission[] => {
  const template = DEFAULT_ROLE_TEMPLATES.find((row) => row.name === name);
  if (!template) throw new Error(`no default template named ${name}`);
  return template.permissions;
};

type Seeded = {
  t: ReturnType<typeof convexTestWithComponents>;
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  companyId: Id<"financeCompanies">;
  asRole: (
    permissions: Permission[],
    isSystemOwnerRole?: boolean
  ) => ReturnType<ReturnType<typeof convexTestWithComponents>["withIdentity"]>;
};

/**
 * One deal, every protected figure set to its sentinel, plus an override row —
 * the history is the third documented recovery route and has to be in the
 * fixture or the sweep cannot see it.
 */
async function seedSentinelDeal(suffix: string): Promise<Seeded> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Boundary ${suffix}`, createdAt: Date.now() })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Boundary", lastName: "Customer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `BOUNDARY${suffix}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 9_517,
      sellingPrice: 10_531,
      status: "AVAILABLE",
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Boundary Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      maxFinancingLTV: 85,
      defaultLtvPercent: 85,
    })
  );
  const salespersonId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `boundary_sales_${suffix}`,
      email: `boundary.sales.${suffix}@example.com`,
      name: "Boundary Sales",
    })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId,
      customerId,
      vehicleId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId,
      vehiclePrice: 10_531,
      downPayment: 500,
      termMonths: 48,
      totalFinancedAmount: 10_031,
      status: "DRAFT",
      createdBy: salespersonId,
      createdAt: Date.now(),
    })
  );
  const applicationId = await t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId,
      quoteId,
      customerId,
      vehicleId,
      companyId,
      salespersonId,
      status: "APPROVED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      creditDecision: "APPROVED",
      appraisalStatus: "COMPLETED",
      gapResolution: "SPLIT",
      settlementStatus: "NOT_READY",
      handoverStatus: "READY",
      economicsCurrency: "JOD",
      needsFinancingReconciliation: true,
      financingReconciliationReason: "SENTINEL sweep fixture",
      economicsRevision: 4,
      // Every protected figure, at its sentinel.
      vehiclePurchaseCostMinor: SENTINEL.cost,
      targetSellingAmountMinor: SENTINEL.targetSelling,
      submittedQuotationMinor: SENTINEL.quotation,
      submittedQuotationSource: "MANUAL_ENTRY",
      appliedLtvPercent: SENTINEL.ltvPercent,
      approvedDealerPurchaseAmountMinor: SENTINEL.approved,
      approvedPurchaseBasis: "MANUAL",
      approvedPurchaseNotes: SENTINEL.notes,
      financeCompanyFundedPortionMinor: SENTINEL.funded,
      unfinancedPortionMinor: SENTINEL.unfinanced,
      dealerContributionMinor: SENTINEL.dealerContribution,
      expectedDealerRemittanceMinor: SENTINEL.remittance,
      financedSaleNetReceivableMinor: SENTINEL.netReceivable,
      supplierDisbursedAmountMinor: SENTINEL.supplierDisbursed,
      supplierDisbursementReference: SENTINEL.reference,
      supplierDisbursementConfirmedAt: Date.now(),
      rawAppraisalGapMinor: SENTINEL.rawGap,
      customerGapShareMinor: SENTINEL.customerShare,
      dealerGapShareMinor: SENTINEL.dealerShare,
      customerGapCashToDealerMinor: SENTINEL.cashToDealer,
      customerGapInstallmentToDealerMinor: SENTINEL.installmentsToDealer,
      customerGapToFinanceCompanyMinor: SENTINEL.toFinanceCompany,
      gapResolvedAt: Date.now(),
      gapResolutionNotes: SENTINEL.gapNote,
      // No `defaultLtvPercent` and no `appliedLtvPercent` would make the LTV
      // "missing"; this fixture has the rate, so `requiresLtvPercent` is false
      // and the flag's own test below sets up the opposite case explicitly.
      companyRuleSnapshot: {
        ruleVersion: 1,
        companyName: "Boundary Finance",
        defaultLtvPercent: SENTINEL.ltvPercent,
      },
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("financeApplicationOverrides", {
      orgId,
      applicationId,
      field: "approvedDealerPurchaseAmountMinor",
      previousValue: "0",
      newValue: SENTINEL.overrideNew,
      reason: SENTINEL.overrideReason,
      changedBy: salespersonId,
      changedAt: Date.now(),
    })
  );

  let seq = 0;
  const asRole = (permissions: Permission[], isSystemOwnerRole = false) => {
    seq += 1;
    const clerkId = `boundary_${suffix}_${seq}`;
    // Synchronous-looking, but the identity is only usable after these writes;
    // the caller awaits the queries, so the inserts below are already applied.
    const identity = t.withIdentity({ subject: clerkId });
    void t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId,
        email: `${clerkId}@example.com`,
        name: clerkId,
      });
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: `ROLE_${seq}`,
        permissions,
        isSystemOwnerRole,
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    });
    return identity;
  };

  return { t, orgId, applicationId, companyId, asRole };
}

/** Recursive key set, so a nested payload cannot hide a field name. */
const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      keysOf(nested, into);
    }
  }
  return into;
};

/**
 * Every door, called as one caller, serialized whole.
 *
 * The door list is checked against the modules' own REGISTERED public queries,
 * so a query added tomorrow fails here instead of quietly not being covered.
 */
async function allDoors(seeded: Seeded, caller: ReturnType<Seeded["asRole"]>) {
  const paginationOpts = { numItems: 20, cursor: null };
  const { orgId, applicationId, companyId } = seeded;
  /**
   * A REFUSAL is a response too.
   *
   * Some doors are gated beyond the read boundary — `handoverStamp` wants
   * `register:vehicle_handover`, which SALES does not hold — and a refusal that
   * named the figure would be exactly the oracle this boundary exists to close.
   * So a throw is captured and swept like any other payload rather than
   * aborting the sweep.
   */
  const call = async (name: string, run: () => Promise<unknown>): Promise<[string, unknown]> => {
    try {
      return [name, await run()];
    } catch (error) {
      return [
        `${name} (refused)`,
        { refusal: error instanceof Error ? error.message : String(error) },
      ];
    }
  };

  const doors: Array<[string, unknown]> = [
    await call("applications.list", () =>
      caller.query(api.applications.list, { orgId, paginationOpts })
    ),
    await call("applications.get", () =>
      caller.query(api.applications.get, { orgId, applicationId })
    ),
    await call("applications.dealCockpit", () =>
      caller.query(api.applications.dealCockpit, { orgId, applicationId })
    ),
    await call("applications.getLog", () =>
      caller.query(api.applications.getLog, { orgId, applicationId })
    ),
    await call("applications.handoverStamp", () =>
      caller.query(api.applications.handoverStamp, { orgId, applicationId })
    ),
    await call("financingEconomics.getEconomics", () =>
      caller.query(api.financingEconomics.getEconomics, { orgId, applicationId })
    ),
    await call("financingEconomics.listNeedingReconciliation", () =>
      caller.query(api.financingEconomics.listNeedingReconciliation, { orgId, paginationOpts })
    ),
    await call("financingEconomics.suggestQuotationForApplication", () =>
      caller.query(api.financingEconomics.suggestQuotationForApplication, { orgId, applicationId })
    ),
    await call("financingEconomics.suggestQuotation", () =>
      caller.query(api.financingEconomics.suggestQuotation, {
        orgId,
        companyId,
        targetSellingAmountMinor: SENTINEL.targetSelling,
        estimatedDealerBorneExpensesMinor: 0,
        customerFirstPaymentMinor: 0,
      })
    ),
  ];

  const publicQueriesOf = (module: string, mod: Record<string, unknown>) =>
    Object.entries(mod)
      .filter(([, value]) => {
        const fn = value as { isQuery?: boolean; isPublic?: boolean } | null;
        return fn?.isQuery === true && fn?.isPublic === true;
      })
      .map(([name]) => `${module}.${name}`);
  const mustCover = [
    ...publicQueriesOf("applications", applicationsModule),
    ...publicQueriesOf("financingEconomics", financingEconomicsModule),
  ].sort();
  expect(mustCover.length).toBeGreaterThanOrEqual(doors.length);
  // A refused door still counts as covered — the name carries a suffix so a
  // failure says which one refused, and the completeness check strips it.
  expect(doors.map(([name]) => name.replace(" (refused)", "")).sort()).toEqual(mustCover);
  return doors;
}

function scan(doors: Array<[string, unknown]>, sentinels: string[]): string[] {
  const hits: string[] = [];
  for (const [name, response] of doors) {
    const serialized = JSON.stringify(response ?? null);
    for (const sentinel of sentinels) {
      if (serialized.includes(sentinel)) hits.push(`${name} leaks ${sentinel}`);
    }
  }
  return hits;
}

describe("the finance-application read boundary (SCRUM-117)", () => {
  test.each([
    ["default SALES", () => templateFor("SALES"), false],
    ["default MANAGER", () => templateFor("MANAGER"), false],
    [
      "a custom application-view-only role",
      () => [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_FINANCE_APPLICATIONS] as Permission[],
      false,
    ],
  ])("%s receives no finance figure from any door", async (label, permissions) => {
    const seeded = await seedSentinelDeal(`neg${label.replace(/\W/g, "")}`);
    const caller = seeded.asRole(permissions());
    const doors = await allDoors(seeded, caller);

    // ANTI-VACUITY: the deal must actually have come back, or this proves
    // nothing at all.
    const [, listed] = doors[0] as [string, { page: unknown[] }];
    expect(listed.page.length).toBeGreaterThan(0);
    const [, detail] = doors[1];
    expect(detail).toBeTruthy();

    expect(scan(doors, FINANCE_SENTINELS)).toEqual([]);
    // The rate: absent everywhere except the calculator that is entitled to it.
    expect(scan(doors, [LTV_SENTINEL]).filter((hit) => !isCalculator(hit))).toEqual([]);
  });

  test("default SALES receives neither the approved amount, its decomposition, nor the frozen net receivable", async () => {
    const seeded = await seedSentinelDeal("negSalesTier2");
    const doors = await allDoors(seeded, seeded.asRole(templateFor("SALES")));
    expect(scan(doors, DISBURSEMENT_SENTINELS)).toEqual([]);
  });

  /**
   * The one deliberate widening, pinned so it is a decision rather than a leak.
   *
   * The default MANAGER holds `confirm:finance_disbursement`, and the
   * supplier-disbursement confirmation prefills from these two figures. That is
   * the product's existing tier-2 rule, unchanged by this work; everything else
   * on the row is still withheld from them, which the negative sweep above
   * asserts for the same role.
   */
  test("default MANAGER still gets the two disbursement prefills, and nothing else", async () => {
    const seeded = await seedSentinelDeal("mgrTier2");
    const doors = await allDoors(seeded, seeded.asRole(templateFor("MANAGER")));
    const serialized = JSON.stringify(doors);
    expect(serialized).toContain(String(SENTINEL.approved));
    expect(serialized).toContain(String(SENTINEL.funded));
    // …and still nothing from the finance class: no quotation, no gap, no
    // allocation, no override contents.
    expect(scan(doors, FINANCE_SENTINELS)).toEqual([]);
  });

  test.each([
    ["default ACCOUNTANT", () => templateFor("ACCOUNTANT"), false],
    ["the system OWNER", () => templateFor("OWNER") ?? [], true],
  ])("%s still sees the figures — the sweep is not passing on emptiness", async (
    _label,
    permissions,
    isOwner
  ) => {
    const seeded = await seedSentinelDeal(`pos${_label.replace(/\W/g, "")}`);
    const caller = seeded.asRole(permissions(), isOwner as boolean);
    const doors = await allDoors(seeded, caller);
    const serialized = JSON.stringify(doors);
    // The positive control is the whole reason the negative sweeps mean
    // something: these exact strings ARE reachable, for a role entitled to them.
    for (const sentinel of [
      String(SENTINEL.funded),
      String(SENTINEL.rawGap),
      String(SENTINEL.customerShare),
      String(SENTINEL.quotation),
      SENTINEL.gapNote,
      SENTINEL.overrideReason,
    ]) {
      expect(`${_label} sees ${sentinel}: ${serialized.includes(sentinel)}`).toBe(
        `${_label} sees ${sentinel}: true`
      );
    }
  });

  test("the gated field names are gone by KEY, not merely blanked", async () => {
    const seeded = await seedSentinelDeal("keysGone");
    const doors = await allDoors(seeded, seeded.asRole(templateFor("SALES")));
    for (const [name, response] of doors) {
      for (const field of [
        // The calculator echoes the rate it used, by design — see
        // LTV_CALCULATOR_DOOR. Excluded here for that door and only that door,
        // so the exception is visible rather than a missing assertion.
        ...(isCalculator(name) ? [] : ["appliedLtvPercent"]),
        "rawAppraisalGapMinor",
        "customerGapShareMinor",
        "dealerGapShareMinor",
        "customerGapCashToDealerMinor",
        "customerGapInstallmentToDealerMinor",
        "customerGapToFinanceCompanyMinor",
        "gapResolvedAt",
        "gapResolvedBy",
        "gapResolutionNotes",
        "submittedQuotationMinor",
        "approvedPurchaseNotes",
        "companyRuleSnapshot",
        "supplierDisbursedAmountMinor",
        "supplierDisbursementReference",
      ]) {
        expect(`${name} exposes ${field}: ${keysOf(response).has(field)}`).toBe(
          `${name} exposes ${field}: false`
        );
      }
    }
  });

  /**
   * The workflow half. A boundary that dead-ends SALES and MANAGER would be
   * refused by the same ruling that demands it, so the facts the application
   * workflow runs on are asserted PRESENT for the most restricted caller.
   */
  test("the ordinary workflow survives: lifecycle, dimensions and the derived LTV question", async () => {
    const seeded = await seedSentinelDeal("workflow");
    const caller = seeded.asRole(templateFor("SALES"));
    const detail = (await caller.query(api.applications.get, {
      orgId: seeded.orgId,
      applicationId: seeded.applicationId,
    })) as Record<string, unknown> | null;
    expect(detail).toBeTruthy();
    expect(detail!.status).toBe("APPROVED");
    expect(detail!.gapResolution).toBe("SPLIT");
    expect(detail!.economicsCurrency).toBe("JOD");
    expect(detail!.creditDecision).toBe("APPROVED");
    // WHETHER the supplier was paid, without when, by whom or how much.
    expect(detail!.supplierDisbursementStatus).toBe("CONFIRMED");
    expect(detail!.economicsStamp).toBe("v2|4");

    const economics = (await caller.query(api.financingEconomics.getEconomics, {
      orgId: seeded.orgId,
      applicationId: seeded.applicationId,
    })) as { requiresLtvPercent: boolean; overrides: Array<Record<string, unknown>> };
    // The fixture's snapshot carries a default rate, so the answer is "no" —
    // and it is an answer, not three blanks the screen has to compare.
    expect(economics.requiresLtvPercent).toBe(false);
    // The audit trail still EXISTS for them; only its contents are withheld.
    expect(economics.overrides).toHaveLength(1);
    expect(economics.overrides[0].field).toBe("approvedDealerPurchaseAmountMinor");
    expect(economics.overrides[0].newValue).toBeUndefined();
    expect(economics.overrides[0].reason).toBeUndefined();
  });

  test("a deal whose rules carry no rate tells even a SALES caller the rate is missing", async () => {
    const seeded = await seedSentinelDeal("ltvMissing");
    await seeded.t.run(async (ctx) => {
      const app = (await ctx.db.get(seeded.applicationId))!;
      await ctx.db.patch(seeded.applicationId, {
        appliedLtvPercent: undefined,
        companyRuleSnapshot: { ...app.companyRuleSnapshot!, defaultLtvPercent: undefined },
      });
    });
    const economics = (await seeded
      .asRole(templateFor("SALES"))
      .query(api.financingEconomics.getEconomics, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
      })) as { requiresLtvPercent: boolean };
    expect(economics.requiresLtvPercent).toBe(true);
  });
});
