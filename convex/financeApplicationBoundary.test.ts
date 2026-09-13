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
 * ## The tiers (owner-proxy ruling, 2026-09-13)
 *
 * This suite originally asserted ONE wall: nothing reconstructable reaches a
 * caller without `view:finance`. That was ruled TOO BROAD for the product, and
 * the ruling replaced it with five tiers. The sweep now proves the tiering,
 * which means it proves PRESENCE as well as absence - a boundary that blanked
 * the screens SALES types into and MANAGER approves from would be a defect
 * under the same ruling that demands the boundary.
 *
 *   quotation      create: OR approve: a finance application, OR view:finance
 *   approval + raw gap    approve: OR confirm:disbursement OR view:finance
 *   gap allocation        approve: OR view:finance (NOT confirm:disbursement)
 *   frozen net receivable confirm:disbursement OR view:finance
 *   everything else       view:finance
 *
 * A MANAGER holding quotation and approval can compute `gap = quotation -
 * approved`. RULED ACCEPTED as an operational approval fact; this suite asserts
 * both halves are present for that role deliberately, so nobody later "fixes"
 * it as a leak.
 *
 * ## How it is tested
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
 *   • positive controls, so the sweep cannot pass by returning nothing;
 *   • and, added by this successor after the first candidate was blocked, the
 *     QUOTATION CALCULATOR'S LIVE BRANCH. `suggestQuotationForApplication`
 *     falls back from omitted arguments to the stored row, so it echoed
 *     finance-gated figures to anyone holding `view:finance_applications` - and
 *     the first fixture never set `targetNetProceedsMinor`, so the solver
 *     always returned NO_TARGET_RECORDED and the branch that leaks was never
 *     executed by any of the ten cases. A sweep that never runs the leaking
 *     branch is not evidence of a boundary. `assertCalculatorLive` below is the
 *     anti-vacuity guard that stops that recurring.
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
  /**
   * The solver's stored fallback, and the reason this successor exists: with
   * this field unset the calculator answers NO_TARGET_RECORDED and never runs
   * the branch that echoed the deal's economics.
   */
  targetNetProceeds: 10_231_041,
  cost: 9_517_039,
  ltvPercent: 83.7,
  notes: "APPROVEDNOTE-SENTINEL-11517003",
  reference: "WIRE-SENTINEL-7714",
  gapNote: "GAPNOTE-SENTINEL-customer-took-606011",
  overrideReason: "OVERRIDEREASON-SENTINEL-was-11517003",
  overrideNew: "OVERRIDENEW-SENTINEL-11517003",
} as const;

/**
 * Ruling #3: the accounting economics. `view:finance` and nothing weaker - no
 * workflow tier is entitled to any of these.
 */
const FINANCE_ONLY_SENTINELS: string[] = [
  // The rate, and the funding composition it produces.
  String(SENTINEL.ltvPercent),
  String(SENTINEL.funded),
  String(SENTINEL.unfinanced),
  String(SENTINEL.dealerContribution),
  String(SENTINEL.remittance),
  // The solver's INPUTS. Publishing the quotation is ruled safe; publishing
  // what it was computed from is not.
  String(SENTINEL.targetSelling),
  String(SENTINEL.targetNetProceeds),
  // Settlement evidence, tier 1, unchanged by the ruling.
  String(SENTINEL.supplierDisbursed),
  SENTINEL.reference,
  // Free text that records an amount, and the override history that restates
  // one - the third documented recovery route for the approved figure.
  SENTINEL.notes,
  SENTINEL.overrideReason,
  SENTINEL.overrideNew,
];

/**
 * The wizard's own input, chosen to collide with no sentinel: it computes from
 * its arguments alone, so every figure in its payload derives from this and
 * none of it can be mistaken for this deal's stored economics.
 */
const WIZARD_OWN_TARGET = 7_400_000;

/** Ruling #1: a quotation-workflow fact, not an accounting secret. */
const QUOTATION_SENTINELS: string[] = [String(SENTINEL.quotation)];

/** Ruling #2: approval facts for the roles that approve and that disburse. */
const APPROVAL_SENTINELS: string[] = [String(SENTINEL.approved), String(SENTINEL.rawGap)];

/** Ruling #4: needed to RESOLVE the gap, and not ordinary sales visibility. */
const GAP_ALLOCATION_SENTINELS: string[] = [
  String(SENTINEL.customerShare),
  String(SENTINEL.dealerShare),
  String(SENTINEL.cashToDealer),
  String(SENTINEL.installmentsToDealer),
  String(SENTINEL.toFinanceCompany),
  SENTINEL.gapNote,
];

