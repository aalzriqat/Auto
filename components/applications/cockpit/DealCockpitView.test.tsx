/**
 * What the cockpit actually puts on screen.
 *
 * Every defect pinned here was found by RENDERING the screen, not by reading
 * it: raw workflow enums leaking into an otherwise fully Arabic page, and a
 * currency marker that was either too long to fit on mobile or belonged to the
 * wrong locale. None of them could fail a server test, and all of them were
 * plainly visible the moment the page was looked at.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DealCockpitData } from "./DealCockpit";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    // Identity `t` so a MISSING translation shows up as its key rather than
    // silently rendering something plausible.
    t: (key: string) => key,
    isRtl: language.locale === "ar",
    locale: language.locale,
  }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "د.أ",
    displayLabel: "دينار اردني",
    format: (n: number) => `${n} دينار اردني`,
    formatCompact: (n: number) => String(n),
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

import { DealCockpitView } from "./DealCockpit";

const SCALE = 1_000;

function dealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    applicationId: "app_2048",
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1",
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: true,
      supplierName: "شركة عمّان للاستيراد",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete" },
      { key: "SETTLEMENT", state: "PENDING" },
    ],
    documents: [{ ruleId: "r1", name: "سند نقل الملكية", required: true, status: "MISSING" }],
    timeline: [
      { toStatus: "PENDING_DOCS", changedAt: Date.UTC(2026, 6, 28), actorName: "ليث العمري" },
    ],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      managementProfit: {
        available: true,
        amountMinor: 2_410 * SCALE,
        currency: "JOD",
        classification: "ESTIMATED_AWAITING_SETTLEMENT",
        postable: false,
        lines: [{ key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE }],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [
        { party: "SUPPLIER", name: "شركة عمّان للاستيراد", position: "DEALERSHIP_OWES", amountMinor: 9_500 * SCALE, currency: "JOD" },
      ],
      appraisalGapMinor: undefined,
    },
    ...overrides,
  } as unknown as DealCockpitData;
}

function renderCockpit(deal: DealCockpitData | null | undefined = dealFixture()) {
  return render(<DealCockpitView deal={deal} onRecordSupplierReceipt={async () => {}} />);
}

afterEach(() => {
  cleanup();
  language.locale = "ar";
});

describe("the workflow enum never reaches the operator", () => {
  test("the status badge is translated, not the raw value", () => {
    renderCockpit();
    // It rendered the literal "APPROVED" on a fully Arabic screen.
    expect(screen.queryByText("APPROVED")).toBeNull();
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
  });

  test("the status history is translated, not the raw value", () => {
    renderCockpit();
    expect(screen.queryByText("PENDING_DOCS")).toBeNull();
    expect(screen.getByText("PendingDocs")).toBeTruthy();
  });
});

describe("the currency marker", () => {
  test("is the short Arabic symbol in Arabic", () => {
    // `format` would render "دينار اردني" beside every figure, which wrapped
    // each amount onto two lines on mobile.
    language.locale = "ar";
    renderCockpit();
    expect(screen.getByText(/2,410 د\.أ/)).toBeTruthy();
    expect(screen.queryByText(/دينار اردني/)).toBeNull();
  });

  test("is the currency CODE in English, never the Arabic symbol", () => {
    // An RTL symbol beside Latin digits is an RTL run inside an LTR one —
    // exactly the bidi case this screen isolates everywhere else.
    language.locale = "en";
    renderCockpit();
    expect(screen.getByText(/2,410 JOD/)).toBeTruthy();
    expect(screen.queryByText(/د\.أ/)).toBeNull();
  });
});

describe("the headline figure", () => {
  test("always renders its qualifier alongside the amount", () => {
    renderCockpit();
    expect(screen.getByText(/2,410/)).toBeTruthy();
    expect(screen.getByText("ProfitEstimatedAwaitingSettlement")).toBeTruthy();
  });

  test("says it cannot be computed rather than showing a zero", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          managementProfit: { available: false, reason: "NoApprovedPurchaseAmount" },
        },
      })
    );
    expect(screen.getByText("ProfitNotCalculable")).toBeTruthy();
    expect(screen.getByText("ProfitNeedsApprovedPurchase")).toBeTruthy();
  });
});

describe("a caller who cannot see the money", () => {
  test("still gets the deal, without the figures", () => {
    renderCockpit(dealFixture({ money: null }));
    expect(screen.getByText("MoneyPanelHidden")).toBeTruthy();
    // The rest of the screen still renders — a permission that blanks
    // everything turns "you cannot see the profit" into "this deal is broken".
    // Twice: once on the rail, once as the next step.
    expect(screen.getAllByText("StageDeliveryActions").length).toBeGreaterThan(0);
    expect(screen.queryByText(/2,410/)).toBeNull();
  });
});

describe("when the settlement route could not be established", () => {
  test("the screen says so rather than showing a confident layout", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          routeKnown: false,
          parties: [
            { party: "SUPPLIER", name: "شركة عمّان للاستيراد", position: "UNKNOWN", amountMinor: 0, currency: "JOD" },
          ],
        },
      })
    );
    expect(screen.getByText("RouteUnknownWarning")).toBeTruthy();
    expect(screen.getByText("PositionUnknown")).toBeTruthy();
  });
});
