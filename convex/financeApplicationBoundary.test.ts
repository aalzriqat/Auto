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
/**
 * JSON with its keys sorted, so a whole-answer comparison asserts the SHAPE and
 * the VALUES rather than the order a serializer happened to emit them in.
 */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested
  );

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

  /**
   * ===================================================================
   * THE INPUT BOUNDARY (owner-proxy ruling 2026-09-13 13:48)
   * ===================================================================
   *
   * The response-shape gate above was not the whole boundary. The caller also
   * controls the ARGUMENTS, and every what-if control falls back to a stored
   * field when omitted — so pinning four and reading the fifth out of the
   * answer recovers a FINANCE-classified operand exactly. Worse, the MUTATION
   * persists those arguments, so the same arithmetic works write-then-read even
   * if the query alone were fixed.
   *
   * These cases are written to KILL four specific wrong fixes:
   *   1. a query-only fix (the mutation still persists chosen inputs);
   *   2. an error-TEXT-only fix (the value still travels in the payload);
   *   3. a fix that sanitizes the solver object while raw args still reach
   *      `fannedOutInputs`, the audit rows and `ctx.db.patch`;
   *   4. a fix that enumerates the four MONETARY controls and forgets
   *      `ltvPercent`, which is the sharpest of the five.
   */
  describe("the input boundary: arguments cannot be used to read a protected operand", () => {
    /** A deal that can still take a quotation: the writer refuses once approved. */
    async function quotableDeal(tag: string) {
      const seeded = await seedSentinelDeal(tag);
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, {
          approvedDealerPurchaseAmountMinor: undefined,
          submittedQuotationMinor: undefined,
          submittedQuotationSource: undefined,
        });
      });
      return seeded;
    }

    const ask = (
      caller: ReturnType<Seeded["asRole"]>,
      seeded: Seeded,
      overrides: Record<string, number> = {}
    ) =>
      caller.query(api.financingEconomics.suggestQuotationForApplication, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        ...overrides,
      }) as Promise<Record<string, unknown>>;

    /**
     * Every what-if control, alone — so forgetting ONE is a failure here — plus
     * the two combinations that were actually reproduced against `10791edb7`.
     */
    const PROBES: Array<[string, Record<string, number>]> = [
      ["targetSellingAmountMinor alone", { targetSellingAmountMinor: 1 }],
      ["estimatedDealerBorneExpensesMinor alone", { estimatedDealerBorneExpensesMinor: 0 }],
      ["quotationBufferMinor alone", { quotationBufferMinor: 0 }],
      ["customerFirstPaymentMinor alone", { customerFirstPaymentMinor: 999_999_999 }],
      ["ltvPercent alone — THE FIFTH CONTROL", { ltvPercent: 100 }],
      [
        "reproduced combination 1: ltv 100 + zeroed expenses/buffer",
        { estimatedDealerBorneExpensesMinor: 0, quotationBufferMinor: 0, ltvPercent: 100 },
      ],
      [
        "reproduced combination 2: huge first payment + zeroed expenses/buffer",
        {
          estimatedDealerBorneExpensesMinor: 0,
          quotationBufferMinor: 0,
          customerFirstPaymentMinor: 999_999_999,
        },
      ],
      /**
       * The two shapes the ruling calls out by name, because both would evade a
       * guard written the obvious way.
       *
       * ZERO: `value !== undefined` is the test, not truthiness. A truthy check
       * would let `0` through - and `0` is half of the reproduced attack, which
       * pinned expenses and buffer to zero to collapse the contribution.
       *
       * EQUAL-TO-STORED: a guard that first compared the supplied value against
       * the stored one would accept these as harmless no-ops, and the
       * accept/refuse outcome would itself be a search oracle over the
       * FINANCE-classified field being compared. Same mistake the LTV write
       * guard made two rounds ago, in the read direction.
       */
      ["a ZERO override - truthiness would let this through", { quotationBufferMinor: 0 }],
      [
        "every override EQUAL to what the deal already stores",
        {
          targetSellingAmountMinor: SENTINEL.targetSelling,
          ltvPercent: SENTINEL.ltvPercent,
        },
      ],
    ];

    /**
     * PREMISE CHANGED by the owner-proxy ruling of 2026-09-14 08:31, which
     * narrowly supersedes the 13:48 instruction this block was written to.
     *
     * These cases used to assert that an override-bearing request from a
     * non-finance caller returned EXACTLY the no-override answer - the
     * arguments silently disregarded. That did not leak: the figure returned
     * was the deal's own canonical quotation. But it made one request mean two
     * different calculations depending on who asked, with nothing in the
     * response to tell them apart, and an ambiguous calculation contract is a
     * defect even when it is not a disclosure.
     *
     * The request is now REFUSED. The security property the old assertion
     * protected is strictly stronger under the new one - a refused request is
     * computed from nothing at all - so the sentinel sweep is kept rather than
     * dropped, now over the refusal payload.
     */
    test.each([
      ["default SALES", () => templateFor("SALES")],
      ["default MANAGER (no view:finance)", () => templateFor("MANAGER")],
    ])(
      "%s: every override-bearing request is REFUSED, and carries no calculation",
      async (label, permissions) => {
        const seeded = await quotableDeal(`probe${label.replace(/\W/g, "")}`);
        const caller = seeded.asRole(permissions());

        /**
         * THE POSITIVE CONTROL, and the anti-vacuity guard: the canonical
         * request still works for this very caller and still answers with a
         * real figure that is NOT the hidden operand. Without it, "every
         * override is refused" would be satisfied by a query that refused
         * everyone - which would be a broken screen, not a boundary.
         */
        const canonical = await ask(caller, seeded);
        expect(canonical.available).toBe(true);
        expect(typeof canonical.submittedQuotationMinor).toBe("number");
        expect(canonical.submittedQuotationMinor).not.toBe(SENTINEL.targetNetProceeds);

        for (const [name, overrides] of PROBES) {
          const probed = await ask(caller, seeded, overrides);
          // The whole answer, compared as one string: availability, reason and
          // the absence of every economic field at once. A per-field assertion
          // would not notice a calculated amount arriving beside the refusal.
          // Key ORDER is a serialization detail, so both sides are normalized;
          // the SET of keys and their values is the contract being asserted.
          expect(`${name}: ${stable(probed)}`).toBe(
            `${name}: ${stable({
              currency: canonical.currency,
              available: false,
              reason: "OVERRIDES_REQUIRE_FINANCE",
            })}`
          );
          // Kept from the old premise: no operand may appear in the payload by
          // any route, refusal included.
          expect(`${name} leaks the operand: ${JSON.stringify(probed).includes(String(SENTINEL.targetNetProceeds))}`)
            .toBe(`${name} leaks the operand: false`);
        }
      }
    );

    /**
     * The refusal is decided from the ROLE and the ARGUMENTS, before the deal
     * is read at all - so it cannot depend on the deal, and a deal that does
     * not belong to this caller answers the same way.
     *
     * This is the read-side twin of the ordering property asserted for the
     * quotation writer, and it exists for the same reason: the property rots
     * the moment someone moves a "cheap" row read above the check.
     */
    test("an override-bearing request is refused identically for a deal in another tenant", async () => {
      const seeded = await quotableDeal("refuseOrdering");
      const caller = seeded.asRole(templateFor("SALES"));

      const own = await ask(caller, seeded, { ltvPercent: 100 });

      const foreignId = await seeded.t.run(async (ctx) => {
        const otherOrgId = await ctx.db.insert("organizations", {
          name: "Another dealership",
          createdAt: Date.now(),
        });
        const app = (await ctx.db.get(seeded.applicationId))!;
        const { _id, _creationTime, ...rest } = app;
        return ctx.db.insert("financeApplications", { ...rest, orgId: otherOrgId });
      });
      const foreign = (await caller.query(
        api.financingEconomics.suggestQuotationForApplication,
        { orgId: seeded.orgId, applicationId: foreignId, ltvPercent: 100 }
      )) as Record<string, unknown>;

      expect(own.reason).toBe("OVERRIDES_REQUIRE_FINANCE");
      // Byte-identical: the answer says nothing about which row was named.
      expect(`foreign: ${JSON.stringify(foreign)}`).toBe(`foreign: ${JSON.stringify(own)}`);
    });

    test("a deal with no stored target stays unavailable even when the caller supplies one", async () => {
      const seeded = await quotableDeal("noTarget");
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, { targetNetProceedsMinor: undefined });
      });
      const caller = seeded.asRole(templateFor("SALES"));
      const supplied = await ask(caller, seeded, { targetSellingAmountMinor: 5_000_000 });
      /**
       * PREMISE CHANGED with the 08:31 ruling, and the outcome is now STRONGER.
       *
       * This used to answer NO_TARGET_RECORDED: the supplied target was
       * disregarded and the deal genuinely had none. The refusal now comes
       * first, before the deal is read at all — so the caller cannot conjure a
       * calculation the deal does not have, AND learns nothing about whether it
       * has one.
       */
      expect(`${supplied.available} / ${supplied.reason}`).toBe(
        "false / OVERRIDES_REQUIRE_FINANCE"
      );

      // The canonical request still reports the real state, which is what the
      // operator needs and is no longer entangled with the override refusal.
      const canonical = await ask(caller, seeded);
      expect(`${canonical.available} / ${canonical.reason}`).toBe(
        "false / NO_TARGET_RECORDED"
      );
    });

    test("a view:finance caller KEEPS the full simulator — the fix gates disclosure, not capability", async () => {
      const seeded = await quotableDeal("financeSim");
      const caller = seeded.asRole(templateFor("ACCOUNTANT"));
      const canonical = await ask(caller, seeded);
      const simulated = await ask(caller, seeded, { targetSellingAmountMinor: 4_000_000 });
      expect(canonical.available).toBe(true);
      expect(simulated.available).toBe(true);
      // The what-if MUST still move for them, or the fix has broken the tool
      // rather than the leak.
      expect(simulated.submittedQuotationMinor).not.toBe(canonical.submittedQuotationMinor);
      expect(typeof simulated.appliedLtvPercent).toBe("number");
    });

    /** The whole row plus its audit trail, for a zero-delta comparison. */
    async function snapshotOf(seeded: Seeded) {
      return seeded.t.run(async (ctx) => {
        const app = await ctx.db.get(seeded.applicationId);
        const overrides = await ctx.db.query("financeApplicationOverrides").collect();
        return JSON.stringify({ app, overrides: overrides.length });
      });
    }

    test.each([
      ["MANUAL_ENTRY", "MANUAL_ENTRY"],
      ["SYSTEM_CALCULATED", "SYSTEM_CALCULATED"],
      ["CALCULATED_WITH_OVERRIDE", "CALCULATED_WITH_OVERRIDE"],
    ])(
      "the write path refuses the calculation operands in %s mode, with ZERO committed delta",
      async (label, source) => {
        const seeded = await quotableDeal(`write${label}`);
        const caller = seeded.asRole(templateFor("SALES"));
        const before = await snapshotOf(seeded);

        for (const [name, field] of [
          ["target", "targetSellingAmountMinor"],
          ["expenses", "estimatedDealerBorneExpensesMinor"],
          ["buffer", "quotationBufferMinor"],
          ["first payment", "customerFirstPaymentMinor"],
        ] as const) {
          let refusal = "";
          try {
            await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
              orgId: seeded.orgId,
              applicationId: seeded.applicationId,
              submittedQuotationMinor: 9_000_000,
              source: source as "MANUAL_ENTRY",
              ...(source === "CALCULATED_WITH_OVERRIDE" ? { overrideReason: "probe" } : {}),
              [field]: 1_234_567,
            } as never);
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
          // A STABLE CODE, naming no protected value.
          expect(`${label}/${name}: ${refusal.includes("CALCULATION_INPUTS_REQUIRE_FINANCE")}`).toBe(
            `${label}/${name}: true`
          );
          expect(`${label}/${name} echoes the operand: ${refusal.includes(String(SENTINEL.targetNetProceeds))}`)
            .toBe(`${label}/${name} echoes the operand: false`);
        }

        // NOTHING was committed — row, calculation inputs, provenance, snapshot
        // and the audit table all byte-identical. This is what kills a fix that
        // sanitizes the solver while raw args still reach the patch.
        expect(await snapshotOf(seeded)).toBe(before);

        // …and therefore no write-then-query route: the canonical answer a
        // non-finance caller can still get is unchanged.
        const after = await ask(caller, seeded);
        expect(JSON.stringify(after).includes(String(SENTINEL.targetNetProceeds))).toBe(false);
      }
    );

    test("the ordinary quotation write still works for SALES, with and without an override reason", async () => {
      const seeded = await quotableDeal("ordinaryWrite");
      const caller = seeded.asRole(templateFor("SALES"));
      await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        submittedQuotationMinor: 9_100_000,
        source: "MANUAL_ENTRY",
      });
      const stored = await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId));
      expect(stored!.submittedQuotationMinor).toBe(9_100_000);
      expect(stored!.submittedQuotationSource).toBe("MANUAL_ENTRY");
      // The operator's own inputs are untouched by this boundary.
      await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        submittedQuotationMinor: 9_200_000,
        source: "CALCULATED_WITH_OVERRIDE",
        overrideReason: "the finance company asked for a round figure",
      });
      const after = await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId));
      expect(after!.submittedQuotationMinor).toBe(9_200_000);
      expect(after!.submittedQuotationOverrideReason).toBe(
        "the finance company asked for a round figure"
      );
    });

    test("SALES cannot probe the stored rate through the no-op LTV allowance", async () => {
      const seeded = await quotableDeal("ltvProbe");
      const caller = seeded.asRole(templateFor("SALES"));
      const refusals: string[] = [];
      // The stored rate is SENTINEL.ltvPercent. Under the old rule, sending the
      // RIGHT one was permitted and a wrong one refused — so accept/refuse was
      // a search oracle over a FINANCE-classified value. Both must now refuse,
      // identically.
      for (const rate of [SENTINEL.ltvPercent, 61.5]) {
        try {
          await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
            orgId: seeded.orgId,
            applicationId: seeded.applicationId,
            submittedQuotationMinor: 9_000_000,
            source: "MANUAL_ENTRY",
            ltvPercent: rate,
          });
          refusals.push(`rate ${rate}: ACCEPTED`);
        } catch (error) {
          refusals.push(`rate ${rate}: ${error instanceof Error ? error.message : "?"}`);
        }
      }
      // IDENTICAL outcomes: the response distinguishes nothing about the rate.
      expect(refusals[0].replace(String(SENTINEL.ltvPercent), "<rate>")).toBe(
        refusals[1].replace("61.5", "<rate>")
      );
      expect(refusals[0]).not.toContain("ACCEPTED");
    });

    /**
     * INVERTED by the owner-proxy ruling of 2026-09-13 15:33 (SCRUM-117).
     *
     * This asserted that a default MANAGER - approval authority, no
     * `view:finance` - could establish a missing rate through the MANUAL_ENTRY
     * recovery. The ruling of 13:48 explicitly preserved that capability, and
     * the owner-proxy has since said plainly that preserving it is what kept
     * the write-then-read oracle alive: it is the exact actor and the exact
     * door of the third reproduction.
     *
     * So the capability MOVES rather than disappearing. The case below now
     * asserts both halves - the default MANAGER is refused, and a
     * finance-authorized approver completes the same recovery - because an
     * assertion that only refused would be satisfied by a workflow dead end.
     */
    test("the missing-rate recovery now requires a FINANCE-AUTHORIZED approver", async () => {
      const seeded = await quotableDeal("approverRecovery");
      await seeded.t.run(async (ctx) => {
        const app = (await ctx.db.get(seeded.applicationId))!;
        await ctx.db.patch(seeded.applicationId, {
          appliedLtvPercent: undefined,
          companyRuleSnapshot: { ...app.companyRuleSnapshot!, defaultLtvPercent: undefined },
        });
      });
      // default MANAGER: approves, but holds no view:finance. The reproduction actor.
      const manager = seeded.asRole(templateFor("MANAGER"));
      await expect(
        manager.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: seeded.orgId,
          applicationId: seeded.applicationId,
          submittedQuotationMinor: 9_300_000,
          source: "MANUAL_ENTRY",
          ltvPercent: 72.5,
        })
      ).rejects.toThrow(/needs both finance visibility and approval authority/i);

      // And the recovery is not destroyed, only re-homed: the same call from an
      // approver who may also READ the economics completes it.
      const authorized = seeded.asRole([...templateFor("MANAGER"), PERMISSIONS.VIEW_FINANCE]);
      await authorized.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        submittedQuotationMinor: 9_300_000,
        source: "MANUAL_ENTRY",
        ltvPercent: 72.5,
      });
      const stored = await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId));
      // The rate, the amount and the provenance all landed together.
      expect(stored!.appliedLtvPercent).toBe(72.5);
      expect(stored!.submittedQuotationMinor).toBe(9_300_000);
      expect(stored!.submittedQuotationSource).toBe("MANUAL_ENTRY");
      // …and the next canonical suggestion is consistent with what was written.
      const next = await ask(manager, seeded);
      expect(next.available).toBe(true);
      expect(JSON.stringify(next)).not.toContain(String(SENTINEL.targetNetProceeds));
    });

    test("a supplied rate with CALCULATED provenance refuses before any speculative solve", async () => {
      const seeded = await quotableDeal("ltvCalculated");
      const approver = seeded.asRole(templateFor("MANAGER"));
      let refusal = "";
      try {
        await approver.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: seeded.orgId,
          applicationId: seeded.applicationId,
          submittedQuotationMinor: 1,
          source: "SYSTEM_CALCULATED",
          ltvPercent: 100,
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      // The CODE changed with the authority model and the PROPERTY did not.
      // `CALCULATION_INPUTS_REQUIRE_FINANCE` was the narrower guard for "a
      // supplied rate plus calculated provenance"; the rate is now refused for
      // this caller in every provenance mode, so that guard is subsumed rather
      // than weakened. What this case is actually for - no speculative solve,
      // no computed figure in the message - is asserted below, unchanged.
      expect(refusal).toMatch(/needs both finance visibility and approval authority/i);
      // No computed-number feedback: the whole point of refusing BEFORE solving.
      expect(refusal).not.toContain(String(SENTINEL.targetNetProceeds));
      expect(/\d{5,}/.test(refusal)).toBe(false);
    });

    test("the mismatch errors name no computed figure, in either direction", async () => {
      const seeded = await quotableDeal("mismatchErrors");
      const caller = seeded.asRole(templateFor("SALES"));
      const messages: string[] = [];
      for (const [source, amount, extra] of [
        ["SYSTEM_CALCULATED", 1, {}],
        ["CALCULATED_WITH_OVERRIDE", 1, { overrideReason: "probe" }],
      ] as const) {
        try {
          await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
            orgId: seeded.orgId,
            applicationId: seeded.applicationId,
            submittedQuotationMinor: amount,
            source: source as "SYSTEM_CALCULATED",
            ...extra,
          });
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        // No long number anywhere: not the operand, not the computed quotation.
        expect(`"${message}" carries a figure: ${/\d{5,}/.test(message)}`).toBe(
          `"${message}" carries a figure: false`
        );
        expect(message).not.toContain(String(SENTINEL.targetNetProceeds));
      }
    });

    test("a snapshot rule failure reports a safe code, not the historical bound", async () => {
      const seeded = await quotableDeal("snapshotBounds");
      // A frozen snapshot that diverges from the live company row: its minimum
      // first payment is a DEAL-SPECIFIC historical fact, and the solver names
      // it in the ConvexError the query used to forward verbatim.
      await seeded.t.run(async (ctx) => {
        const app = (await ctx.db.get(seeded.applicationId))!;
        await ctx.db.patch(seeded.applicationId, {
          companyRuleSnapshot: {
            ...app.companyRuleSnapshot!,
            minimumCustomerFirstPaymentMinor: 4_242_424,
          },
        });
      });
      const sales = await ask(seeded.asRole(templateFor("SALES")), seeded);
      expect(sales.available).toBe(false);
      expect(`${sales.reason}`).toBe("RULES_UNAVAILABLE");
      expect(JSON.stringify(sales)).not.toContain("4242424");
      // The finance caller still gets the actionable message naming the setting.
      const finance = await ask(seeded.asRole(templateFor("ACCOUNTANT")), seeded);
      expect(JSON.stringify(finance)).toContain("4242424");
    });
  });

  /**
   * THE AUTHORITY MODEL that replaced the third round of argument filters
   * (SCRUM-117, owner-proxy ruling 2026-09-13 15:33).
   *
   * Three CRITICALs came through three doors to one figure, and the third
   * survived its own fix: round 3 closed `recordSubmittedQuotation` and left
   * `approveDealerPurchaseAmount` - gated on `approve:finance_application`
   * alone, which the default MANAGER holds WITHOUT `view:finance` - writing the
   * same rate. The repair is not a fourth filter. Nobody barred from READING
   * the economics may WRITE the operand they are barred from reading.
   *
   * These cases are written against the four repairs that would each look like
   * a fix and leave the class reachable:
   *
   *   1. guarding only the reproduced endpoint (W2) and leaving W1;
   *   2. guarding only W1 again and leaving W2 - the actual round-3 outcome;
   *   3. keeping the "an EQUAL rate changes nothing" allowance, which is the
   *      search oracle itself;
   *   4. treating `view:finance` as sufficient, which would hand an ACCOUNTANT
   *      a write authority they have never held.
   */
  describe("the LTV authority model: writing the rate requires reading the economics", () => {
    /**
     * A deal that is genuinely APPROVABLE, so a refusal in these cases can only
     * be the authority guard.
     *
     * The approval clears - otherwise W2 refuses an already-approved deal and
     * W1 refuses a quotation on one - but the recorded QUOTATION stays, because
     * W2 requires one and a fixture that removed it would refuse for a reason
     * that has nothing to do with the boundary. The handover stamp goes for the
     * same reason,. Separation of duties needs no fixture work: `asRole`
     * mints a fresh user per caller, so no caller here is the salesperson.
     */
    async function rateEstablishableDeal(tag: string) {
      const seeded = await seedSentinelDeal(tag);
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, {
          approvedDealerPurchaseAmountMinor: undefined,
          approvedPurchaseBasis: undefined,
          approvedPurchaseApprovedBy: undefined,
          approvedPurchaseApprovedAt: undefined,
          vehicleHandoverAt: undefined,
        });
      });
      return seeded;
    }

    /** A MANUAL approval needs its note; that is a basis rule, not an authority one. */
    const APPROVAL = {
      approvedAmountMinor: SENTINEL.approved,
      basis: "MANUAL" as const,
      notes: "the finance company confirmed this amount by phone",
    };

    /** Row + audit trail, for the zero-delta proof that a refusal wrote nothing. */
    async function rowSnapshot(seeded: Seeded) {
      return seeded.t.run(async (ctx) => {
        const app = await ctx.db.get(seeded.applicationId);
        const overrides = await ctx.db.query("financeApplicationOverrides").collect();
        return JSON.stringify({ app, overrides: overrides.length });
      });
    }

    const REFUSAL = /needs both finance visibility and approval authority/i;

    /**
     * The rate the deal actually stands on, and a different one.
     *
     * Both are probed at BOTH doors: the equal value is the one a fix that
     * keeps the no-op allowance would let through, and it is the one that made
     * the permission check a search oracle over a FINANCE-classified field.
     */
    const RATES: Array<[string, number]> = [
      ["a DIFFERENT rate", 100],
      ["the SAME rate the deal already carries", SENTINEL.ltvPercent],
    ];

    /**
     * Every role that must be refused, and why each one is a distinct case:
     *
     *   - default MANAGER - the reproduction actor: approval authority, no
     *     finance visibility;
     *   - default ACCOUNTANT - finance visibility, NO approval authority. The
     *     ruling is explicit that read permission grants no write authority,
     *     and a fix that tested `view:finance` alone would pass every MANAGER
     *     case above and still be wrong here;
     *   - default SALES - neither.
     */
    const REFUSED_ROLES: Array<[string, () => Permission[]]> = [
      ["default MANAGER (approval, no view:finance)", () => templateFor("MANAGER")],
      ["default ACCOUNTANT (view:finance, no approval)", () => templateFor("ACCOUNTANT")],
      ["default SALES (neither)", () => templateFor("SALES")],
    ];

    /**
     * What THIS role must be refused BY, at THIS door.
     *
     * A role that does not hold the door's own permission never reaches the
     * authority guard: `requireTenantAuth` answers first, and that precedence
     * is correct - an ACCOUNTANT is not an approver and should be told so, not
     * told about finance visibility. Demanding the authority message from every
     * role would assert the wrong thing and would quietly break if the endpoint
     * permission ever changed.
     *
     * So every role must be REFUSED and must write NOTHING; the role that
     * actually reaches the guard must additionally be refused BY the guard.
     * Without that second half a fix could delete the guard entirely and these
     * cases would still pass on the endpoint permission alone.
     */
    const refusedByTheGuard = (permissions: Permission[], doorPermission: Permission) =>
      permissions.includes(doorPermission);

    test.each(REFUSED_ROLES)(
      "W2 approveDealerPurchaseAmount refuses an explicit rate from %s, at every value, with ZERO delta",
      async (label, permissions) => {
        const seeded = await rateEstablishableDeal(`w2${label.replace(/\W/g, "")}`);
        const caller = seeded.asRole(permissions());
        const before = await rowSnapshot(seeded);

        for (const [name, rate] of RATES) {
          let refusal = "";
          try {
            await caller.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
              orgId: seeded.orgId,
              applicationId: seeded.applicationId,
              ...APPROVAL,
              appliedLtvPercent: rate,
            });
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
          const reachesGuard = refusedByTheGuard(
            permissions(),
            PERMISSIONS.APPROVE_FINANCE_APPLICATION
          );
          expect(`${name}: refused=${refusal !== ""}`).toBe(`${name}: refused=true`);
          expect(`${name}: byTheGuard=${reachesGuard && REFUSAL.test(refusal)}`).toBe(
            `${name}: byTheGuard=${reachesGuard}`
          );
          // The refusal names no protected figure - an error is an output.
          expect(
            `${name} echoes the target: ${refusal.includes(String(SENTINEL.targetNetProceeds))}`
          ).toBe(`${name} echoes the target: false`);
        }

        // THE CONTROL that makes the equal-rate case mean something: nothing
        // was read about the deal to decide, and nothing was written. A guard
        // that compared against the stored rate would still refuse - and would
        // still be an oracle.
        expect(await rowSnapshot(seeded)).toBe(before);
      }
    );

    test.each(REFUSED_ROLES)(
      "W1 recordSubmittedQuotation refuses an explicit rate from %s, at every value, with ZERO delta",
      async (label, permissions) => {
        const seeded = await rateEstablishableDeal(`w1${label.replace(/\W/g, "")}`);
        const caller = seeded.asRole(permissions());
        const before = await rowSnapshot(seeded);

        for (const [name, rate] of RATES) {
          let refusal = "";
          try {
            await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
              orgId: seeded.orgId,
              applicationId: seeded.applicationId,
              submittedQuotationMinor: 9_000_000,
              source: "MANUAL_ENTRY",
              ltvPercent: rate,
            });
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
          const reachesGuard = refusedByTheGuard(
            permissions(),
            PERMISSIONS.CREATE_FINANCE_APPLICATION
          );
          expect(`${name}: refused=${refusal !== ""}`).toBe(`${name}: refused=true`);
          expect(`${name}: byTheGuard=${reachesGuard && REFUSAL.test(refusal)}`).toBe(
            `${name}: byTheGuard=${reachesGuard}`
          );
        }

        expect(await rowSnapshot(seeded)).toBe(before);
      }
    );

    /**
     * THE REFUSAL SAYS THE SAME THING WHATEVER THE ROW SAYS.
     *
     * Raised by the cross-family round: the guard used to sit after
     * `requireOwnedRow` and the closed / already-approved branches, so an
     * unauthorized caller got a different error depending on the deal's state.
     *
     * I did not accept the disclosure claim attached to it - the
     * already-approved branch is unconditional and answers the same caller who
     * sends no rate at all, so that fact was never gated behind this argument -
     * but the ordering property is worth holding on its own, and it is the kind
     * of property that silently rots when someone later inserts a "cheap" row
     * read above the guard. So it is asserted rather than commented.
     *
     * Four states that previously produced four different answers: an open
     * deal, an approved one, a closed one, and an id that does not exist. All
     * four must now return the authority refusal, byte-identical, and move
     * nothing.
     */
    test("the explicit-rate refusal is identical across every row state", async () => {
      const seeded = await rateEstablishableDeal("ordering");
      const caller = seeded.asRole(templateFor("SALES"));

      const refusalFor = async (applicationId: typeof seeded.applicationId) => {
        try {
          await caller.mutation(api.financingEconomics.recordSubmittedQuotation, {
            orgId: seeded.orgId,
            applicationId,
            submittedQuotationMinor: 9_000_000,
            source: "MANUAL_ENTRY",
            ltvPercent: 100,
          });
          return "NOT REFUSED";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      const before = await rowSnapshot(seeded);
      // Captured rather than hardcoded: the fixture's own status is the thing
      // being restored, and a literal here would drift the moment it changes.
      const originalStatus = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.applicationId)
      ))!.status;
      const open = await refusalFor(seeded.applicationId);

      // A closed deal, which used to answer "this application is closed" first.
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, { status: "CLOSED" });
      });
      const closed = await refusalFor(seeded.applicationId);

      // An approved deal, which used to answer "already approved" first.
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, {
          status: originalStatus,
          approvedDealerPurchaseAmountMinor: SENTINEL.approved,
        });
      });
      const approved = await refusalFor(seeded.applicationId);

      /**
       * A row in ANOTHER TENANT, which used to answer "not found" first.
       *
       * A real row rather than a made-up id: an invented id is rejected by the
       * argument validator before the handler runs at all, which would make
       * this case prove nothing about ordering. Copied from the fixture's own
       * application so it is well-formed in every respect except ownership.
       */
      const foreignId = await seeded.t.run(async (ctx) => {
        const otherOrgId = await ctx.db.insert("organizations", {
          name: "Another dealership",
          createdAt: Date.now(),
        });
        const app = (await ctx.db.get(seeded.applicationId))!;
        const { _id, _creationTime, ...rest } = app;
        return ctx.db.insert("financeApplications", { ...rest, orgId: otherOrgId });
      });
      const foreign = await refusalFor(foreignId);

      expect(`open: ${open}`).toBe(`open: ${open}`);
      expect(REFUSAL.test(open)).toBe(true);
      // Byte-identical, not merely all-refused: an answer that VARIES with the
      // row is the property being denied, so comparing the strings is the test.
      expect(`closed: ${closed}`).toBe(`closed: ${open}`);
      expect(`approved: ${approved}`).toBe(`approved: ${open}`);
      expect(`foreign: ${foreign}`).toBe(`foreign: ${open}`);

      // Restore the fixture row so the zero-delta comparison is meaningful.
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.applicationId, {
          status: originalStatus,
          approvedDealerPurchaseAmountMinor: undefined,
        });
      });
      expect(await rowSnapshot(seeded)).toBe(before);
    });

    /**
     * THE OTHER HALF OF THE CONJUNCTION, found by the Sonnet MAX closure round
     * and confirmed by an executed mutant.
     *
     * Every refusal case above is a caller who lacks `view:finance`. They all
     * still refuse if the predicate is weakened to `approve:finance_application`
     * alone - so none of them can catch the opposite weakening, to
     * `view:finance` alone. Catching that needs a caller who HOLDS
     * `view:finance`, does NOT hold the approval, and still reaches the guard.
     *
     * At `approveDealerPurchaseAmount` no such caller can exist: the endpoint's
     * own permission IS the approval, so `requireTenantAuth` answers first.
     * `recordSubmittedQuotation` is the only writer where the row is reachable,
     * because its door is `create:finance_application`. A SALES template plus
     * `view:finance` is exactly that shape - and a plausible real custom role,
     * a "finance analyst who may quote but not approve".
     *
     * The predicate's own truth table is covered directly in
     * `convex/utils/financeApplicationProjection.test.ts`, since the row that
     * is unreachable HERE is unreachable by construction rather than by
     * omission, and no integration suite can close it.
     */
    test("W1 refuses an explicit rate from a caller with view:finance but NO approval", async () => {
      const seeded = await rateEstablishableDeal("viewNoApprove");
      const analyst = seeded.asRole([...templateFor("SALES"), PERMISSIONS.VIEW_FINANCE]);
      const before = await rowSnapshot(seeded);

      for (const [name, rate] of RATES) {
        await expect(
          analyst.mutation(api.financingEconomics.recordSubmittedQuotation, {
            orgId: seeded.orgId,
            applicationId: seeded.applicationId,
            submittedQuotationMinor: 9_000_000,
            source: "MANUAL_ENTRY",
            ltvPercent: rate,
          }),
          name
        ).rejects.toThrow(REFUSAL);
      }

      expect(await rowSnapshot(seeded)).toBe(before);
    });

    /**
     * THE REPRODUCTION, end to end, as the owner-proxy froze it (R-3).
     *
     * The control is the pre-write canonical answer: it is a DIFFERENT figure
     * from the protected target, so a post-write answer equal to the target
     * would isolate the manager-controlled rate as the cause. With the guard in
     * place the write never lands and the answer never moves.
     */
    test("R-3: a default MANAGER cannot move the disclosed quotation by writing the rate", async () => {
      const seeded = await rateEstablishableDeal("r3");
      const manager = seeded.asRole(templateFor("MANAGER"));

      const canonicalBefore = (await manager.query(
        api.financingEconomics.suggestQuotationForApplication,
        { orgId: seeded.orgId, applicationId: seeded.applicationId }
      )) as Record<string, unknown>;
      expect(canonicalBefore.available).toBe(true);
      expect(canonicalBefore.submittedQuotationMinor).not.toBe(SENTINEL.targetNetProceeds);

      await expect(
        manager.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
          orgId: seeded.orgId,
          applicationId: seeded.applicationId,
          ...APPROVAL,
          appliedLtvPercent: 100,
        })
      ).rejects.toThrow(REFUSAL);

      const canonicalAfter = (await manager.query(
        api.financingEconomics.suggestQuotationForApplication,
        { orgId: seeded.orgId, applicationId: seeded.applicationId }
      )) as Record<string, unknown>;
      // Whole-answer equality: the operand did not move, the availability did
      // not move, and no rule diagnostic moved either.
      expect(JSON.stringify(canonicalAfter)).toBe(JSON.stringify(canonicalBefore));
      expect(canonicalAfter.submittedQuotationMinor).not.toBe(SENTINEL.targetNetProceeds);
    });

    /**
     * THE PRESERVATION HALF, and the reason the contract says OMISSION is
     * untouched. A boundary that broke this would be a defect under the same
     * ruling that demands the boundary: the default MANAGER operational
     * workflow on an ALREADY-ESTABLISHED rate is explicitly retained.
     */
    test("a default MANAGER still approves a purchase amount when the rate is OMITTED", async () => {
      const seeded = await rateEstablishableDeal("omission");
      const manager = seeded.asRole(templateFor("MANAGER"));

      await manager.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        ...APPROVAL,
      });

      const app = await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId));
      expect(app?.approvedDealerPurchaseAmountMinor).toBe(SENTINEL.approved);
      // The established rate stands, untouched by an approval that did not name it.
      expect(app?.appliedLtvPercent).toBe(SENTINEL.ltvPercent);
    });

    /**
     * And the capability is not destroyed, only moved: a role holding BOTH
     * `view:finance` and `approve:finance_application` establishes the rate.
     * Without this case the suite would pass just as happily against a fix that
     * refused everyone, which would be a workflow dead end rather than a
     * boundary.
     */
    test("a finance-authorized approver CAN establish the rate at both doors", async () => {
      const seeded = await rateEstablishableDeal("authorized");
      const approver = seeded.asRole([...templateFor("MANAGER"), PERMISSIONS.VIEW_FINANCE]);

      await approver.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        submittedQuotationMinor: 9_000_000,
        source: "MANUAL_ENTRY",
        ltvPercent: 90,
      });
      expect(
        (await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId)))?.appliedLtvPercent
      ).toBe(90);

      await approver.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        ...APPROVAL,
        appliedLtvPercent: 95,
      });
      expect(
        (await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId)))?.appliedLtvPercent
      ).toBe(95);
    });

    /**
     * THE RE-ARM DOOR the corrected map names (Codex round 4, validated).
     *
     * `reopenApproval` clears the approval and the whole gap allocation while
     * LEAVING `appliedLtvPercent` standing, so it returns the deal to a state
     * where W2 can be called again. That is correct behaviour - discarding a
     * legitimately agreed rate would destroy real data - and it is only safe
     * BECAUSE the re-approval can no longer set a new rate. This asserts the
     * pairing, which is the part a future change could silently break.
     */
    test("re-arming the approval does not re-open the rate to a non-finance approver", async () => {
      const seeded = await rateEstablishableDeal("rearm");
      const manager = seeded.asRole(templateFor("MANAGER"));

      await manager.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        ...APPROVAL,
      });
      await manager.mutation(api.financingEconomics.reopenApproval, {
        orgId: seeded.orgId,
        applicationId: seeded.applicationId,
        reason: "the company revised its offer",
      });

      const reopened = await seeded.t.run((ctx) => ctx.db.get(seeded.applicationId));
      expect(reopened?.approvedDealerPurchaseAmountMinor).toBeUndefined();
      // The rate survived the reopen - and is now unreachable to this caller.
      expect(reopened?.appliedLtvPercent).toBe(SENTINEL.ltvPercent);

      await expect(
        manager.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
          orgId: seeded.orgId,
          applicationId: seeded.applicationId,
          ...APPROVAL,
          appliedLtvPercent: 100,
        })
      ).rejects.toThrow(REFUSAL);
    });
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