/**
 * Ruling #3's one narrow workflow exception: the frozen net receivable
 * `confirmDisbursement` checks the confirmed amount against. Withheld from the
 * default MANAGER, the cockpit would send the principal on every deal carrying
 * a deposit or a withheld fee and be refused with no field to correct it.
 */
const DISBURSEMENT_SENTINELS: string[] = [String(SENTINEL.netReceivable)];

/**
 * `suggestQuotation` - the WIZARD calculator - stays in the door list and is
 * swept like every other door, but it is not part of this boundary and cannot
 * be: it takes caller-supplied inputs against the LIVE company row and never
 * reads a `financeApplications` row at all, so it has no stored deal figure to
 * disclose. The fixture proves that rather than asserting it - the live company
 * carries a different rate (85) from the deal's snapshot
 * (`SENTINEL.ltvPercent`), so a sentinel hit on that door would mean the wizard
 * had somehow reached this deal.
 *
 * Its sibling `suggestQuotationForApplication` DOES read the row, and the
 * previous candidate's carve-out for it - "the calculator echoes the rate it
 * used, by design" - is DELETED rather than narrowed. That carve-out was the
 * shape of the CRITICAL: an exception written into the test made the leak look
 * like a decision. The rate is now `undefined` there for every caller without
 * `view:finance`, so no door needs an exception and none is granted.
 */
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
      customerFirstPaymentOffsetsUnfinancedShare: true,
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
      /**
       * THE EVIDENCE GAP THIS SUCCESSOR REPAIRS.
       *
       * `recordSubmittedQuotation` writes this on every recorded quotation and
       * `solveQuotationForApplication` falls back to it when the caller omits
       * an argument - which the cockpit always does. Unset, the calculator
       * answers NO_TARGET_RECORDED and the ten cases below swept a door that
       * never ran its leaking branch. `assertCalculatorLive` fails loudly if
       * this ever stops producing a live suggestion.
       */
      targetNetProceedsMinor: SENTINEL.targetNetProceeds,
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
        /**
         * Without this the solver answers OFFSET_RULE_UNKNOWN and refuses to
         * calculate - which is exactly how the first candidate's fixture left
         * the leaking branch unexecuted. `computeSubmittedQuotation` returns
         * unavailable when the rule is UNSET, deliberately, because different
         * companies structure the unfinanced share differently and a guess
         * would move money.
         */
        customerFirstPaymentOffsetsUnfinancedShare: true,
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

/**
 * Every value carried under `field`, at any depth.
 *
 * The key check below asks whether a gated NAME carries a gated VALUE, not
 * whether the name exists at all. Two doors publish a deliberate `number |
 * null` contract - `handoverEvidence` is built for a confirmation screen that
 * branches on `!= null` - so the key survives serialization carrying `null`,
 * while a withheld row field is dropped entirely. `null` discloses nothing, and
 * demanding key-absence there would force the product to change its shape to
 * satisfy a test. A non-null value under a gated name is the actual defect.
 */
