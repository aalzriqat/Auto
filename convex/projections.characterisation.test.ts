/**
 * SCRUM-426 step 1 (SCRUM-418), area 3: projections. Characterisation of what each role reads off a
 * finance application and a sale row, before step 4 moves the projection code.
 *
 * Driven through the public doors: `applications.get`, `applications.list`, `applications.dealCockpit`
 * and `sales.list`, with the real role templates (MANAGER, SALES, ACCOUNTANT), a system owner and a
 * custom view-only role. Assertions are key presence and redacted values, never whole objects.
 *
 * Sources of the expected visibility (not copied from the code's output):
 *  - Finance application classes and rulings #1 to #5 (owner-proxy ruling of 2026-09-13): the header of
 *    `convex/utils/financeApplicationProjection.ts`, together with the permissions the default role
 *    templates hold (`convex/utils/permissions.ts` DEFAULT_ROLE_TEMPLATES).
 *  - Sale row tiers: header of `convex/utils/saleRowProjection.ts` (SCRUM-766 PR-C, SCRUM-886, ACC-10).
 *  - Anything else is marked "characterises <file>:<line>; no ruling" and listed in the PR report.
 *
 * Evidence boundary: convex-test only.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { registerRateLimiter } from "../test-utils/convexTest";
import { readyDeal, seedFinancedDealership } from "../test-utils/financedDealFixture";

const MODULES = import.meta.glob("./**/*.ts");
const OWNER_PERMS = ["view:sales", "create:sales", "view:finance_applications", "view:vehicles"];
const templatePerms = (name: string) => DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name)!.permissions as string[];

type RoleName = "owner" | "manager" | "sales" | "accountant" | "viewonly";
const ROLES: readonly RoleName[] = ["owner", "manager", "sales", "accountant", "viewonly"];

type VisibilityClass = "OPEN" | "QUOTATION_WORKFLOW" | "APPROVAL_WORKFLOW" | "FINANCE" | "DISBURSEMENT_WORKFLOW" | "COST";

// Which classes a role reads. Ruling #1: the submitted quotation belongs to the workflow SALES types into and MANAGER approves
// against. Ruling #2: the approved amount and raw gap belong to approvers, disbursement confirmers and finance. Ruling #3: the
// accounting economics are view:finance only. Ruling #5: a role holding only view:finance_applications reads OPEN and nothing else.
// DISBURSEMENT_WORKFLOW: view:finance or confirm:finance_disbursement. COST: view:cost_price (the vehicle readers' rule).
const MAY_READ: Record<RoleName, ReadonlySet<VisibilityClass>> = {
  owner: new Set(["OPEN", "QUOTATION_WORKFLOW", "APPROVAL_WORKFLOW", "FINANCE", "DISBURSEMENT_WORKFLOW", "COST"]),
  accountant: new Set(["OPEN", "QUOTATION_WORKFLOW", "APPROVAL_WORKFLOW", "FINANCE", "DISBURSEMENT_WORKFLOW", "COST"]),
  manager: new Set(["OPEN", "QUOTATION_WORKFLOW", "APPROVAL_WORKFLOW", "DISBURSEMENT_WORKFLOW", "COST"]),
  sales: new Set(["OPEN", "QUOTATION_WORKFLOW"]),
  viewonly: new Set(["OPEN"]),
};

// Representative fields of each class that a ready financed deal carries a value for (a total classification lives in
// financeApplicationProjection.ts; the type system keeps it total, so this test pins the observable edge, not the census).
const PROBE_FIELDS: Record<VisibilityClass, readonly string[]> = {
  OPEN: ["status", "creditDecision", "handoverStatus", "settlementStatus", "dealNumber", "expectedPaymentMethod", "vehicleHandoverAt", "economicsCurrency"],
  QUOTATION_WORKFLOW: ["submittedQuotationMinor"],
  APPROVAL_WORKFLOW: ["approvedDealerPurchaseAmountMinor", "rawAppraisalGapMinor"],
  FINANCE: [
    "appliedLtvPercent", "customerFirstPaymentMinor", "dealerContributionMinor", "financeCompanyFundedPortionMinor",
    "expectedDealerRemittanceMinor", "targetSellingAmountMinor", "quotationCalculationSnapshot", "unfinancedPortionMinor",
  ],
  // Set on the row directly below, because a ready deal does not reach those stages. financedSaleNetReceivableMinor and plannedCustody
  // are ruling #3's narrow already-approved workflow exception (header of financeApplicationProjection.ts).
  DISBURSEMENT_WORKFLOW: ["disbursementVersion", "financedSaleNetReceivableMinor", "plannedCustody"],
  COST: ["vehiclePurchaseCostMinor"],
};
const ALL_CLASSES = Object.keys(PROBE_FIELDS) as VisibilityClass[];

