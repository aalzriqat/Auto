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
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { DealCockpitData, DealStageState } from "./DealStagePresentation";
import {
  CASH_DEAL_STAGE_ORDER,
  DEAL_STAGE_ORDER,
  type CashDealStageKey,
  type FinancedDealStageKey,
} from "@/convex/utils/financingEconomics";

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

import { DealCockpitView, StageFocusRow, type FinanceDecisionWiring, type WorkflowAction } from "./DealCockpit";
import { orderStagesForDisplay } from "./dealStageDisplayOrder";
import { DealDocumentsPanel } from "./DealDocumentsPanel";
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
      profile: {
        make: "Volkswagen",
        model: "e-Golf",
        year: 2020,
        color: "أبيض",
        mileage: 48250,
        photoUrl: null,
      },
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
    pendingDepositRequests: [],
    firstPaymentCorrection: { block: "NOT_ZERO", quoteDownPaymentMinor: null },
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
    "Dealership", // HANDOVER · DEALER
    "Dealership", // SETTLEMENT · DEALER
    "Finance company", // DISBURSEMENT · MIRROR (shown last: the executable order)
  ],
  ar: [
    "المعرض", // APPLICATION · DEALER
    "شركة التمويل", // CREDIT_DECISION · MIRROR
    "مُخمِّن مستقل", // APPRAISAL · MIRROR, provenance INDEPENDENT
    "شركة التمويل", // APPROVED_PURCHASE · MIRROR
    "المعرض", // DELIVERY_ACTIONS · DEALER
    "المعرض", // HANDOVER · DEALER
    "المعرض", // SETTLEMENT · DEALER
    "شركة التمويل", // DISBURSEMENT · MIRROR (shown last: the executable order)
  ],
};

/**
 * What the customer agreed to pay — so the render shows the plan in the working
 * column. The financier is the deal's own (production derives it from the deal).
 */
const FINANCING_PLAN = {
  financierName: "شركة التمويل الوطني",
  currency: "JOD",
  vehiclePrice: 13_200,
  downPayment: 1_200,
  termMonths: 60,
  monthlyInstallment: 238.5,
  totalFinancedAmount: 12_000,
  nationalId: "9876543210",
} as const;

/**
 * The costed handover for the SAME two lines the money payload and the overview
 * carry: ownership transfer (90 expected, 90 recorded) and insurance (250
 * expected, no actual) — so recorded 90, awaiting 1, expected remaining 250
 * agree on every surface. Each row has a figure in both columns, so the desktop
 * render shows each one under its own Expected / Actual heading.
 */
function handoverCostsWiring() {
  return {
    loading: false,
    costs: {
      lines: [
        {
          _id: "fee_transfer",
          feeType: "OWNERSHIP_TRANSFER",
          currency: "JOD",
          description: "رسوم نقل الملكية",
          estimatedAmountMinor: 90 * SCALE,
          actualAmountMinor: 90 * SCALE,
          paidBy: "DEALER",
          paidTo: "GOVERNMENT",
          status: "ACTUAL_RECORDED",
        },
        {
          _id: "fee_insurance",
          feeType: "INSURANCE",
          currency: "JOD",
          description: "تأمين",
          estimatedAmountMinor: 250 * SCALE,
          paidBy: "DEALER",
          paidTo: "INSURER",
          status: "ESTIMATED_ONLY",
        },
      ],
      summary: {
        lineCount: 2,
        estimatedTotalMinor: 340 * SCALE,
        actualTotalMinor: 90 * SCALE,
        linesAwaitingActual: 1,
        linesAwaitingReconciliation: 1,
      },
      summaryUnavailable: null,
      expected: {
        source: "COMPANY_RULE_SNAPSHOT" as const,
        currency: "JOD",
        rows: [
          {
            templateIndex: 0,
            feeType: "OWNERSHIP_TRANSFER" as const,
            description: "رسوم نقل الملكية",
            expectedAmountMinor: 90 * SCALE,
            expectedAmountReason: null,
            duplicateIdentity: false,
            actual: { feeId: "fee_transfer", actualAmountMinor: 90 * SCALE, currency: "JOD", status: "ACTUAL_RECORDED" },
          },
          {
            templateIndex: 1,
            feeType: "INSURANCE" as const,
            description: "تأمين",
            expectedAmountMinor: 250 * SCALE,
            expectedAmountReason: null,
            duplicateIdentity: false,
            actual: { feeId: "fee_insurance", actualAmountMinor: undefined, currency: "JOD", status: "ESTIMATED_ONLY" },
          },
        ],
        expectedTotalMinor: 340 * SCALE,
        expectedTotalReason: null,
        actualTotalMinor: 90 * SCALE,
        differenceMinor: 250 * SCALE,
        unplannedLineIds: [],
      },
    },
    denomination: { code: "JOD" },
    scaleOf: () => 3,
    money: (minor: number, currency: string) => custodyMoney(minor, currency),
    canManage: true,
    dealClosed: false,
    costSource: { kind: "PENDING" as const },
    onAdd: async () => {},
    onAbandonAdd: () => {},
    onRecordActual: async () => {},
    onVoid: async () => {},
  };
}

/**
 * SCRUM-417 — the focus row in each of the states the wizard added, rendered
 * through the REAL `StageFocusRow` with the real dictionaries. Each block is
 * the row exactly as the view would pass it: a translated label, owner and
 * blocker, and an action already resolved (a present `onStart` is a button, a
 * reason key is a refusal). One gallery per locale, so a phone width shows how
 * the note, the button and the secondary link wrap in Arabic and English.
 *
 * Each state names its real stage, so the "Stage n / total" kicker is the one
 * the rail would print — its place in the deal kind's own stage order.
 */
type FocusState = Readonly<
  {
    id: string;
    state: DealStageState;
    labelKey: string;
    ownerKey: string;
    /** Suffix of the `Blocker…` key, as the rail carries it. */
    blocker?: string;
    mirrorNote?: boolean;
    outstandingDocuments?: ReadonlyArray<{ ruleId: string; name: Readonly<Record<"en" | "ar", string>> }>;
    /** Already resolved, as the view passes it: a present `onStart` is a working button. */
    action: Omit<WorkflowAction, "stageKey">;
    /** The container's verdict on documents (S3); false withholds the passive link. Default true. */
    documentsActionable?: boolean;
  } & (
    | { kind: "FINANCED"; stageKey: FinancedDealStageKey }
    | { kind: "CASH"; stageKey: CashDealStageKey }
  )
>;

function stagePosition(focus: FocusState): { position: number; total: number } {
  // The rail (and so its "n / total" kicker) shows the executable order.
  const serverOrder: readonly string[] = focus.kind === "CASH" ? CASH_DEAL_STAGE_ORDER : DEAL_STAGE_ORDER;
  const order = orderStagesForDisplay(serverOrder.map((key) => ({ key }))).map((stage) => stage.key);
  const index = order.indexOf(focus.stageKey);
  expect(index, `${focus.id}: ${focus.stageKey} is not a ${focus.kind} stage`).toBeGreaterThanOrEqual(0);
  return { position: index + 1, total: order.length };
}