const valuesUnder = (value: unknown, field: string, into: unknown[] = []): unknown[] => {
  if (Array.isArray(value)) {
    for (const item of value) valuesUnder(item, field, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === field) into.push(nested);
      valuesUnder(nested, field, into);
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
    /**
     * Deliberately NOT called with this deal's sentinels.
     *
     * The wizard computes entirely from its ARGUMENTS, so handing it
     * `SENTINEL.targetSelling` would make it echo a "protected" figure straight
     * back and the sweep would report the caller's own input as a leak. A
     * distinct value keeps a hit on this door meaning what a hit on every other
     * door means.
     */
    await call("financingEconomics.suggestQuotation", () =>
      caller.query(api.financingEconomics.suggestQuotation, {
        orgId,
        companyId,
        targetSellingAmountMinor: WIZARD_OWN_TARGET,
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

/**
 * The calculator actually RAN. The guard the first candidate did not have.
 *
 * Asserted from a `view:finance` caller, which is entitled to the whole
 * payload: if this door is not answering `available: true` with a real figure,
 * every negative assertion about it below is vacuous and must not be believed.
 */
async function assertCalculatorLive(seeded: Seeded) {
  const suggestion = (await seeded
    .asRole(templateFor("ACCOUNTANT"))
    .query(api.financingEconomics.suggestQuotationForApplication, {
      orgId: seeded.orgId,
      applicationId: seeded.applicationId,
    })) as { available: boolean; reason?: string; submittedQuotationMinor?: number };
  expect(`calculator available: ${suggestion.available} ${suggestion.reason ?? ""}`.trim()).toBe(
    "calculator available: true"
  );
  expect(typeof suggestion.submittedQuotationMinor).toBe("number");
}

describe("the finance-application read boundary (SCRUM-117)", () => {
  test("the calculator's stored-row branch is live in this fixture", async () => {
    await assertCalculatorLive(await seedSentinelDeal("calcLive"));
  });

  /**
   * Ruling #5. A role holding only `view:finance_applications` runs no
   * quotation and no approval, so it reads lifecycle and status and NOTHING
   * priced - not even the quotation the workflow tiers are entitled to.
   */
  test("a custom application-view-only role receives no figure of any tier", async () => {
    const seeded = await seedSentinelDeal("viewOnly");
    await assertCalculatorLive(seeded);
    const caller = seeded.asRole([
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
    ] as Permission[]);
    const doors = await allDoors(seeded, caller);

    // ANTI-VACUITY: the deal came back. An empty page passes every scan below.
    const [, listed] = doors[0] as [string, { page: unknown[] }];
    expect(listed.page.length).toBeGreaterThan(0);
    expect(doors[1][1]).toBeTruthy();

    expect(
      scan(doors, [
        ...FINANCE_ONLY_SENTINELS,
        ...QUOTATION_SENTINELS,
        ...APPROVAL_SENTINELS,
        ...GAP_ALLOCATION_SENTINELS,
        ...DISBURSEMENT_SENTINELS,
      ])
    ).toEqual([]);

    // …and the calculator refuses it outright rather than suggesting a figure.
    const suggestion = (await caller.query(
      api.financingEconomics.suggestQuotationForApplication,
      { orgId: seeded.orgId, applicationId: seeded.applicationId }
    )) as { available: boolean; reason: string; submittedQuotationMinor?: number };
    expect(`${suggestion.available} / ${suggestion.reason}`).toBe("false / NOT_AUTHORIZED");
    expect(suggestion.submittedQuotationMinor).toBeUndefined();
  });

  /**
   * Ruling #1 for the role it exists for: default SALES holds
   * `create:finance_application`, types the submitted quotation, and may read
   * it back. Everything the approval and the accounting own stays shut.
   */
  test("default SALES gets the quotation, and no approval, gap, allocation or economics", async () => {
    const seeded = await seedSentinelDeal("sales");
    await assertCalculatorLive(seeded);
    const doors = await allDoors(seeded, seeded.asRole(templateFor("SALES")));

    const [, listed] = doors[0] as [string, { page: unknown[] }];
    expect(listed.page.length).toBeGreaterThan(0);

    // PRESENT - the ruling forbids blanking the screen this role types into.
    expect(JSON.stringify(doors)).toContain(String(SENTINEL.quotation));
    // ABSENT - every other tier.
    expect(
      scan(doors, [
        ...FINANCE_ONLY_SENTINELS,
        ...APPROVAL_SENTINELS,
        ...GAP_ALLOCATION_SENTINELS,
        ...DISBURSEMENT_SENTINELS,
      ])
    ).toEqual([]);
  });

  /**
   * The calculator, per role, on the branch that leaked.
   *
   * This is the CRITICAL, pinned. A SALES caller still gets a suggestion to
   * type into `عرض السعر المرسل`; what it no longer carries is the rate, the
   * funding composition, the projected proceeds or the LTV cap flag.
   */
  test("the calculator suggests to SALES without disclosing what it computed from", async () => {
    const seeded = await seedSentinelDeal("calcSales");
    await assertCalculatorLive(seeded);
    const suggestion = (await seeded
      .asRole(templateFor("SALES"))
      .query(api.financingEconomics.suggestQuotationForApplication, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
      })) as Record<string, unknown>;

    // The workflow half survives.
    expect(suggestion.available).toBe(true);
    expect(typeof suggestion.submittedQuotationMinor).toBe("number");
    expect(suggestion.currency).toBe("JOD");

    // The economics half does not travel - by VALUE, so a figure rendered
    // differently cannot walk past a key check.
    for (const field of [
      "appliedLtvPercent",
      "ruleVersion",
      "projectedNetProceedsMinor",
      "customerCoversUnfinancedPortion",
      "financeCompanyFundedPortionMinor",
      "unfinancedPortionMinor",
      "dealerContributionMinor",
      "customerFirstPaymentSurplusMinor",
      "ltvBaseCapApplied",
    ]) {
      expect(`${field}: ${suggestion[field]}`).toBe(`${field}: undefined`);
    }
    // And the stored operands it solved against stay behind the wall.
    const serialized = JSON.stringify(suggestion);
    for (const sentinel of FINANCE_ONLY_SENTINELS) {
      expect(`calculator leaks ${sentinel}: ${serialized.includes(sentinel)}`).toBe(
        `calculator leaks ${sentinel}: false`
      );
    }
  });

  test("the same calculator hands a view:finance caller the whole payload", async () => {
    const seeded = await seedSentinelDeal("calcFinance");
    const suggestion = (await seeded
      .asRole(templateFor("ACCOUNTANT"))
      .query(api.financingEconomics.suggestQuotationForApplication, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
      })) as Record<string, unknown>;
    expect(suggestion.available).toBe(true);
    // The positive control for the gate above: these ARE reachable, so the
    // undefined-checks in the previous case mean something.
    expect(suggestion.appliedLtvPercent).toBe(SENTINEL.ltvPercent);
    expect(typeof suggestion.financeCompanyFundedPortionMinor).toBe("number");
    expect(typeof suggestion.projectedNetProceedsMinor).toBe("number");
  });

  /**
   * Rulings #2 and #4, and the reconstruction the ruling ACCEPTS.
   *
   * Default MANAGER approves the purchase and confirms the disbursement, so it
   * reads the quotation, the approved amount, the raw gap, the allocation it
   * must resolve, and the frozen net receivable it confirms against. It can
   * therefore compute `gap = quotation - approved`. Asserted deliberately, in
   * both directions, so that a later reviewer reads a DECISION here and not an
   * oversight - the ruling is explicit that this must not be called a leak.
   */
  test("default MANAGER gets the approval workflow in full, and no accounting economics", async () => {
    const seeded = await seedSentinelDeal("manager");
    await assertCalculatorLive(seeded);
    const doors = await allDoors(seeded, seeded.asRole(templateFor("MANAGER")));
    const serialized = JSON.stringify(doors);

    for (const sentinel of [
      ...QUOTATION_SENTINELS,
      ...APPROVAL_SENTINELS,
      ...GAP_ALLOCATION_SENTINELS,
      ...DISBURSEMENT_SENTINELS,
    ]) {
      expect(`MANAGER sees ${sentinel}: ${serialized.includes(sentinel)}`).toBe(
        `MANAGER sees ${sentinel}: true`
      );
    }
    // RULED ACCEPTED, stated as an assertion rather than left implicit.
    expect(SENTINEL.quotation - SENTINEL.approved).toBe(SENTINEL.rawGap);

    // The accounting economics remain shut for the same caller.
    expect(scan(doors, FINANCE_ONLY_SENTINELS)).toEqual([]);
  });

  /**
   * Ruling #4's exclusion, isolated: the gap ALLOCATION is not disbursement
   * business. A role that only confirms payments resolves no gap.
   */
  test("a confirm-disbursement-only role reads the approval but not the gap allocation", async () => {
    const seeded = await seedSentinelDeal("disburseOnly");
    const doors = await allDoors(
      seeded,
      seeded.asRole([
        PERMISSIONS.VIEW_SALES,
        PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
        PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      ] as Permission[])
    );
    const serialized = JSON.stringify(doors);
    for (const sentinel of [...APPROVAL_SENTINELS, ...DISBURSEMENT_SENTINELS]) {
      expect(`sees ${sentinel}: ${serialized.includes(sentinel)}`).toBe(`sees ${sentinel}: true`);
    }
    expect(scan(doors, [...GAP_ALLOCATION_SENTINELS, ...FINANCE_ONLY_SENTINELS])).toEqual([]);
    // No quotation authority, so no quotation - the gap subtraction is not
    // available to this role in either direction.
    expect(scan(doors, QUOTATION_SENTINELS)).toEqual([]);
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
    // something: every tier IS reachable, for a role entitled to all of them.
    for (const sentinel of [
      ...FINANCE_ONLY_SENTINELS.filter((value) => value !== String(SENTINEL.targetSelling)),
      ...QUOTATION_SENTINELS,
      ...APPROVAL_SENTINELS,
      ...GAP_ALLOCATION_SENTINELS,
      ...DISBURSEMENT_SENTINELS,
    ]) {
      expect(`${_label} sees ${sentinel}: ${serialized.includes(sentinel)}`).toBe(
        `${_label} sees ${sentinel}: true`
      );
    }
  });

  /**
   * Absence by KEY as well as by value, for the most restricted caller that
   * still runs the workflow.
   *
   * The value sweep above is the stronger assertion - it catches a figure
   * rendered in major units, formatted, or stringified into an override row.
   * This one catches the opposite failure: a key that survives with a
   * plausible-looking substitute value, which a sentinel scan cannot see.
   *
   * `submittedQuotationMinor` is deliberately NOT in this list any more. Ruling
   * #1 makes it a quotation-workflow fact and default SALES is entitled to it;
   * the case above asserts it is PRESENT for exactly this caller.
   */
  test("the gated field names are gone by KEY, not merely blanked", async () => {
    const seeded = await seedSentinelDeal("keysGone");
    const doors = await allDoors(seeded, seeded.asRole(templateFor("SALES")));
    for (const [name, response] of doors) {
      /**
       * ONE door is excluded, and as a DOOR rather than as a field.
       *
       * `suggestQuotation` is the WIZARD: it takes caller-supplied inputs
       * against the LIVE company row and never reads a `financeApplications`
       * row, so its entire payload is derived from what the caller just passed
       * in and it holds no stored deal figure to disclose. Every name below
       * appears in it legitimately, describing the caller's own hypothetical.
       *
       * The case further down PROVES the separation rather than asserting it -
       * the rate it echoes is the company's 85, not this deal's
       * `SENTINEL.ltvPercent` - and the VALUE sweep still covers this door with
       * every sentinel of every tier, so a wizard that ever learned to read
       * this row would be caught there.
       *
       * Its sibling `suggestQuotationForApplication` DOES read the row and is
       * NOT excluded. The previous candidate's carve-out for it - "the
       * calculator echoes the rate it used, by design" - is deleted rather than
       * narrowed: that carve-out was the shape of the CRITICAL, an exception
       * written into a test until a leak read as a decision.
       */
      if (name.replace(" (refused)", "") === "financingEconomics.suggestQuotation") continue;
      for (const field of [
        /**
         * Accounting economics (ruling #3).
         *
         * `appliedLtvPercent` carries ONE exclusion, and it is a DOOR
         * exclusion rather than a field exclusion: `suggestQuotation` is the
         * WIZARD, which takes caller-supplied inputs against the LIVE company
         * row and never reads a `financeApplications` row, so it holds no
         * stored deal figure to disclose. The case below PROVES that rather
         * than asserting it - the rate it echoes is the company's 85, not this
         * deal's `SENTINEL.ltvPercent`.
         *
         * Its sibling `suggestQuotationForApplication` DOES read the row, and
         * the previous candidate's carve-out for it - "the calculator echoes
         * the rate it used, by design" - is DELETED, not narrowed. That
         * carve-out was the shape of the CRITICAL: an exception written into a
         * test made a leak look like a decision.
         */
        "appliedLtvPercent",
        "financeCompanyFundedPortionMinor",
        "unfinancedPortionMinor",
        "dealerContributionMinor",
        "expectedDealerRemittanceMinor",
        "targetSellingAmountMinor",
        "targetNetProceedsMinor",
        "companyRuleSnapshot",
        "quotationCalculationSnapshot",
        "approvedPurchaseNotes",
        "supplierDisbursedAmountMinor",
        "supplierDisbursementReference",
        // Approval workflow (ruling #2) - SALES neither approves nor disburses.
        "rawAppraisalGapMinor",
        // Gap allocation (ruling #4).
        "customerGapShareMinor",
        "dealerGapShareMinor",
        "customerGapCashToDealerMinor",
        "customerGapInstallmentToDealerMinor",
        "customerGapToFinanceCompanyMinor",
        "gapResolvedAt",
        "gapResolvedBy",
        "gapResolutionNotes",
      ]) {
        const disclosed = valuesUnder(response, field).filter((value) => value != null);
        expect(`${name} exposes ${field}: ${JSON.stringify(disclosed)}`).toBe(
          `${name} exposes ${field}: []`
        );
      }
    }
  });

  /**
   * The one exclusion above, proven rather than asserted.
   *
   * If the wizard ever started resolving its rules from an application row, the
   * rate it echoes would become this deal's - and this test is the only thing
   * that would notice the exclusion silently widening into a leak.
   */
  test("the wizard calculator echoes the LIVE company rate, never this deal's", async () => {
    const seeded = await seedSentinelDeal("wizardRate");
    const suggestion = (await seeded
      .asRole(templateFor("SALES"))
      .query(api.financingEconomics.suggestQuotation, {
        orgId: seeded.orgId,
        companyId: seeded.companyId,
        targetSellingAmountMinor: SENTINEL.targetSelling,
        estimatedDealerBorneExpensesMinor: 0,
        customerFirstPaymentMinor: 0,
      })) as { appliedLtvPercent?: number };
    expect(suggestion.appliedLtvPercent).toBe(85);
    expect(suggestion.appliedLtvPercent).not.toBe(SENTINEL.ltvPercent);
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
