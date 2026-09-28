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

import { DealCockpitView, StageFocusRow, type WorkflowAction } from "./DealCockpit";
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
  } & (
    | { kind: "FINANCED"; stageKey: FinancedDealStageKey }
    | { kind: "CASH"; stageKey: CashDealStageKey }
  )
>;

function stagePosition(focus: FocusState): { position: number; total: number } {
  const order: readonly string[] = focus.kind === "CASH" ? CASH_DEAL_STAGE_ORDER : DEAL_STAGE_ORDER;
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
    action: { actionKey: "CompleteDocumentsAction", opens: "DOCUMENTS", unavailableReasonKey: "DocumentsAwaitVerifier" },
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
    // Round 2 (S417-R2-3, contained): a quote-linked draft holding a deposit.
    id: "cash-handover-deposit-decision",
    kind: "CASH",
    stageKey: "HANDOVER",
    state: "CURRENT",
    labelKey: "StageHandover",
    ownerKey: "StageOwnerDealership",
    action: { actionKey: "CompleteCashSaleAction", unavailableReasonKey: "CashSaleCompletionNeedsDepositDecision" },
  },
] satisfies readonly FocusState[];

/**
 * Round 2 (S417-R2-5): the documents panel with every control a row can carry
 * at once — a MISSING row reset with its old file still attached shows View,
 * Verify and the replacement upload side by side, the widest row the panel
 * can paint. Rendered through the REAL panel for a verifier who may upload.
 */
function documentsPanelMarkup(locale: "en" | "ar"): string {
  const table = dictionaries[locale] as Record<string, string>;
  const t = (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
  for (const key of ["ViewFile", "Verify", "ReplaceFile", "Upload", "DocMissing", "DocRejected"]) {
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
            moneyWithheld: false,
            checks: [
              { key: "REMITTANCE_KNOWN", status: "READY", reason: null },
              { key: "CONFIGURED_FEES_RECORDED", status: "READY", reason: null },
              { key: "CUSTODY_ON_LEDGER", status: "READY", reason: null },
              {
                key: "CUSTODY_SETTLED",
                status: "BLOCKED",
                reason: "A custody record on this deal is still open. Settle what that person holds or is owed before finalizing.",
              },
              {
                key: "COSTS_CLOSABLE",
                status: "BLOCKED",
                reason: "1 cost(s) on this deal have no actual amount recorded. Estimates may be used to run the deal, but not to close it.",
              },
              { key: "FIRST_PAYMENT_RECORDED", status: "READY", reason: null },
              { key: "LEGAL_INVOICE_RECORDED", status: "READY", reason: null },
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
});