const FOCUS_STATES = [
  {
    id: "reconciliation-resolve",
    kind: "FINANCED",
    stageKey: "SETTLEMENT",
    state: "BLOCKED",
    labelKey: "StageSettlement",
    ownerKey: "StageOwnerDealership",
    blocker: "AwaitingSettlement",
    action: { actionKey: "ResolveReconciliationAction", noteKey: "ReconciliationBeforeClose", onStart: () => {} },
  },
  {
    id: "reconciliation-no-permission",
    kind: "FINANCED",
    stageKey: "SETTLEMENT",
    state: "BLOCKED",
    labelKey: "StageSettlement",
    ownerKey: "StageOwnerDealership",
    blocker: "AwaitingSettlement",
    action: { actionKey: "ResolveReconciliationAction", unavailableReasonKey: "ReconciliationNeedsPermission" },
  },
  {
    id: "appraisal-next",
    kind: "FINANCED",
    stageKey: "APPRAISAL",
    state: "BLOCKED",
    labelKey: "StageAppraisal",
    ownerKey: "StageOwnerFinanceCompany",
    blocker: "AwaitingAppraisal",
    mirrorNote: true,
    action: { actionKey: "RecordAppraisalAction", opens: "RECORD_APPRAISAL", onStart: () => {} },
  },
  {
    id: "gap-failed",
    kind: "FINANCED",
    stageKey: "APPROVED_PURCHASE",
    state: "BLOCKED",
    labelKey: "StageApprovedPurchase",
    ownerKey: "StageOwnerDealership",
    blocker: "GapNegotiationFailed",
    action: { actionKey: "ResolveGapAction", onStart: () => {} },
  },
  {
    id: "credit-documents-first",
    kind: "FINANCED",
    stageKey: "CREDIT_DECISION",
    state: "BLOCKED",
    labelKey: "StageCreditDecision",
    ownerKey: "StageOwnerFinanceCompany",
    blocker: "AwaitingCreditDecision",
    mirrorNote: true,
    outstandingDocuments: [
      { ruleId: "r1", name: { en: "National ID copy", ar: "صورة الهوية" } },
      { ruleId: "r2", name: { en: "Salary certificate", ar: "كشف راتب" } },
    ],
    action: {
      actionKey: "CompleteDocumentsFirstAction",
      noteKey: "CreditApprovalNeedsDocuments",
      opens: "DOCUMENTS",
      secondary: { actionKey: "RecordCreditDecisionAction", onStart: () => {} },
    },
  },
  {
    // W1: an approver who cannot touch the documents is told who does, and
    // keeps the rejection one click away under the reason.
    id: "credit-documents-no-authority",
    kind: "FINANCED",
    stageKey: "CREDIT_DECISION",
    state: "BLOCKED",
    labelKey: "StageCreditDecision",
    ownerKey: "StageOwnerFinanceCompany",
    blocker: "AwaitingCreditDecision",
    mirrorNote: true,
    action: {
      actionKey: "CompleteDocumentsFirstAction",
      noteKey: "CreditApprovalNeedsDocuments",
      opens: "DOCUMENTS",
      unavailableReasonKey: "DocumentsNeedUploader",
      secondary: { actionKey: "RecordCreditDecisionAction", onStart: () => {} },
    },
  },
  {
    // W1: everything outstanding is uploaded; an uploader waits on a verifier.
    id: "delivery-documents-await-verifier",
    kind: "FINANCED",
    stageKey: "DELIVERY_ACTIONS",
    state: "BLOCKED",
    labelKey: "StageDeliveryActions",
    ownerKey: "StageOwnerDealership",
    blocker: "DocumentsIncomplete",
    outstandingDocuments: [{ ruleId: "r1", name: { en: "National ID copy", ar: "صورة الهوية" } }],
    documentsActionable: false,
    action: { actionKey: "CompleteDocumentsAction", opens: "DOCUMENTS", unavailableReasonKey: "DocumentsAwaitVerifier" },
  },
  {
    // SCRUM-417 UX1 (S3): a caller who can neither upload nor verify sees the
    // outstanding documents and who acts, but no link into a checklist with
    // nothing they can press.
    id: "delivery-documents-read-only-role",
    kind: "FINANCED",
    stageKey: "DELIVERY_ACTIONS",
    state: "BLOCKED",
    labelKey: "StageDeliveryActions",
    ownerKey: "StageOwnerDealership",
    blocker: "DocumentsIncomplete",
    outstandingDocuments: [
      { ruleId: "r1", name: { en: "National ID copy", ar: "صورة الهوية" } },
      { ruleId: "r2", name: { en: "Salary certificate", ar: "كشف راتب" } },
    ],
    documentsActionable: false,
    action: { actionKey: "CompleteDocumentsAction", opens: "DOCUMENTS", unavailableReasonKey: "DocumentsNeedUploader" },
  },
  {
    // SCRUM-417 UX1 (S2): the server says the vehicle cannot be handed over yet.
    id: "handover-blocked",
    kind: "FINANCED",
    stageKey: "HANDOVER",
    state: "BLOCKED",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    blocker: "HandoverBlocked",
    action: { actionKey: "RegisterHandoverAction", unavailableReasonKey: "HandoverBlockedNeedsApproval" },
  },
  {
    // SCRUM-417 UX1 (S4): a held vehicle deposit, with the way to resolve it.
    id: "held-deposit-link",
    kind: "FINANCED",
    stageKey: "SETTLEMENT",
    state: "BLOCKED",
    labelKey: "StageSettlement",
    ownerKey: "StageOwnerDealership",
    blocker: "AwaitingSettlement",
    action: {
      actionKey: "FinalizeDealAction",
      unavailableReasonKey: "FinalizeNeedsHeldDepositResolved",
      unavailableLink: { href: "/org_1/vehicles", labelKey: "OpenDepositManagerAction" },
    },
  },
  {
    // The same blocker for a caller who cannot act there: told who does.
    id: "held-deposit-no-access",
    kind: "FINANCED",
    stageKey: "SETTLEMENT",
    state: "BLOCKED",
    labelKey: "StageSettlement",
    ownerKey: "StageOwnerDealership",
    blocker: "AwaitingSettlement",
    action: {
      actionKey: "FinalizeDealAction",
      unavailableReasonKey: "FinalizeNeedsHeldDepositResolved",
      unavailableNoteKey: "DepositManagerNeedsApprover",
    },
  },
  {
    // Round 2 (S417-R2-1): may upload/verify, cannot read the rows the panel's
    // controls sit on — the rejection stays one click away under the reason.
    id: "credit-documents-need-read-access",
    kind: "FINANCED",
    stageKey: "CREDIT_DECISION",
    state: "BLOCKED",
    labelKey: "StageCreditDecision",
    ownerKey: "StageOwnerFinanceCompany",
    blocker: "AwaitingCreditDecision",
    mirrorNote: true,
    action: {
      actionKey: "CompleteDocumentsFirstAction",
      noteKey: "CreditApprovalNeedsDocuments",
      opens: "DOCUMENTS",
      unavailableReasonKey: "DocumentsNeedReadAccess",
      secondary: { actionKey: "RecordCreditDecisionAction", onStart: () => {} },
    },
  },
  {
    id: "delivery-documents-need-read-access",
    kind: "FINANCED",
    stageKey: "DELIVERY_ACTIONS",
    state: "BLOCKED",
    labelKey: "StageDeliveryActions",
    ownerKey: "StageOwnerDealership",
    blocker: "DocumentsIncomplete",
    outstandingDocuments: [{ ruleId: "r1", name: { en: "National ID copy", ar: "صورة الهوية" } }],
    documentsActionable: false,
    action: { actionKey: "CompleteDocumentsAction", opens: "DOCUMENTS", unavailableReasonKey: "DocumentsNeedReadAccess" },
  },
  {
    // W3: the draft sale opens its own completion dialog.
    id: "cash-handover",
    kind: "CASH",
    stageKey: "HANDOVER",
    state: "CURRENT",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    action: { actionKey: "CompleteCashSaleAction", onStart: () => {} },
  },
  {
    id: "cash-handover-no-permission",
    kind: "CASH",
    stageKey: "HANDOVER",
    state: "CURRENT",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    action: { actionKey: "CompleteCashSaleAction", unavailableReasonKey: "CashSaleCompletionNeedsPermission" },
  },
  {
    // Round 2 (S417-R2-2): the sale form's own reads are missing.
    id: "cash-handover-needs-read-access",
    kind: "CASH",
    stageKey: "HANDOVER",
    state: "CURRENT",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    action: { actionKey: "CompleteCashSaleAction", unavailableReasonKey: "CashSaleCompletionNeedsReadAccess" },
  },
  {
    // Round 2 (S417-R2-3, contained); round 3 (Sonnet S417-R3-1/R3-2): the
    // reason now says only what is true and points at the Sales page.
    id: "cash-handover-deposit-decision",
    kind: "CASH",
    stageKey: "HANDOVER",
    state: "CURRENT",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    action: {
      actionKey: "CompleteCashSaleAction",
      unavailableReasonKey: "CashSaleCompletionNeedsDepositDecision",
      unavailableLink: { href: "/org_1/sales/sales", labelKey: "OpenSalesPageAction" },
    },
  },
] satisfies readonly FocusState[];

/**
 * Round 2 (S417-R2-5): the documents panel with every control a row can carry
 * at once — a MISSING row reset with its old file still attached shows View,
 * Verify and the replacement upload side by side, the widest row the panel
 * can paint. Rendered through the REAL panel for a verifier who may upload.
 * Round 3 (S417-R3-1): with a "No longer required" history below it — a
 * deleted rule's file and a long-named one, View only.
 */