const PRESENT = (value: unknown) => value !== undefined;

async function seed() {
  const s = await seedFinancedDealership("projections", {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S426P", vinPrefix: "VIN426P",
    actors: {
      manager: templatePerms("MANAGER"), sales: templatePerms("SALES"), accountant: templatePerms("ACCOUNTANT"),
      viewonly: ["view:sales", "view:finance_applications"],
    },
  });
  registerRateLimiter(s.t);
  const as: Record<RoleName, typeof s.owner.as> = {
    owner: s.owner.as, manager: s.actors.manager.as, sales: s.actors.sales.as, accountant: s.actors.accountant.as, viewonly: s.actors.viewonly.as,
  };
  const { applicationId } = await readyDeal(s);
  await s.t.run((ctx) =>
    ctx.db.patch(applicationId, {
      disbursementVersion: 3, vehiclePurchaseCostMinor: 9_000_000, financedSaleNetReceivableMinor: 12_000_000,
      plannedCustody: { userId: s.owner.userId, amountMinor: 200_000, plannedBy: s.owner.userId, plannedAt: Date.now() },
    })
  );
  return { ...s, as, applicationId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

describe("finance application projection through get, list and dealCockpit", () => {
  let s: Seeded;
  type Row = Record<string, unknown>;
  const rows: Partial<Record<RoleName, { get: Row; listRow: Row; cockpit: Row }>> = {};

  beforeAll(async () => {
    s = await seed();
    for (const role of ROLES) {
      const get = await s.as[role].query(api.applications.get, { orgId: s.orgId, applicationId: s.applicationId });
      const list = await s.as[role].query(api.applications.list, { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } });
      const cockpit = await s.as[role].query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
      const listRow = list.page.find((row) => row._id === s.applicationId);
      expect(get, `${role} get`).not.toBeNull();
      expect(listRow, `${role} list row`).toBeDefined();
      expect(cockpit, `${role} cockpit`).not.toBeNull();
      rows[role] = { get: get as unknown as Row, listRow: listRow as unknown as Row, cockpit: cockpit as unknown as Row };
    }
  }, 180_000);

  describe.each(["get", "listRow"] as const)("%s", (door) => {
    test.each(ROLES)("%s: each probed field is present exactly when the role may read its class", (role) => {
      const row = rows[role]![door];
      const observed: Record<string, boolean> = {};
      const expected: Record<string, boolean> = {};
      for (const cls of ALL_CLASSES) {
        for (const field of PROBE_FIELDS[cls]) {
          observed[`${cls}.${field}`] = PRESENT(row[field]);
          expected[`${cls}.${field}`] = MAY_READ[role].has(cls);
        }
      }
      expect(observed).toEqual(expected);
    });

    test("the owner's row carries a value for every probed field, so absence below is a redaction and not an empty source", () => {
      const row = rows.owner![door];
      for (const cls of ALL_CLASSES) for (const field of PROBE_FIELDS[cls]) expect(row[field], `${cls}.${field}`).toBeDefined();
    });
  });

  test("redacted values are the real ones for a permitted caller and nothing for the rest (spot values)", () => {
    // characterises financeApplicationProjection.ts visibilityFor; values from the worked example in test-utils/financedDealFixture.ts (G = 12,500 approved).
    expect(rows.manager!.get.approvedDealerPurchaseAmountMinor).toBe(12_500_000);
    expect(rows.accountant!.get.dealerContributionMinor).toBe(1_375_000);
    expect(rows.sales!.get.submittedQuotationMinor).toBe(12_500_000);
    expect(rows.sales!.get.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(rows.manager!.get.dealerContributionMinor).toBeUndefined();
    expect(rows.viewonly!.get.submittedQuotationMinor).toBeUndefined();
  });

  // characterises applications.ts:1544 get and :1439 list: the enrichment each door adds beside the projected row; no ruling.
  const GET_ENRICHMENT = ["company", "customer", "deposits", "economicsStamp", "handoverEvidence", "quote", "salesperson", "vehicle"];
  const LIST_ENRICHMENT = ["companyLabelKey", "companyName", "customerName", "financedAmount", "hasPendingDepositResolution", "monthlyInstallment", "salespersonName", "vehicleDesc"];

  test.each(ROLES)("%s: get serves its enrichment to every role and list serves its own, not get's", (role) => {
    for (const key of GET_ENRICHMENT) expect(PRESENT(rows[role]!.get[key]), `get.${key}`).toBe(true);
    for (const key of LIST_ENRICHMENT) expect(PRESENT(rows[role]!.listRow[key]), `list.${key}`).toBe(true);
    for (const key of ["company", "deposits", "quote", "salesperson", "handoverEvidence"]) expect(PRESENT(rows[role]!.listRow[key]), `list must not carry ${key}`).toBe(false);
  });

  // ---- key sets per door (a field added to a door fails here loudly) ----
  // characterises financeApplicationProjection.ts FIELD_VISIBILITY and applications.ts:1544 get / :1439 list; the class of each key
  // follows the header rulings #1-#5, the base keys are "characterises; no ruling". Written independently of the code's output order.
  const GET_BASE = [
    "_creationTime", "_id", "appraisalStatus", "approvedAt", "approvedBy", "approvedPurchaseApprovedAt", "approvedPurchaseApprovedBy",
    "approvedPurchaseBasis", "canSettleDirectToSupplier", "company", "companyId", "createdAt", "creditDecision", "currentCommitmentClaims",
    "customer", "customerId", "dealNumber", "deposits", "directRouteRefusal", "economicsCurrency", "economicsRevision", "economicsStamp",
    "expectedPaymentDate", "expectedPaymentMethod", "expectedPaymentRegisteredAt", "expectedPaymentRegisteredBy", "gapResolution",
    "handoverEvidence", "handoverStatus", "hasExternalFinancier", "orgId", "quote", "quoteId", "quoteModeAtSubmission", "salesperson",
    "salespersonId", "settlementStatus", "status", "submittedQuotationAt", "submittedQuotationBy", "submittedQuotationSource", "updatedAt",
    "vehicle", "vehicleHandoverAt", "vehicleHandoverBy", "vehicleId",
  ];
  const GET_ONLY = [
    "canSettleDirectToSupplier", "company", "customer", "deposits", "directRouteRefusal", "economicsStamp", "handoverEvidence",
    "hasExternalFinancier", "quote", "salesperson", "vehicle",
  ];
  const KEYS_BY_CLASS: Record<Exclude<VisibilityClass, "OPEN">, readonly string[]> = {
    QUOTATION_WORKFLOW: ["submittedQuotationMinor"],
    APPROVAL_WORKFLOW: ["approvedDealerPurchaseAmountMinor", "rawAppraisalGapMinor"],
    DISBURSEMENT_WORKFLOW: ["disbursementVersion", "financedSaleNetReceivableMinor", "plannedCustody"],
    COST: ["vehiclePurchaseCostMinor"],
    FINANCE: [
      "appliedLtvPercent", "approvedPurchaseNotes", "companyRuleSnapshot", "customerFirstPaymentMinor", "customerGapToFinanceCompanyAppliedMinor",
      "customerGapToFinanceCompanyUnconfirmedMinor", "customerQuotePricingSnapshot", "dealerContributionMinor", "estimatedClosingExpensesMinor",
      "estimatedDealerBorneExpensesMinor", "expectedDealerRemittanceMinor", "financeCompanyFundedPortionMinor", "financingTermsShortfallMinor",
      "netShortfallMethod", "netShortfallMinor", "quotationCalculationSnapshot", "targetNetProceedsMinor", "targetSellingAmountMinor",
      "underwritingSnapshot", "unfinancedPortionMinor", "valuationShortfallMinor",
    ],
  };
  const classKeysFor = (role: RoleName) =>
    (Object.keys(KEYS_BY_CLASS) as Array<keyof typeof KEYS_BY_CLASS>).filter((cls) => MAY_READ[role].has(cls)).flatMap((cls) => KEYS_BY_CLASS[cls]);
  const definedKeys = (row: Row) => Object.keys(row).filter((key) => row[key] !== undefined);

  test.each(ROLES)("get as %s: the served key set equals the base plus the classes the role may read", (role) => {
    expect(new Set(definedKeys(rows[role]!.get))).toEqual(new Set([...GET_BASE, ...classKeysFor(role)]));
  });
  test.each(ROLES)("list row as %s: the served key set equals the list base plus the classes the role may read", (role) => {
    const listBase = [...GET_BASE.filter((key) => !GET_ONLY.includes(key)), ...LIST_ENRICHMENT];
    expect(new Set(definedKeys(rows[role]!.listRow))).toEqual(new Set([...listBase, ...classKeysFor(role)]));
  });
  // characterises applications.ts:1779 dealCockpit: the top-level keys every role receives; no ruling.
  const COCKPIT_KEYS = [
    "applicationId", "canonicalSaleId", "chequeFaceAttested", "chequeFaceUnrecorded", "chequeNeedsAccountingReview", "chequeNeedsCorrection",
    "chequePaymentRegistered", "createdAt", "customer", "customerInvoiceState", "dealKind", "dealNumber", "dealRef", "denomination",
    "disbursementReturn", "documents", "economicsRecorded", "economicsStamp", "expectedPaymentCorrectable", "expectedPaymentReRegistrable",
    "expectedPaymentRegistered", "financeCompanyName", "firstPaymentCorrection", "forward", "handoverEvidence", "money", "saleId",
    "salespersonName", "settlementAdviceDiscrepancy", "settlementAdviceRequiresReconciliation", "stages", "status",
    "supplierSettlementRouteRequired", "timeline", "unattestedChequeId", "updatedAt", "vehicle",
  ];

  test.each(ROLES)("dealCockpit as %s: the same top-level key set; money and handover figures follow the finance tier", (role) => {
    const cockpit = rows[role]!.cockpit as {
      money: unknown;
      handoverEvidence: { approvedPurchaseAmountMinor: number | null; dealerContributionMinor: number | null; financeCompanyFundedPortionMinor: number | null };
    };
    expect(new Set(Object.keys(cockpit))).toEqual(new Set(COCKPIT_KEYS));
    // Ruling #3: the accounting economics (the money block, the funded portion, the contribution) are view:finance only.
    const finance = MAY_READ[role].has("FINANCE");
    expect(cockpit.money === null).toBe(!finance);
    expect(cockpit.handoverEvidence.dealerContributionMinor).toBe(finance ? 1_375_000 : null);
    expect(cockpit.handoverEvidence.financeCompanyFundedPortionMinor).toBe(finance ? 12_500_000 : null);
    // Ruling #2: the approved amount is the approval workflow's.
    expect(cockpit.handoverEvidence.approvedPurchaseAmountMinor).toBe(MAY_READ[role].has("APPROVAL_WORKFLOW") ? 12_500_000 : null);
  });

  test("dealCockpit money block, as the finance tier reads it, restates the deal's own figures", () => {
    // characterises applications.ts:1779 dealCockpit money; the held deposit H = 200 JOD is the owner's worked example (financedDealFixture.ts).
    const money = rows.accountant!.cockpit.money as { currency: string; parties: Array<{ party: string; amountMinor: number; position: string }> };
    expect(money.currency).toBe("JOD");
    expect(money.parties.find((party) => party.party === "CUSTOMER")).toMatchObject({ amountMinor: 200_000, position: "DEALERSHIP_HOLDS" });
  });

  test("the stage rail is the same for every role: it names no amount", () => {
    // financeApplicationProjection.ts header: `deriveDealStages` publishes the rail to every caller because it names no amount.
    const railOf = (role: RoleName) => (rows[role]!.cockpit.stages as Array<{ key: string; state: string; blocker?: string }>).map((stage) => `${stage.key}=${stage.state}`);
    expect(railOf("owner")).not.toEqual([]);
    for (const role of ROLES.filter((name) => name !== "owner")) expect(railOf(role)).toEqual(railOf("owner"));
  });
});

describe("projectSaleRow through sales.list", () => {
  let s: Seeded;
  let saleId: Id<"sales">;
  const saleRows: Partial<Record<RoleName, Record<string, unknown>>> = {};

  // Header of saleRowProjection.ts. FINANCE tier: view:finance or system owner. COST tier: view:cost_price or system owner.
  const FINANCE_FIELDS = ["commissionBase", "consignedSupplierConcessionMinor"];
  const COST_FIELDS = ["consignedMarginMinor", "financedNetRevenue", "consignedSupplierEntitlementMinor"];
  const PUBLIC_FIELDS = ["salePrice", "saleDate", "status", "dealNumber", "financingType", "consignedMarginCurrency", "supplierSettlementRoute"];
  const MAY_READ_SALE: Record<RoleName, { finance: boolean; cost: boolean }> = {
    owner: { finance: true, cost: true },
    accountant: { finance: true, cost: true },
    manager: { finance: false, cost: true },
    sales: { finance: false, cost: false },
    viewonly: { finance: false, cost: false },
  };

  beforeAll(async () => {
    s = await seed();
    const application = (await s.t.run((ctx) => ctx.db.get(s.applicationId)))!;
    saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: application.vehicleId, customerId: s.customerId, salespersonId: s.owner.userId,
        salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED", financingType: "FINANCED", applicationId: s.applicationId,
        dealNumber: application.dealNumber, supplierSettlementRoute: "THROUGH_DEALERSHIP",
        commissionBase: { approvedMinor: 12_500_000, contributionMinor: 1_375_000, currency: "JOD" },
        consignedSupplierConcessionMinor: 250_000,
        consignedMarginMinor: 3_500_000, consignedMarginCurrency: "JOD",
        financedNetRevenue: { minor: 2_000_000, currency: "JOD", considerationMinor: 9_000_000 },
        consignedSupplierEntitlementMinor: 9_000_000,
      })
    );
    for (const role of ROLES) {
      const list = await s.as[role].query(api.sales.list, { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } });
      const row = list.page.find((entry) => entry._id === saleId);
      expect(row, `${role} sale row`).toBeDefined();
      saleRows[role] = row as unknown as Record<string, unknown>;
    }
  }, 180_000);

  test.each(ROLES)("%s: FINANCE-tier and COST-tier sale fields are absent unless the role may read them; public fields always", (role) => {
    const row = saleRows[role]!;
    const may = MAY_READ_SALE[role];
    for (const field of FINANCE_FIELDS) expect(field in row, `${role} ${field}`).toBe(may.finance);
    for (const field of COST_FIELDS) expect(field in row, `${role} ${field}`).toBe(may.cost);
    for (const field of PUBLIC_FIELDS) expect(PRESENT(row[field]), `${role} ${field}`).toBe(true);
  });

  test("a withheld sale field is absent, never zeroed; a served one keeps its stored value", () => {
    // saleRowProjection.ts doc comment above projectSaleRow (~lines 113-118): a withheld key is dropped rather than zeroed, because a zero would read as "no concession", which is a claim.
    expect(saleRows.sales).not.toHaveProperty("consignedSupplierConcessionMinor");
    expect(saleRows.manager).not.toHaveProperty("consignedSupplierConcessionMinor");
    expect(saleRows.accountant!.consignedSupplierConcessionMinor).toBe(250_000);
    expect(saleRows.manager!.consignedMarginMinor).toBe(3_500_000);
    expect(saleRows.owner!.commissionBase).toEqual({ approvedMinor: 12_500_000, contributionMinor: 1_375_000, currency: "JOD" });
  });
});
