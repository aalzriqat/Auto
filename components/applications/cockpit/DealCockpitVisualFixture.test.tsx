/**
 * Renders the cockpit view to static HTML for the real-engine visual gate.
 *
 * jsdom has no stylesheet and no layout, so `DealCockpitView.test.tsx` can
 * assert content and attributes but never paint: whether the `.dark` tokens
 * apply, whether `ms-`/`rtl:` mirror, whether 390px overflows. Those need a
 * browser, and the full Playwright suite needs a built app, Clerk credentials
 * and a provisioned deal to reach this screen. This bridge is the cheap middle:
 * the SAME server-shaped fixtures the view tests use, rendered through React
 * to markup, with the REAL dictionaries so the Arabic is the Arabic the
 * operator reads. `playwright/visual/deal-cockpit.visual.spec.ts` styles it
 * with the compiled app stylesheet and looks at it.
 *
 * Gated on `DEAL_COCKPIT_VISUAL_FIXTURE=1` so the ordinary suite never writes
 * files, and writes only into the fresh per-run directory the spec names in
 * `DEAL_COCKPIT_VISUAL_FIXTURE_DIR`. The spec sets both and runs this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { DealCockpitData } from "./DealStagePresentation";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[language.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: language.locale === "ar",
    locale: language.locale,
  }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "د.أ",
    displayLabel: language.locale === "ar" ? "دينار اردني" : "JOD",
    format: (n: number) => `${n.toLocaleString()} ${language.locale === "ar" ? "دينار اردني" : "JOD"}`,
    formatCompact: (n: number) => String(n),
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (code === "USD" ? 2 : 3),
}));

import { DealCockpitView } from "./DealCockpit";
import type { FinancedDealOverviewData } from "./DealFinancialOverview";
import type { DealCustodyWiring } from "./DealCustodyPanel";

/**
 * The financed member of the read model — what `financedDealCockpit` returns.
 * Named so the fixture is checked against the one shape it claims to be, not
 * against the union, where an object literal that misses a financed field can
 * be reported against the cash member instead.
 */
type FinancedDealCockpitData = Extract<DealCockpitData, { dealKind: "FINANCED" }>;

const SCALE = 1_000;

/**
 * A financed deal mid-flight: one blocked stage, a management headline, a
 * supplier. Every field the server returns is present and structurally checked
 * (`satisfies`, no cast), so a field the server adds or renames breaks this
 * bridge at compile time rather than painting a screenshot of a stale shape.
 * The ids are the only casts: they are the server's branded ids, and the
 * fixture stands in for the server. Nothing here is derived on the client.
 */