function documentsPanelMarkup(locale: "en" | "ar"): string {
  const table = dictionaries[locale] as Record<string, string>;
  const t = (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
  for (const key of ["ViewFile", "Verify", "ReplaceFile", "Upload", "DocMissing", "DocRejected", "DocUploaded", "DocVerified", "DocumentsNoLongerRequired", "DocumentsNoLongerRequiredNote", "RemovedRequirement"]) {
    expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
  }
  const name = (en: string, ar: string) => (locale === "ar" ? ar : en);
  return `<section data-testid="documents-panel-controls">${renderToStaticMarkup(
    <DealDocumentsPanel
      documents={[
        { _id: "d1", ruleId: "r1", ruleName: name("National ID copy", "صورة الهوية الشخصية"), status: "MISSING", fileUrl: "https://files.test/old.pdf" },
        { _id: "d2", ruleId: "r2", ruleName: name("Salary certificate", "شهادة الراتب"), status: "REJECTED", fileUrl: "https://files.test/salary.pdf" },
        { _id: null, ruleId: "r3", ruleName: name("Bank statement — last six months", "كشف حساب بنكي — آخر ستة أشهر"), status: "MISSING", fileUrl: null },
      ]}
      history={[
        { _id: "h1", ruleName: null, status: "UPLOADED", fileUrl: "https://files.test/removed.pdf", uploadedLabel: "2 Aug 2026" },
        { _id: "h2", ruleName: name("Employer letter addressed to the finance company", "خطاب جهة العمل موجّه إلى شركة التمويل"), status: "VERIFIED", fileUrl: "https://files.test/letter.pdf", uploadedLabel: null },
      ]}
      checklist={[]}
      canUpload
      canVerify
      uploadingRuleIds={new Set()}
      t={t}
      onUpload={() => {}}
      onVerify={() => {}}
    />
  )}</section>`;
}

function focusStatesMarkup(locale: "en" | "ar"): string {
  language.locale = locale;
  const table = dictionaries[locale] as Record<string, string>;
  const t = (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
  const blocks = FOCUS_STATES.map((focus: FocusState) => {
    // Every key the gallery paints must exist in THIS locale's dictionary: a
    // key falling through to English (or to itself) would paint a picture of
    // a translation that does not exist.
    const { action } = focus;
    const keys = [
      focus.labelKey,
      focus.ownerKey,
      action.actionKey,
      action.noteKey,
      action.unavailableReasonKey,
      action.unavailableNoteKey,
      action.unavailableLink?.labelKey,
      action.secondary?.actionKey,
    ].filter((key): key is string => typeof key === "string");
    for (const key of keys) expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
    const { position, total } = stagePosition(focus);
    return `<section data-testid="focus-state-${focus.id}" class="space-y-2">${renderToStaticMarkup(
      <StageFocusRow
        state={focus.state}
        label={t(focus.labelKey)}
        position={position}
        total={total}
        owner={t(focus.ownerKey)}
        mirrorNote={focus.mirrorNote ?? false}
        blocker={focus.blocker ? t(`Blocker${focus.blocker}`) : undefined}
        action={action}
        outstandingDocuments={(focus.outstandingDocuments ?? []).map((doc) => ({
          ruleId: doc.ruleId,
          name: doc.name[locale],
        }))}
        onGoToDocuments={() => {}}
        documentsActionable={focus.documentsActionable ?? true}
        t={t}
      />
    )}</section>`;
  });
  const html = `<div class="mx-auto max-w-3xl space-y-6" data-testid="deal-focus-states">${blocks.join("")}${documentsPanelMarkup(locale)}</div>`;
  // Not an empty render: one block per state, each with the row in it.
  expect(html.split('data-testid="deal-next-step"').length - 1).toBe(FOCUS_STATES.length);
  return html;
}

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
          // SCRUM-407: the automatic readiness, in every status it can show.
          readiness: {
            state: "BLOCKED",
            open: true,
            unavailableReason: null,
            unavailableReasonCode: null,
            moneyWithheld: false,
            checks: [
              { key: "REMITTANCE_KNOWN", status: "READY", reason: null, reasonCode: null },
              { key: "CONFIGURED_FEES_RECORDED", status: "READY", reason: null, reasonCode: null },
              { key: "CUSTODY_ON_LEDGER", status: "READY", reason: null, reasonCode: null },
              {
                key: "CUSTODY_SETTLED",
                status: "BLOCKED",
                reason: "A custody record on this deal is still open. Settle what that person holds or is owed before finalizing.",
                // SCRUM-414: coded reasons render the localized text (AR/EN), not the English diagnostic.
                reasonCode: "CUSTODY_OPEN",
              },
              {
                key: "COSTS_CLOSABLE",
                status: "BLOCKED",
                reason: "1 cost(s) on this deal have no actual amount recorded. Estimates may be used to run the deal, but not to close it.",
                reasonCode: "COSTS_AWAITING_ACTUAL",
                reasonParams: { count: 1 },
              },
              { key: "FIRST_PAYMENT_RECORDED", status: "READY", reason: null, reasonCode: null },
              { key: "LEGAL_INVOICE_RECORDED", status: "READY", reason: null, reasonCode: null },
            ],
          },
          legalInvoice: {
            amountMinor: 20_000_000,
            number: "INV-2026-0142",
            date: Date.UTC(2026, 8, 20),
            issuedTo: "FINANCE_COMPANY",
            onRecord: () => {},
          },
        }}
        financingPlan={{ facts: FINANCING_PLAN, formatMajor: (major, currency) => `${major.toLocaleString()} ${currency}` }}
        handoverCosts={handoverCostsWiring()}
      />
    );
    // SCRUM-372: the working column carries the plan and the costed handover
    // list, so the render shows expected/actual columns under their headings.
    expect(html).toContain("data-testid=\"deal-handover-expected-0\"");
    expect(html).toContain("data-testid=\"deal-handover-expected-1\"");
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
    // SCRUM-417: the next-step states the wizard added, painted side by side.
    writeFileSync(resolve(outDir, `deal-focus-states-${locale}.html`), focusStatesMarkup(locale));
    writeFileSync(
      resolve(outDir, `deal-cockpit-${locale}.expected.json`),
      JSON.stringify({ stageOwners: expectedOwners }, null, 2)
    );
  });

  // S414-R2-SKEW-1: the SAME deal on its closing step when the readiness read
  // failed (a backend without `getClosingReadiness`). The panel says so and the
  // close is withheld with its own reason — painted so the reason's wrap and
  // tone are judged in both directions, not only asserted in jsdom.
  test.each(["en", "ar"] as const)("writes the %s markup with readiness unreadable", (locale) => {
    expect(OUT_DIR, "DEAL_COCKPIT_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    const outDir = resolve(OUT_DIR!);
    language.locale = locale;
    const base = financedDeal();
    const deal: FinancedDealCockpitData = {
      ...base,
      stages: base.stages.map((stage) =>
        stage.key === "SETTLEMENT"
          ? { ...stage, state: "BLOCKED" as const, blocker: "AwaitingSettlement" }
          : { ...stage, state: "COMPLETE" as const, blocker: undefined }
      ),
    };
    const html = renderToStaticMarkup(
      <DealCockpitView
        deal={deal}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={custodyWiring()}
        custodyMoney={custodyMoney}
        closingChecklist={{ readiness: undefined, serviceUnavailable: true }}
        workflowAction={{
          stageKey: "SETTLEMENT",
          actionKey: "FinalizeDealAction",
          onStart: () => {},
          unavailableReasonKey: "FinalizeWaitsForReadiness",
        }}
        financingPlan={{ facts: FINANCING_PLAN, formatMajor: (major, currency) => `${major.toLocaleString()} ${currency}` }}
        handoverCosts={handoverCostsWiring()}
      />
    );
    expect(html).toContain("data-testid=\"deal-next-step\"");
    expect(html).toContain("data-testid=\"closing-readiness-service-unavailable\"");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `deal-cockpit-${locale}-readiness-unreadable.html`), html);
  });

  // S414-R3-1: the SAME closing step for a custom closer who may close but not
  // read the finance application. No readiness panel (the read is skipped) and
  // the close withheld with the reason naming the missing access.
  test.each(["en", "ar"] as const)("writes the %s markup with no readiness access", (locale) => {
    expect(OUT_DIR, "DEAL_COCKPIT_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    const outDir = resolve(OUT_DIR!);
    language.locale = locale;
    const base = financedDeal();
    const deal: FinancedDealCockpitData = {
      ...base,
      stages: base.stages.map((stage) =>
        stage.key === "SETTLEMENT"
          ? { ...stage, state: "BLOCKED" as const, blocker: "AwaitingSettlement" }
          : { ...stage, state: "COMPLETE" as const, blocker: undefined }
      ),
    };
    const html = renderToStaticMarkup(
      <DealCockpitView
        deal={deal}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={custodyWiring()}
        custodyMoney={custodyMoney}
        workflowAction={{
          stageKey: "SETTLEMENT",
          actionKey: "FinalizeDealAction",
          onStart: () => {},
          unavailableReasonKey: "FinalizeNeedsReadinessAccess",
        }}
        financingPlan={{ facts: FINANCING_PLAN, formatMajor: (major, currency) => `${major.toLocaleString()} ${currency}` }}
        handoverCosts={handoverCostsWiring()}
      />
    );
    expect(html).toContain("data-testid=\"deal-next-step\"");
    expect(html).not.toContain("data-testid=\"closing-readiness-service-unavailable\"");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `deal-cockpit-${locale}-readiness-access.html`), html);
  });

  // SCRUM-417 UX4 (O2/O3): the sub-step checklist on a live Handover, and the
  // read-only past / future step views a rail click (or ?stage=) opens.
  const ux4Markup = (locale: "en" | "ar", variant: "handover-checklist" | "view-past" | "view-future") => {
    language.locale = locale;
    const base = financedDeal();
    const deal: FinancedDealCockpitData =
      variant === "handover-checklist"
        ? {
            ...base,
            stages: base.stages.map((stage) => ({
              ...stage,
              state:
                stage.key === "HANDOVER"
                  ? ("CURRENT" as const)
                  : stage.key === "DISBURSEMENT" || stage.key === "SETTLEMENT"
                    ? ("PENDING" as const)
                    : ("COMPLETE" as const),
              blocker: undefined,
            })),
          }
        : base;
    const viewed = variant === "view-past" ? "APPLICATION" : variant === "view-future" ? "SETTLEMENT" : null;
    return renderToStaticMarkup(
      <DealCockpitView
        deal={deal}
        stageDeepLink={{ value: viewed, onChange: () => {} }}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={custodyWiring()}
        custodyMoney={custodyMoney}
        closingChecklist={
          variant === "handover-checklist"
            ? {
                readiness: {
                  state: "BLOCKED",
                  open: true,
                  unavailableReason: null,
                  unavailableReasonCode: null,
                  moneyWithheld: false,
                  checks: [
                    { key: "CONFIGURED_FEES_RECORDED", status: "READY", reason: null, reasonCode: null },
                    { key: "HANDOVER_COSTS_PAID", status: "BLOCKED", reason: "blocked", reasonCode: null },
                  ],
                } as unknown as NonNullable<React.ComponentProps<typeof DealCockpitView>["closingChecklist"]>["readiness"],
              }
            : undefined
        }
        financingPlan={{ facts: FINANCING_PLAN, formatMajor: (major, currency) => `${major.toLocaleString()} ${currency}` }}
        handoverCosts={handoverCostsWiring()}
      />
    );
  };
  test.each(
    (["en", "ar"] as const).flatMap((locale) =>
      (["handover-checklist", "view-past", "view-future"] as const).map((variant) => [locale, variant] as const)
    )
  )("writes the %s markup for UX4 %s", (locale, variant) => {
    expect(OUT_DIR, "DEAL_COCKPIT_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    const outDir = resolve(OUT_DIR!);
    const html = ux4Markup(locale, variant);
    if (variant === "handover-checklist") {
      expect(html).toContain("data-testid=\"deal-step-checklist\"");
      expect(html).not.toContain("data-testid=\"deal-stage-view\"");
    } else {
      expect(html).toContain("data-testid=\"deal-stage-view\"");
      expect(html).toContain("data-testid=\"deal-stage-view-back\"");
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `deal-cockpit-${locale}-ux4-${variant}.html`), html);
  });
});


/**
 * SCRUM-417 UX1 (S4): a failed readiness check opens its own panel. Not gated:
 * this is behaviour, not paint. The fixtures are the ones the visual gate
 * renders, so the destinations the operator sees are the ones proven here.
 */
describe("closing-readiness rows are destinations", () => {
  // These tests stub the global prototype method; put it back so no other
  // test in the worker inherits the stub.
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  afterEach(() => {
    cleanup();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  function renderWith(
    checks: Array<{ key: string; status: string }>,
    onRecord?: () => void,
    withPanels = true,
    liveKey: string | null = null
  ) {
    language.locale = "en";
    const base = financedDeal();
    // The fixture is live on Documents; UX4 tests move the live step (`liveKey`).
    const order = base.stages.map((stage) => stage.key);
    const deal = liveKey
      ? {
          ...base,
          // Settlement's first gate is the expected payment; these tests are about the cost items after it.
          expectedPaymentRegistered: liveKey === "SETTLEMENT",
          stages: base.stages.map((stage) => ({
            ...stage,
            state:
              stage.key === liveKey
                ? liveKey === "HANDOVER"
                  ? ("CURRENT" as const)
                  : ("BLOCKED" as const)
                : order.indexOf(stage.key) < order.indexOf(liveKey as (typeof order)[number])
                  ? ("COMPLETE" as const)
                  : ("PENDING" as const),
            blocker:
              stage.key === liveKey && liveKey !== "HANDOVER" ? ("AwaitingSettlement" as const) : undefined,
          })),
        }
      : base;
    return render(
      <DealCockpitView
        deal={deal}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={withPanels ? custodyWiring() : undefined}
        custodyMoney={withPanels ? custodyMoney : undefined}
        handoverCosts={withPanels ? handoverCostsWiring() : undefined}
        closingChecklist={{
          readiness: {
            state: "BLOCKED",
            open: true,
            unavailableReason: null,
            unavailableReasonCode: null,
            moneyWithheld: false,
            checks: checks.map((check) => ({ ...check, reason: "blocked", reasonCode: null })),
          } as unknown as NonNullable<React.ComponentProps<typeof DealCockpitView>["closingChecklist"]>["readiness"],
          legalInvoice: onRecord ? { onRecord } : undefined,
        }}
      />
    );
  }

  test("a blocked custody check scrolls to and focuses the custody panel", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderWith([{ key: "CUSTODY_SETTLED", status: "BLOCKED" }]);
    fireEvent.click(screen.getByTestId("closing-check-go-CUSTODY_SETTLED"));
    return new Promise<void>((done) =>
      requestAnimationFrame(() => {
        expect(scroll).toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId("deal-custody"));
        done();
      })
    );
  });

  test("blocked cost checks open the handover costs panel", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderWith([
      { key: "COSTS_CLOSABLE", status: "BLOCKED" },
      { key: "HANDOVER_COSTS_PAID", status: "BLOCKED" },
    ]);
    fireEvent.click(screen.getByTestId("closing-check-go-HANDOVER_COSTS_PAID"));
    return new Promise<void>((done) =>
      requestAnimationFrame(() => {
        expect(document.activeElement).toBe(screen.getByTestId("deal-handover-costs"));
        expect(screen.getByTestId("closing-check-go-COSTS_CLOSABLE")).toBeTruthy();
        done();
      })
    );
  });

  test("UX4 O2: handover costs are CLOSING gates -- the live Settlement card lists them, and the current one goes to the costs panel", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderWith(
      [
        { key: "CONFIGURED_FEES_RECORDED", status: "READY" },
        { key: "HANDOVER_COSTS_PAID", status: "BLOCKED" },
      ],
      undefined,
      true,
      "SETTLEMENT"
    );
    const list = screen.getByTestId("deal-step-checklist");
    const status = (id: string) => within(list).getByTestId(`deal-step-item-${id}`).getAttribute("data-status");
    expect(status("costs-recorded")).toBe("done");
    expect(status("costs-paid")).toBe("current");
    expect(status("close-deal")).toBe("pending");
    // Exactly one item is the current one, and it is the only one that acts.
    const go = within(list).getByTestId("deal-step-item-go");
    expect(go.getAttribute("aria-current")).toBe("step");
    expect(within(list).getAllByTestId("deal-step-item-go")).toHaveLength(1);
    fireEvent.click(go);
    return new Promise<void>((done) =>
      requestAnimationFrame(() => {
        expect(document.activeElement).toBe(screen.getByTestId("deal-handover-costs"));
        done();
      })
    );
  });

  test("UX4 O2 invariant: a Handover with unpaid costs says nothing is outstanding AND lists no costs and nothing pending", () => {
    renderWith(
      [
        { key: "CONFIGURED_FEES_RECORDED", status: "BLOCKED" },
        { key: "HANDOVER_COSTS_PAID", status: "BLOCKED" },
      ],
      undefined,
      true,
      "HANDOVER"
    );
    const list = screen.getByTestId("deal-step-checklist");
    expect(within(list).queryByTestId("deal-step-item-costs-recorded")).toBeNull();
    expect(within(list).queryByTestId("deal-step-item-costs-paid")).toBeNull();
    expect(list.querySelectorAll('[data-status="pending"]').length).toBe(0);
    expect(within(list).getByTestId("deal-step-item-register-handover").getAttribute("data-status")).toBe("current");
  });

  test("a blocked legal-invoice check opens the existing record dialog", () => {
    const onRecord = vi.fn();
    renderWith([{ key: "LEGAL_INVOICE_RECORDED", status: "BLOCKED" }], onRecord);
    fireEvent.click(screen.getByTestId("closing-check-go-LEGAL_INVOICE_RECORDED"));
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  test("CONTROL -- no panel to open, no link: the reason stays, and checks with no home get none", () => {
    renderWith(
      [
        { key: "CUSTODY_SETTLED", status: "BLOCKED" },
        { key: "COSTS_CLOSABLE", status: "BLOCKED" },
        { key: "LEGAL_INVOICE_RECORDED", status: "BLOCKED" },
        { key: "REMITTANCE_KNOWN", status: "BLOCKED" },
        { key: "FIRST_PAYMENT_RECORDED", status: "BLOCKED" },
      ],
      undefined,
      false
    );
    for (const key of ["CUSTODY_SETTLED", "COSTS_CLOSABLE", "LEGAL_INVOICE_RECORDED", "REMITTANCE_KNOWN", "FIRST_PAYMENT_RECORDED"]) {
      expect(screen.queryByTestId(`closing-check-go-${key}`)).toBeNull();
      expect(screen.getByTestId(`closing-check-${key}`)).toBeTruthy();
    }
  });

  test("CONTROL -- a satisfied check offers no link even with the panel present", () => {
    renderWith([{ key: "CUSTODY_SETTLED", status: "READY" }]);
    expect(screen.queryByTestId("closing-check-go-CUSTODY_SETTLED")).toBeNull();
  });
});