function financedDeal(): FinancedDealCockpitData {
  const profit = {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor: 2_410 * SCALE,
    currency: "JOD",
    classification: "ESTIMATED_AWAITING_SETTLEMENT",
    postable: false,
    lines: [
      { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
      { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500 * SCALE },
      { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
      { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
    ],
  } satisfies NonNullable<FinancedDealCockpitData["money"]>["profit"];

  return {
    dealKind: "FINANCED",
    denomination: { code: "JOD", scale: 3 },
    dealRef: "app_2048",
    applicationId: "app_2048" as Id<"financeApplications">,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28, 9, 30),
    updatedAt: Date.UTC(2026, 7, 9, 14, 5),
    customer: { id: "c1" as Id<"customers">, name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1" as Id<"vehicles">,
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: true,
      supplierName: "شركة عمّان للاستيراد",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    activeAppraisalProvider: "INDEPENDENT",
    stages: [
      { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
      { key: "CREDIT_DECISION", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPRAISAL", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "MIRROR" },
      { key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" },
      { key: "DISBURSEMENT", state: "PENDING", authority: "MIRROR" },
      { key: "HANDOVER", state: "PENDING", authority: "DEALER" },
      { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
    ],
    documents: [
      {
        ruleId: "r1" as Id<"companyDocumentRules">,
        name: "سند نقل الملكية",
        required: true,
        status: "MISSING",
        uploadedAt: undefined,
      },
      {
        ruleId: "r2" as Id<"companyDocumentRules">,
        name: "هوية العميل",
        required: true,
        status: "VERIFIED",
        uploadedAt: Date.UTC(2026, 7, 1, 10, 0),
      },
    ],
    timeline: [
      {
        fromStatus: undefined,
        toStatus: "PENDING_DOCS",
        changedAt: Date.UTC(2026, 6, 28, 9, 30),
        actorName: "ليث العمري",
        note: undefined,
      },
      {
        fromStatus: "PENDING_DOCS",
        toStatus: "APPROVED",
        changedAt: Date.UTC(2026, 7, 9, 14, 5),
        actorName: "رنا حداد",
        note: undefined,
      },
    ],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      profit,
      managementProfit: profit,
      // As the server builds it: the total is summed from live lines only, so
      // a non-zero actual always has a line behind it, and the line still
      // awaiting its actual is one of them.
      expenses: {
        lines: [
          {
            id: "fee_transfer" as Id<"financeDealFees">,
            feeType: "OWNERSHIP_TRANSFER",
            description: "رسوم نقل الملكية",
            estimatedAmountMinor: 90 * SCALE,
            actualAmountMinor: 90 * SCALE,
            currency: "JOD",
            reconciled: false,
          },
          {
            id: "fee_insurance" as Id<"financeDealFees">,
            feeType: "INSURANCE",
            description: "تأمين",
            estimatedAmountMinor: 250 * SCALE,
            actualAmountMinor: undefined,
            currency: "JOD",
            reconciled: false,
          },
        ],
        actualTotalMinor: 90 * SCALE,
        awaitingActuals: 1,
      },
      parties: [
        {
          party: "CUSTOMER",
          name: "سامر الخطيب",
          position: "DEALERSHIP_HOLDS",
          amountMinor: 500 * SCALE,
          currency: "JOD",
          reference: undefined,
        },
        {
          party: "FINANCIER",
          name: "شركة التمويل الوطني",
          position: "OWED_TO_DEALERSHIP",
          amountMinor: 12_000 * SCALE,
          currency: "JOD",
        },
        {
          party: "SUPPLIER",
          name: "شركة عمّان للاستيراد",
          position: "DEALERSHIP_OWES",
          amountMinor: 9_500 * SCALE,
          currency: "JOD",
          reference: undefined,
          receivableId: undefined,
        },
      ],
      // THROUGH_DEALERSHIP: nothing to collect from the supplier on this route.
      supplierReceipt: { actionable: false, reason: "NOT_DIRECT_ROUTE" },
      appraisalGapMinor: 300 * SCALE,
    },
    handoverEvidence: {
      approvedPurchaseAmountMinor: 12_500 * SCALE,
      financeCompanyFundedPortionMinor: 12_000 * SCALE,
      dealerContributionMinor: 500 * SCALE,
      approvedAmountIsFarFromEvidence: false,
      currency: { code: "JOD", scale: 3 },
    },
    settlementAdviceDiscrepancy: null,
    settlementAdviceRequiresReconciliation: false,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    economicsRecorded: true,
    economicsStamp: "fixture-economics-stamp",
    pendingDepositResolution: false,
  } satisfies FinancedDealCockpitData;
}

/**
 * The overview the server composes for the same deal: every figure consistent
 * with the money payload above, the cost basis on a consigned car (the
 * supplier's cost, no landed cost, no capitalized expenses by construction).
 */
function financedOverview(): FinancedDealOverviewData {
  return {
    financialSummary: {
      currency: "JOD",
      customerSalePrice: { amountMinor: 13_200 * SCALE, basis: "TARGET_SELLING_AMOUNT" },
      approvedPurchaseAmountMinor: 12_500 * SCALE,
      customerPaidToDealer: { heldDepositMinor: 500 * SCALE, totalMinor: 500 * SCALE },
      // Agreed under the gap resolution, not received: its own row, never inside "paid".
      customerGapCashPlannedMinor: 200 * SCALE,
      customerFirstPaymentMinor: 1_200 * SCALE,
      financier: {
        fundedPortionMinor: 12_000 * SCALE,
        // Pre-finalization: no receivable yet, so the expected remittance, as an estimate.
        outstanding: { state: "ESTIMATED_PRE_RECEIVABLE", amountMinor: 11_500 * SCALE, basis: "EXPECTED_DEALER_REMITTANCE" },
      },
      dealerOutlay: {
        plannedContributionMinor: 500 * SCALE,
        recordedCostsMinor: 90 * SCALE,
        recordedCostsReason: null,
        awaitingActuals: 1,
        knownCommittedMinor: 590 * SCALE,
        expectedCostsRemainingMinor: 250 * SCALE,
        expectedCostsReason: null,
        totalExpectedMinor: 840 * SCALE,
        aggregateReason: null,
      },
      supplier: { consigned: true, direction: "DEALERSHIP_OWES", amountMinor: 9_500 * SCALE, route: "THROUGH_DEALERSHIP" },
      unreadable: [],
      profit: {
        available: true,
        basis: "MANAGEMENT_ESTIMATE",
        amountMinor: 2_350 * SCALE,
        currency: "JOD",
        classification: "ESTIMATED_AWAITING_SETTLEMENT",
        postable: false,
        lines: [
          { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
          { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500 * SCALE },
          { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
          { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
          { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 60 * SCALE },
        ],
      },
    },
    vehicleCostBasis: {
      available: true,
      currency: "JOD",
      consigned: true,
      baseMinor: 9_500 * SCALE,
      landedCostMinor: null,
      expenses: [],
      eligibleExpensesMinor: 0,
      totalBeforeDealMinor: 9_500 * SCALE,
      excluded: { pendingCount: 0, reversedCount: 0, periodExpenseCount: 1, afterCutoffCount: 0 },
      cutoffCreationTime: Date.UTC(2026, 6, 28, 9, 30),
      lineDetail: "SERVED",
    },
    // The dealership detailed the supplier's car before the deal: shown beside
    // the supplier's cost, subtracted once from the headline above.
    dealerPreparation: {
      available: true,
      currency: "JOD",
      expenses: [
        { id: "exp_1" as Id<"expenses">, title: "تلميع وتنظيف", category: "DETAILING", date: Date.UTC(2026, 6, 20), netMinor: 60 * SCALE },
      ],
      totalMinor: 60 * SCALE,
      excluded: { pendingCount: 0, reversedCount: 0, otherCount: 1, afterCutoffCount: 0 },
      lineDetail: "SERVED",
    },
  };
}

/** One open custody, mid-handover: 700 advanced, 340 spent, 360 still held. */
function custodyWiring(): DealCustodyWiring {
  return {
    records: [
      {
        _id: "cust_1" as Id<"financeDealCustody">,
        userId: "u_rami" as Id<"users">,
        userName: "رامي حسن",
        currency: "JOD",
        status: "OPEN",
        issuedMinor: 700 * SCALE,
        returnedMinor: 0,
        reimbursedMinor: 0,
        summary: {
          actualExpensesMinor: 340 * SCALE,
          employeeOwesDealerMinor: 360 * SCALE,
          reimbursementOutstandingMinor: 0,
          reimbursementOverpaidMinor: 0,
          overReturnedMinor: 0,
          settled: false,
        },
      },
    ],
    loading: false,
    truncated: false,
    currency: "JOD",
    expectedTotalMinor: 340 * SCALE,
    // The log is a live paginated query in the app; the static fixture has none.
    renderMovements: () => null,
    // The disbursement tier's view: the ledger can take a posting, a period
    // covers today, and the policy recommends the employee-paid slice — so
    // every money control paints, enabled, exactly as the operator sees it.
    accounting: { ready: true },
    openPeriodToday: true,
    plannedCustody: null,
    recommended: { recommendedMinor: 90 * SCALE, reason: null, outstandingCount: 1 },
    actions: {
      members: [{ userId: "u_rami" as Id<"users">, name: "رامي حسن" }],
      eligibleFees: [],
      scaleOf: () => 3,
      onPlan: async () => {},
      onClearPlan: async () => {},
      onOpen: async () => {},
      onMove: async () => {},
      onReverse: async () => {},
      onAttach: async () => {},
      onClose: async () => {},
      onReopen: async () => {},
      onAbandonOpen: () => {},
      onAbandonMove: () => {},
      onAbandonClose: () => {},
    },
  };
}

// Mirrors the container's custody formatter: the org currency's short marker —
// the symbol in Arabic, the code in English — never the long Arabic name.
const custodyMoney = (minor: number, currency: string) =>
  `${(minor / SCALE).toLocaleString()} ${currency === "JOD" && language.locale === "ar" ? "د.أ" : currency}`;

/**
 * Whose move each stage of the fixture is, as the SCREEN must say it — the
 * LITERAL visible string per stage, in each language, written by hand from the
 * stage's server authority and the recorded appraisal provenance (`APPRAISAL`
 * is `MIRROR` but was appraised by an INDEPENDENT appraiser, so it must NOT
 * read "Finance company" / "شركة التمويل").
 *
 * Deliberately NOT looked up in `dictionaries`: the render uses the real
 * dictionaries, and an expectation resolved through the same table would agree
 * with any string that table held — a mistranslated or swapped entry would
 * paint and pass. These literals are the independent oracle; if the product
 * copy changes on purpose, this list changes with it, by hand, in review.
 */
const EXPECTED_STAGE_OWNERS: Readonly<Record<"en" | "ar", ReadonlyArray<string>>> = {
  en: [
    "Dealership", // APPLICATION · DEALER
    "Finance company", // CREDIT_DECISION · MIRROR
    "An independent appraiser", // APPRAISAL · MIRROR, provenance INDEPENDENT
    "Finance company", // APPROVED_PURCHASE · MIRROR
    "Dealership", // DELIVERY_ACTIONS · DEALER
    "Finance company", // DISBURSEMENT · MIRROR
    "Dealership", // HANDOVER · DEALER
    "Dealership", // SETTLEMENT · DEALER
  ],
  ar: [
    "المعرض", // APPLICATION · DEALER
    "شركة التمويل", // CREDIT_DECISION · MIRROR
    "مُخمِّن مستقل", // APPRAISAL · MIRROR, provenance INDEPENDENT
    "شركة التمويل", // APPROVED_PURCHASE · MIRROR
    "المعرض", // DELIVERY_ACTIONS · DEALER
    "شركة التمويل", // DISBURSEMENT · MIRROR
    "المعرض", // HANDOVER · DEALER
    "المعرض", // SETTLEMENT · DEALER
  ],
};

/**
 * Generation is opted into with exactly `DEAL_COCKPIT_VISUAL_FIXTURE=1`; any
 * other value, including a stray truthy one, leaves the ordinary suite as the
 * ordinary suite. The output directory is NOT a fixed path: the Playwright
 * gate creates a fresh per-run directory and passes it here, so a file left
 * behind by an earlier run can never stand in for one this run failed to
 * write. Asked to generate without a directory, the bridge FAILS — it does
 * not fall back to a shared location that could carry stale artifacts.
 */
const GENERATE = process.env.DEAL_COCKPIT_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.DEAL_COCKPIT_VISUAL_FIXTURE_DIR;

describe.skipIf(!GENERATE)("deal cockpit visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", (locale) => {
    expect(OUT_DIR, "DEAL_COCKPIT_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    const outDir = resolve(OUT_DIR!);
    language.locale = locale;
    const deal = financedDeal();
    const html = renderToStaticMarkup(
      <DealCockpitView
        deal={deal}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={custodyWiring()}
        custodyMoney={custodyMoney}
        closingChecklist={{
          accountingClassification: "PENDING",
          onRecordLegalInvoice: () => {},
          onClassifyDealAccounting: () => {},
        }}
      />
    );
    // Not an empty render: the headline, the rail, the overview and the
    // custody section are all in the markup.
    expect(html).toContain("data-testid=\"deal-header\"");
    expect(html).toContain("data-testid=\"deal-stage-rail\"");
    expect(html).toContain("data-testid=\"deal-financial-overview\"");
    expect(html).toContain("data-testid=\"deal-cost-basis\"");
    expect(html).toContain("data-testid=\"deal-preparation\"");
    expect(html).toContain("data-testid=\"deal-custody\"");
    // Both header actions, so the phone render shows how they wrap.
    expect(html).toContain("data-testid=\"deal-closing-checklist\"");
    const expectedOwners = EXPECTED_STAGE_OWNERS[locale];
    // Positive control: one literal per stage, none blank, and — in the
    // language that shares no glyphs with the other — the Arabic list is
    // Arabic, so a copy-paste of the English column cannot pass as the oracle.
    expect(expectedOwners).toHaveLength(deal.stages.length);
    expect(expectedOwners).toHaveLength(8);
    for (const owner of expectedOwners) expect(owner.trim()).toBe(owner);
    for (const owner of expectedOwners) expect(owner.length).toBeGreaterThan(0);
    const arabicLetters = /[؀-ۿ]/;
    for (const owner of expectedOwners) expect(arabicLetters.test(owner)).toBe(locale === "ar");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `deal-cockpit-${locale}.html`), html);
    writeFileSync(
      resolve(outDir, `deal-cockpit-${locale}.expected.json`),
      JSON.stringify({ stageOwners: expectedOwners }, null, 2)
    );
  });
});