/**
 * SCRUM-417 UX3 (O1): the step workbench. The live step's own panel sits
 * directly under the next-step card; every other panel is kept whole inside a
 * collapsed "Deal details" record. Moved, never forked: a panel renders once.
 */
describe("O1 -- the step workbench", () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  afterEach(() => {
    cleanup();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    language.locale = "en";
  });

  // The panel each testid stands for. `deal-money` is the money column.
  const PANEL_TESTID = {
    documents: "deal-lower-tabs",
    financeDecision: "deal-finance-decision",
    handoverCosts: "deal-handover-costs",
    custody: "deal-custody",
    closing: "deal-closing-checklist",
    money: "deal-money",
  } as const;
  const ALL_PANEL_TESTIDS = Object.values(PANEL_TESTID);

  const noopAsync = async () => {};
  function financeDecision(): FinanceDecisionWiring {
    return {
      currency: "JOD",
      canRecordQuotation: true,
      canRecordApproval: true,
      canEstablishLtvPercent: true,
      canRecordAppraisal: true,
      isOwnDeal: false,
      calculation: { state: "UNAVAILABLE" },
      appraisal: null,
      onRecordQuotation: noopAsync,
      onRecordApproved: noopAsync,
      onReopenApproved: noopAsync,
      onRecordAppraisal: noopAsync,
      facts: {
        approvedPurchaseRecorded: false,
        submittedQuotationMinor: null,
        approvedPurchaseAmountMinor: null,
        financeCompanyFundedPortionMinor: null,
        unfinancedPortionMinor: null,
        dealerContributionMinor: null,
        appliedLtvPercent: null,
        closed: false,
        ltvMissing: false,
        handedOver: false,
        appraisalAmountMinor: null,
      },
    };
  }

  /** Executable order; the live stage is `live`, earlier ones done, later ones pending. */
  function stagesWithLive(live: FinancedDealStageKey | null, state: "CURRENT" | "STOPPED" = "CURRENT") {
    const order = orderStagesForDisplay(DEAL_STAGE_ORDER.map((key) => ({ key })));
    const liveIndex = live ? order.findIndex((s) => s.key === live) : order.length;
    return DEAL_STAGE_ORDER.map((key) => {
      const at = order.findIndex((s) => s.key === key);
      if (live === null && state === "STOPPED") {
        return { key, state: at === 2 ? ("STOPPED" as const) : at < 2 ? ("COMPLETE" as const) : ("PENDING" as const), authority: "DEALER" as const };
      }
      if (live === null) return { key, state: "COMPLETE" as const, authority: "DEALER" as const };
      if (live === "DISBURSEMENT") {
        // A closed deal awaiting the finance company: settlement not complete.
        return {
          key,
          state: key === "DISBURSEMENT" ? ("CURRENT" as const) : key === "SETTLEMENT" ? ("PENDING" as const) : ("COMPLETE" as const),
          authority: "DEALER" as const,
        };
      }
      return {
        key,
        state: at < liveIndex ? ("COMPLETE" as const) : at === liveIndex ? ("CURRENT" as const) : ("PENDING" as const),
        authority: "DEALER" as const,
      };
    });
  }

  function renderStage(
    live: FinancedDealStageKey | null,
    state: "CURRENT" | "STOPPED" = "CURRENT",
    extra: Partial<React.ComponentProps<typeof DealCockpitView>> = {}
  ) {
    return render(stageElement(live, state, extra));
  }

  function stageElement(
    live: FinancedDealStageKey | null,
    state: "CURRENT" | "STOPPED" = "CURRENT",
    extra: Partial<React.ComponentProps<typeof DealCockpitView>> = {}
  ) {
    language.locale = "en";
    const base = financedDeal();
    const deal: FinancedDealCockpitData = { ...base, stages: stagesWithLive(live, state) };
    return (
      <DealCockpitView
        deal={deal}
        backHref="/org_1/deals"
        activeAppraisalProvider={deal.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: financedOverview(), loading: false }}
        custody={custodyWiring()}
        custodyMoney={custodyMoney}
        financeDecision={financeDecision()}
        closingChecklist={{
          readiness: {
            state: "BLOCKED",
            open: true,
            unavailableReason: null,
            unavailableReasonCode: null,
            moneyWithheld: false,
            checks: [{ key: "CUSTODY_SETTLED", status: "BLOCKED", reason: "blocked", reasonCode: null }],
          } as unknown as NonNullable<React.ComponentProps<typeof DealCockpitView>["closingChecklist"]>["readiness"],
          legalInvoice: { onRecord: () => {} },
        }}
        financingPlan={{ facts: FINANCING_PLAN, formatMajor: (major, currency) => `${major.toLocaleString()} ${currency}` }}
        handoverCosts={handoverCostsWiring()}
        {...extra}
      />
    );
  }

  // One parent, keyed siblings: the next-step card, every panel and the toggle
  // are children of one grid, and each carries `data-zone` naming where it sits
  // now. The zone is what the tests read; the DOM order is what a tab key walks.
  const zoneOf = (testId: string) => screen.getByTestId(testId).closest("[data-zone]")?.getAttribute("data-zone") ?? null;
  const wrapperOf = (testId: string) => screen.getByTestId(testId).closest("[data-zone]") as HTMLElement;
  const toggle = () => screen.getByTestId("deal-details-toggle");
  const recordOpen = () => toggle().getAttribute("aria-expanded") === "true";
  /** Every record wrapper is hidden together: collapsed means hidden, never removed. */
  const recordHidden = () =>
    Array.from(document.querySelectorAll('[data-zone="record"]')).every((el) => (el as HTMLElement).hidden);
  const workbenchWrappers = () => Array.from(document.querySelectorAll('[data-zone="workbench"]')) as HTMLElement[];

  test.each([
    ["CREDIT_DECISION", ["documents"]],
    ["APPRAISAL", ["financeDecision"]],
    ["APPROVED_PURCHASE", ["financeDecision"]],
    ["DELIVERY_ACTIONS", ["documents"]],
    ["HANDOVER", ["handoverCosts", "custody"]],
    ["SETTLEMENT", ["closing"]],
    ["DISBURSEMENT", ["money"]],
  ] as const)(
    "%s: its panel is in the workbench right under the next-step card, the rest are in Deal details",
    (stage, promoted) => {
      renderStage(stage);
      const promotedIds = promoted.map((key) => PANEL_TESTID[key]) as string[];
      // Directly after the card: nothing sits between the step and its panel,
      // and the workbench panels come in the map's order, before the toggle.
      const step = wrapperOf("deal-next-step");
      expect(step.getAttribute("data-zone")).toBe("step");
      let cursor: Element | null = step.nextElementSibling;
      for (const testId of promotedIds) {
        expect(cursor?.querySelector(`[data-testid="${testId}"]`), `${testId} follows the card`).not.toBeNull();
        expect(cursor?.getAttribute("data-zone")).toBe("workbench");
        cursor = cursor?.nextElementSibling ?? null;
      }
      expect(cursor?.querySelector('[data-testid="deal-details-toggle"]')).not.toBeNull();
      for (const testId of ALL_PANEL_TESTIDS) {
        expect(zoneOf(testId), `${testId} zone`).toBe(promotedIds.includes(testId) ? "workbench" : "record");
      }
      // Nothing is dropped: every panel is in the document, exactly once.
      for (const testId of ALL_PANEL_TESTIDS) {
        expect(screen.getAllByTestId(testId), `${testId} rendered once`).toHaveLength(1);
      }
      // With a live step the record starts collapsed: hidden, still mounted.
      expect(recordOpen()).toBe(false);
      expect(recordHidden()).toBe(true);
      for (const wrapper of workbenchWrappers()) expect(wrapper.hidden).toBe(false);
    }
  );

  test("Deal details is a button disclosure: keyboard-operable, aria-expanded, and it controls the record", () => {
    renderStage("SETTLEMENT");
    expect(toggle().tagName).toBe("BUTTON");
    expect(recordOpen()).toBe(false);
    // Every id it controls is a real record wrapper.
    const controlled = (toggle().getAttribute("aria-controls") ?? "").split(" ");
    expect(controlled.length).toBeGreaterThan(1);
    for (const id of controlled) expect(document.getElementById(id)?.getAttribute("data-zone")).toBe("record");
    // Collapsed but mounted and reachable in the tree.
    expect(screen.getByTestId("deal-custody")).toBeTruthy();
    fireEvent.click(toggle());
    expect(recordOpen()).toBe(true);
    expect(recordHidden()).toBe(false);
    fireEvent.click(toggle());
    expect(recordOpen()).toBe(false);
    expect(recordHidden()).toBe(true);
  });

  test("a live step with no panel of its own (application) promotes nothing and opens the record", () => {
    renderStage("APPLICATION");
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(true);
    expect(recordHidden()).toBe(false);
    for (const testId of ALL_PANEL_TESTIDS) expect(zoneOf(testId)).toBe("record");
  });

  test("a fully complete deal promotes nothing, so the record is open and nothing is hidden behind a click", () => {
    renderStage(null);
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(true);
    expect(recordHidden()).toBe(false);
    for (const testId of ALL_PANEL_TESTIDS) expect(screen.getAllByTestId(testId)).toHaveLength(1);
  });

  test("a stopped deal promotes nothing and opens the record", () => {
    renderStage(null, "STOPPED");
    expect(screen.getByTestId("deal-stopped")).toBeTruthy();
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(true);
    for (const testId of ALL_PANEL_TESTIDS) expect(screen.getAllByTestId(testId)).toHaveLength(1);
  });

  test("a live step whose panel is not wired YET keeps the record closed, so it never flashes open and snaps shut", () => {
    language.locale = "en";
    const base = financedDeal();
    const view = (wired: boolean) => (
      <DealCockpitView
        deal={{ ...base, stages: stagesWithLive("APPRAISAL") } as FinancedDealCockpitData}
        backHref="/org_1/deals"
        activeAppraisalProvider={base.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        financeDecision={wired ? financeDecision() : undefined}
        workbenchPending={!wired}
      />
    );
    const { rerender } = render(view(false));
    // No promoted panel yet: no empty workbench, and the record is not open.
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(false);
    // Everything is one click away, and nothing is lost while it loads.
    expect(screen.getByTestId("deal-lower-tabs")).toBeTruthy();
    rerender(view(true));
    // The panel arrives into the workbench; the record never opened in between.
    expect(zoneOf(PANEL_TESTID.financeDecision)).toBe("workbench");
    expect(recordOpen()).toBe(false);
  });

  test("a cash sale at handover has no promoted panel of its own here: the record opens", () => {
    // The cash container wires neither handover costs nor custody (see the
    // SaleCockpit props), so nothing is promoted and the record is the surface.
    language.locale = "en";
    const base = financedDeal();
    const deal = {
      ...base,
      dealKind: "CASH",
      financingApplicationId: null,
      applicationId: null,
      saleId: "sale_7731",
      dealRef: "sale_7731",
      status: "COMPLETED",
      stages: [
        { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
        { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
        { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
      ],
    } as unknown as DealCockpitData;
    render(<DealCockpitView deal={deal} backHref="/org_1/deals" onRecordSupplierReceipt={async () => {}} />);
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(true);
    expect(zoneOf("deal-money")).toBe("record");
  });

  test("a cash sale at the agreement step has no panel to promote: the record opens", () => {
    language.locale = "en";
    const base = financedDeal();
    const deal = {
      ...base,
      dealKind: "CASH",
      financingApplicationId: null,
      applicationId: null,
      saleId: "sale_7731",
      dealRef: "sale_7731",
      status: "PENDING",
      stages: [
        { key: "SALE_AGREED", state: "CURRENT", authority: "DEALER" },
        { key: "HANDOVER", state: "PENDING", authority: "DEALER" },
        { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
      ],
    } as unknown as DealCockpitData;
    render(<DealCockpitView deal={deal} backHref="/org_1/deals" onRecordSupplierReceipt={async () => {}} />);
    expect(workbenchWrappers()).toHaveLength(0);
    expect(recordOpen()).toBe(true);
  });

  // A panel that changes place when the live stage changes must be MOVED, not
  // remounted: its money-command state (the add-cost form's intent, an open
  // custody dialog and its identity) is component-local, and losing it would
  // forget an attempt whose outcome may be UNKNOWN. Another user registering
  // the handover flips the stage under an operator with a form open.
  test.each([
    ["HANDOVER", "SETTLEMENT"],
    ["SETTLEMENT", "HANDOVER"],
  ] as const)("a stage change %s -> %s keeps an open add-cost form and its intent", (from, to) => {
    const { rerender } = renderStage(from);
    const panel = screen.getByTestId("deal-handover-costs");
    fireEvent.click(within(panel).getByRole("button", { name: (dictionaries.en as Record<string, string>).AddHandoverCost, hidden: true }));
    const form = screen.getByTestId("deal-handover-cost-add");
    const intent = form.getAttribute("data-intent");
    expect(intent).toBeTruthy();

    rerender(stageElement(to));

    expect(screen.getByTestId("deal-handover-costs")).toBe(panel);
    expect(screen.getByTestId("deal-handover-cost-add")).toBe(form);
    expect(screen.getByTestId("deal-handover-cost-add").getAttribute("data-intent")).toBe(intent);
  });

  test.each([
    ["HANDOVER", "SETTLEMENT"],
    ["SETTLEMENT", "HANDOVER"],
  ] as const)("a stage change %s -> %s keeps an open custody dialog", (from, to) => {
    const { rerender } = renderStage(from);
    const panel = screen.getByTestId("deal-custody");
    fireEvent.click(within(panel).getByRole("button", { name: (dictionaries.en as Record<string, string>).CustodyRecordReturn, hidden: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(stageElement(to));

    expect(screen.getByTestId("deal-custody")).toBe(panel);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  // N1: a caller who is never given a panel (VIEW_SALES without
  // VIEW_FINANCE_APPLICATIONS: the economics and closing queries are skipped, so
  // financeDecision and closingChecklist stay undefined for good) is not "still
  // loading". The container says so with `workbenchPending`; the view must not
  // guess it from the stage map, or that caller gets an empty workbench over a
  // collapsed record.
  test.each(["APPRAISAL", "APPROVED_PURCHASE", "SETTLEMENT"] as const)(
    "N1: %s for a caller who is never given its panel, loading finished: the record is open",
    (stage) => {
      language.locale = "en";
      const base = financedDeal();
      render(
        <DealCockpitView
          deal={{ ...base, stages: stagesWithLive(stage) } as FinancedDealCockpitData}
          backHref="/org_1/deals"
          activeAppraisalProvider={base.activeAppraisalProvider}
          onRecordSupplierReceipt={async () => {}}
          workbenchPending={false}
        />
      );
      expect(workbenchWrappers()).toHaveLength(0);
      expect(recordOpen()).toBe(true);
      expect(recordHidden()).toBe(false);
    }
  );

  test("N1 control: the same caller while the queries are still pending keeps the record closed", () => {
    language.locale = "en";
    const base = financedDeal();
    render(
      <DealCockpitView
        deal={{ ...base, stages: stagesWithLive("SETTLEMENT") } as FinancedDealCockpitData}
        backHref="/org_1/deals"
        activeAppraisalProvider={base.activeAppraisalProvider}
        onRecordSupplierReceipt={async () => {}}
        workbenchPending
      />
    );
    expect(recordOpen()).toBe(false);
    expect(recordHidden()).toBe(true);
  });

  // Sol 417-1 / N2: a stage change that demotes a panel must not hide an active
  // task. The form, its focus and its intent survive, and the operator can see it.
  const insideHidden = (el: Element) => el.closest("[hidden]") !== null;

  test("Sol 417-1: HANDOVER -> SETTLEMENT with focus in the add-cost form opens the record and keeps the focus and the intent", () => {
    const { rerender } = renderStage("HANDOVER");
    const panel = screen.getByTestId("deal-handover-costs");
    fireEvent.click(within(panel).getByRole("button", { name: (dictionaries.en as Record<string, string>).AddHandoverCost }));
    const form = screen.getByTestId("deal-handover-cost-add");
    const intent = form.getAttribute("data-intent");
    const field = form.querySelector("input, textarea, select") as HTMLElement;
    field.focus();
    expect(document.activeElement).toBe(field);

    rerender(stageElement("SETTLEMENT"));

    // It moved into the record, and the record opened rather than hiding it.
    expect(zoneOf("deal-handover-costs")).toBe("record");
    expect(recordOpen()).toBe(true);
    expect(insideHidden(screen.getByTestId("deal-handover-cost-add"))).toBe(false);
    expect(screen.getByTestId("deal-handover-cost-add")).toBe(form);
    expect(document.activeElement).toBe(field);
    expect(screen.getByTestId("deal-handover-cost-add").getAttribute("data-intent")).toBe(intent);
  });

  test("Sol 417-1 control (a): the same transition with no open form keeps the record collapsed", () => {
    const { rerender } = renderStage("HANDOVER");
    expect(screen.queryByTestId("deal-handover-cost-add")).toBeNull();
    rerender(stageElement("SETTLEMENT"));
    expect(zoneOf("deal-handover-costs")).toBe("record");
    expect(recordOpen()).toBe(false);
    expect(recordHidden()).toBe(true);
  });

  test("Sol 417-1 control (b): an open custody dialog stays visible across the transition, with its panel", () => {
    const { rerender } = renderStage("HANDOVER");
    const panel = screen.getByTestId("deal-custody");
    fireEvent.click(within(panel).getByRole("button", { name: (dictionaries.en as Record<string, string>).CustodyRecordReturn }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(stageElement("SETTLEMENT"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("deal-custody")).toBe(panel);
    expect(recordOpen()).toBe(true);
    expect(insideHidden(screen.getByTestId("deal-custody"))).toBe(false);
  });

  // Sol 417-R1 / Opus L6: an upload in flight (or a file preview open) is an
  // active task exactly like an open add-cost form. A live-stage change that
  // demotes the documents panel must not hide it behind a closed record.
  const documentsWiring = (uploading: ReadonlyArray<string>, fileUrl: string | null = null) => ({
    items: [{ _id: "d1", ruleId: "r1", ruleName: "National ID copy", status: "MISSING", fileUrl }],
    canUpload: true,
    canVerify: false,
    uploadingRuleIds: new Set(uploading) as ReadonlySet<string>,
    onUpload: () => {},
    onVerify: () => {},
  });

  test("Sol 417-R1: DELIVERY_ACTIONS -> APPRAISAL with an upload in flight and focus elsewhere opens the record, same panel, same upload state", () => {
    const { rerender } = renderStage("DELIVERY_ACTIONS", "CURRENT", { documents: documentsWiring(["r1"]) });
    expect(zoneOf("deal-lower-tabs")).toBe("workbench");
    const panel = screen.getByTestId("deal-documents");
    expect(document.activeElement).toBe(document.body);

    rerender(stageElement("APPRAISAL", "CURRENT", { documents: documentsWiring(["r1"]) }));

    expect(zoneOf("deal-lower-tabs")).toBe("record");
    expect(recordOpen()).toBe(true);
    expect(insideHidden(screen.getByTestId("deal-documents"))).toBe(false);
    expect(screen.getByTestId("deal-documents")).toBe(panel);
    expect((document.getElementById("deal-doc-file-d1") as HTMLInputElement).disabled).toBe(true);
  });

  test("Sol 417-R1 control (a): the same transition with no upload keeps the idle documents panel collapsed", () => {
    const { rerender } = renderStage("DELIVERY_ACTIONS", "CURRENT", { documents: documentsWiring([]) });
    rerender(stageElement("APPRAISAL", "CURRENT", { documents: documentsWiring([]) }));
    expect(zoneOf("deal-lower-tabs")).toBe("record");
    expect(recordOpen()).toBe(false);
    expect(recordHidden()).toBe(true);
  });

  test("Sol 417-R1: an open file preview also keeps the documents panel visible across the transition", () => {
    const { rerender } = renderStage("DELIVERY_ACTIONS", "CURRENT", {
      documents: documentsWiring([], "https://files.test/id.pdf"),
    });
    const view = (dictionaries.en as Record<string, string>).ViewFile;
    fireEvent.click(within(screen.getByTestId("deal-documents")).getByRole("button", { name: view }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Nothing is focused inside the panel itself: the dialog owns focus.
    rerender(stageElement("APPRAISAL", "CURRENT", { documents: documentsWiring([], "https://files.test/id.pdf") }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(recordOpen()).toBe(true);
    expect(insideHidden(screen.getByTestId("deal-documents"))).toBe(false);
  });

  // Opus L3: the focus-only branch. Focus sits on a control of a panel that is
  // about to be demoted, with NO active-task marker on it: the record still
  // opens so the focused control is not hidden under the operator.
  test("Opus L3: focus inside a demoted panel with no active task opens the record and keeps the focus", () => {
    const { rerender } = renderStage("HANDOVER");
    const add = within(screen.getByTestId("deal-handover-costs")).getByRole("button", {
      name: (dictionaries.en as Record<string, string>).AddHandoverCost,
    });
    add.focus();
    expect(document.activeElement).toBe(add);
    expect(screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task")).toBe(false);

    rerender(stageElement("SETTLEMENT"));

    expect(zoneOf("deal-handover-costs")).toBe("record");
    expect(recordOpen()).toBe(true);
    expect(insideHidden(add)).toBe(false);
    expect(document.activeElement).toBe(add);
  });

  // Opus L3, stated plainly: the layout effect that puts focus back on
  // `flowFocusRef` after a stage change is NOT covered by any automated test.
  // Deleting its focus call fails nothing in jsdom: React's own focus restore
  // after a commit, and jsdom's lack of rendering, both mask it (several
  // attempts to emulate a browser-side loss, including refusing focus inside
  // `hidden`, left the mutation alive). It is kept, and is unverified in a
  // real browser.

  // Sol 417-R2: jsdom has no keyboard activation (no user-event here), so this
  // test does NOT claim the browser turns Enter/Space into a click. It pins
  // what the browser's native activation depends on: a real focusable button,
  // that no key handler cancels Enter/Space, and that a click toggles it. Real
  // keyboard activation is covered by no automated test here (no hydrated
  // browser harness) and is a recorded follow-up.
  test("Sol 417-R2: Deal details is a native button no key handler cancels, and a click toggles it", () => {
    renderStage("SETTLEMENT");
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("type")).toBe("button");
    expect(toggle().tabIndex).toBeGreaterThanOrEqual(0);
    toggle().focus();
    expect(document.activeElement).toBe(toggle());
    for (const key of ["Enter", " "]) {
      const init = { key, code: key === " " ? "Space" : "Enter", bubbles: true, cancelable: true };
      // fireEvent returns false when a handler called preventDefault.
      expect(fireEvent.keyDown(toggle(), init), `keydown ${JSON.stringify(key)} is not cancelled`).toBe(true);
      expect(fireEvent.keyUp(toggle(), init), `keyup ${JSON.stringify(key)} is not cancelled`).toBe(true);
    }
    expect(recordOpen()).toBe(false);
    fireEvent.click(toggle());
    expect(recordOpen()).toBe(true);
    expect(recordHidden()).toBe(false);
    fireEvent.click(toggle());
    expect(recordOpen()).toBe(false);
    expect(recordHidden()).toBe(true);
    expect(document.activeElement).toBe(toggle());
  });

  test("collapsing Deal details does not unmount what is in it", () => {
    renderStage("SETTLEMENT");
    const panel = screen.getByTestId("deal-custody");
    fireEvent.click(screen.getByTestId("deal-details-toggle"));
    fireEvent.click(screen.getByTestId("deal-details-toggle"));
    expect(screen.getByTestId("deal-custody")).toBe(panel);
  });

  test("S4: a blocked check whose panel is inside collapsed Deal details opens it before it scrolls and focuses", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderStage("SETTLEMENT");
    // The checklist is the step's panel; custody is in the collapsed record.
    expect(recordOpen()).toBe(false);
    expect(zoneOf("deal-custody")).toBe("record");
    fireEvent.click(screen.getByTestId("closing-check-go-CUSTODY_SETTLED"));
    // Revealed synchronously, before the frame in which the scroll happens.
    expect(recordOpen()).toBe(true);
    expect(recordHidden()).toBe(false);
    return new Promise<void>((done) =>
      requestAnimationFrame(() => {
        expect(scroll).toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId("deal-custody"));
        done();
      })
    );
  });
  // ---------------------------------------------------------------------------
  // SCRUM-417 UX4 round 1 (F2, F4, F6, F7, F8): rendered, real dictionaries.
  // ---------------------------------------------------------------------------
  const viewLink = (value: string | null) => ({ value, onChange: vi.fn() });
  const en = dictionaries.en as Record<string, string>;
  const ar = dictionaries.ar as Record<string, string>;
  /** Render with the locale set AFTER the element is built (stageElement pins "en"). */
  function renderIn(locale: "en" | "ar", element: React.ReactElement) {
    language.locale = locale;
    return render(element);
  }
  const cashDealAt = (live: "SALE_AGREED" | "HANDOVER") =>
    ({
      ...financedDeal(),
      dealKind: "CASH",
      financingApplicationId: null,
      applicationId: null,
      saleId: "sale_7731",
      dealRef: "sale_7731",
      status: "PENDING",
      stages: ["SALE_AGREED", "HANDOVER", "SETTLEMENT"].map((key) => ({
        key,
        state: key === live ? "CURRENT" : key === "SALE_AGREED" ? "COMPLETE" : "PENDING",
        authority: "DEALER",
      })),
    }) as unknown as DealCockpitData;

  test.each(["en", "ar"] as const)(
    "F4 (%s): a FUTURE financed Handover says what it needs -- and costs are not a handover gate",
    (locale) => {
      const el = stageElement("DELIVERY_ACTIONS", "CURRENT", { stageDeepLink: viewLink("HANDOVER") });
      renderIn(locale, el);
      const dict = locale === "en" ? en : ar;
      const needs = screen.getByTestId("deal-stage-view-needs").textContent ?? "";
      expect(needs).toContain(dict.StageNeedsHandover);
      expect(dict.StageNeedsHandover).not.toBe(dict.StageNeedsHandoverCash);
      if (locale === "en") expect(needs).toMatch(/costs are settled later/i);
    }
  );

  test.each(["en", "ar"] as const)("F4 (%s): a FUTURE financed Settlement includes the expected payment", (locale) => {
    const el = stageElement("HANDOVER", "CURRENT", { stageDeepLink: viewLink("SETTLEMENT") });
    renderIn(locale, el);
    const dict = locale === "en" ? en : ar;
    const needs = screen.getByTestId("deal-stage-view-needs").textContent ?? "";
    expect(needs).toContain(dict.StageNeedsSettlement);
    if (locale === "en") expect(needs).toMatch(/expected payment/i);
  });

  test.each(["en", "ar"] as const)(
    "F4 (%s): a FUTURE cash Settlement has its own wording, not the financed one",
    (locale) => {
      language.locale = locale;
      render(
        <DealCockpitView
          deal={cashDealAt("SALE_AGREED")}
          backHref="/org_1/deals"
          onRecordSupplierReceipt={async () => {}}
          stageDeepLink={viewLink("SETTLEMENT")}
        />
      );
      const dict = locale === "en" ? en : ar;
      const needs = screen.getByTestId("deal-stage-view-needs").textContent ?? "";
      expect(needs).toContain(dict.StageNeedsSettlementCash);
      expect(dict.StageNeedsSettlementCash).not.toBe(dict.StageNeedsSettlement);
      expect(needs).not.toContain(dict.StageNeedsSettlement);
    }
  );

  test.each(["en", "ar"] as const)(
    "F7 (%s): a STOPPED step is terminal -- no 'will need', no owner, no checklist",
    (locale) => {
      const order = orderStagesForDisplay(DEAL_STAGE_ORDER.map((key) => ({ key })));
      const stopped = order[2].key;
      const el = stageElement(null, "STOPPED", { stageDeepLink: viewLink(stopped) });
      renderIn(locale, el);
      const dict = locale === "en" ? en : ar;
      const view = screen.getByTestId("deal-stage-view");
      expect(view.getAttribute("data-mode")).toBe("stopped");
      expect(view.textContent).toContain(dict.StageViewStoppedNote);
      expect(within(view).queryByTestId("deal-stage-view-needs")).toBeNull();
      expect(within(view).queryByTestId("deal-stage-view-owner")).toBeNull();
      expect(within(view).queryByTestId("deal-step-checklist")).toBeNull();
      expect(view.textContent).not.toContain(dict.StageViewWillNeed ?? "\u0000");
    }
  );

  test("F6: Back puts focus on the live rail button and the live region says where the view went", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderStage("HANDOVER");
    const announcer = screen.getByTestId("deal-stage-view-announcer");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("");
    fireEvent.click(screen.getByTestId("deal-stage-node-SETTLEMENT"));
    expect(announcer.textContent).toContain(en.StageViewAnnounceShowing);
    const back = screen.getByTestId("deal-stage-view-back");
    back.focus();
    fireEvent.click(back);
    // The chip unmounted with the card; focus is on a real control, not <body>.
    expect(screen.queryByTestId("deal-stage-view-back")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("deal-stage-node-HANDOVER"));
    expect(announcer.textContent).toContain(en.StageViewAnnounceBack);
    // The region persisted across the whole exchange (same node, never remounted).
    expect(screen.getByTestId("deal-stage-view-announcer")).toBe(announcer);
  });

  test("F8: when the viewed step BECOMES the live one, the stale ?stage is cleared", () => {
    const link = viewLink("HANDOVER");
    const { rerender } = renderStage("DELIVERY_ACTIONS", "CURRENT", { stageDeepLink: link });
    expect(screen.getByTestId("deal-stage-view").getAttribute("data-stage")).toBe("HANDOVER");
    expect(link.onChange).not.toHaveBeenCalled();
    rerender(stageElement("HANDOVER", "CURRENT", { stageDeepLink: link }));
    expect(screen.queryByTestId("deal-stage-view")).toBeNull();
    expect(link.onChange).toHaveBeenCalledWith(null);
  });

  // F2: an ANSWERED empty list must not read as "no answer".
  describe("F2: readiness answered with no checks", () => {
    const liveSettlement = (readiness: unknown) => {
      const el = stageElement("SETTLEMENT", "CURRENT", {
        closingChecklist: { readiness } as unknown as NonNullable<
          React.ComponentProps<typeof DealCockpitView>["closingChecklist"]
        >,
      });
      language.locale = "en";
      return render({ ...el, props: { ...el.props, deal: { ...el.props.deal, expectedPaymentRegistered: true } } });
    };
    const statusOf = (id: string) =>
      within(screen.getByTestId("deal-step-checklist")).queryByTestId(`deal-step-item-${id}`)?.getAttribute("data-status") ?? null;
    const base = { open: true, unavailableReason: null, unavailableReasonCode: null, moneyWithheld: false };

    test("UNAVAILABLE with checks: [] keeps the cost items on the list, NOT done", () => {
      liveSettlement({ ...base, state: "UNAVAILABLE", checks: [] });
      expect(statusOf("costs-recorded")).not.toBeNull();
      expect(statusOf("costs-recorded")).not.toBe("done");
      expect(statusOf("costs-paid")).not.toBe("done");
      expect(statusOf("costs-paid")).not.toBeNull();
    });

    test("READY checks are done; NOT_APPLICABLE ones are omitted; a missing key is not done", () => {
      liveSettlement({
        ...base,
        state: "BLOCKED",
        checks: [
          { key: "CONFIGURED_FEES_RECORDED", status: "READY", reason: null, reasonCode: null },
          { key: "HANDOVER_COSTS_PAID", status: "NOT_APPLICABLE", reason: null, reasonCode: null },
        ],
      });
      expect(statusOf("costs-recorded")).toBe("done");
      expect(statusOf("costs-paid")).toBeNull();
      cleanup();
      liveSettlement({ ...base, state: "BLOCKED", checks: [{ key: "CONFIGURED_FEES_RECORDED", status: "READY", reason: null, reasonCode: null }] });
      expect(statusOf("costs-paid")).not.toBe("done");
      expect(statusOf("costs-paid")).not.toBeNull();
    });

    test("redaction (no readiness answer at all) shows the cost items as not done, never as done", () => {
      liveSettlement(undefined);
      for (const id of ["costs-recorded", "costs-paid", "closing-checks", "close-deal"]) {
        expect(statusOf(id), id).not.toBe("done");
      }
    });
  });
});
