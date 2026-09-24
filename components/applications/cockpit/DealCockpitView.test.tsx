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
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

// Currency-AWARE, matching the real helper's behaviour for the two currencies
// these tests use. A constant 3 would have made every "does this figure use the
// right scale?" assertion pass by construction, which is precisely the class of
// defect the scale tests exist to catch.
vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (code === "USD" ? 2 : 3),
}));

import { DealCockpitView } from "./DealCockpit";

/**
 * A `toBeVisible` with jest-dom's semantics, defined here because this repo's
 * `vitest.setup.ts` deliberately installs no jest-dom (see
 * `OpeningBalanceApprovalPanel.test.tsx`). Visible means: attached, and neither
 * the element nor any ancestor is `display: none`, `visibility: hidden`,
 * `opacity: 0`, carries the `hidden` attribute, or is a closed `<details>`
 * body — plus `.sr-only`, which is this codebase's screen-reader-only class
 * and is visually hidden by its stylesheet, which jsdom never loads.
 */
function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.classList.contains("sr-only")) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (node.tagName === "DETAILS" && !node.hasAttribute("open") && !el.closest("summary")) return false;
  }
  return true;
}

expect.extend({
  toBeVisible(received: unknown) {
    const pass = received instanceof Element && isVisible(received);
    return {
      pass,
      message: () =>
        `expected element ${pass ? "not " : ""}to be visible: ${
          received instanceof Element ? received.outerHTML.slice(0, 200) : String(received)
        }`,
    };
  },
});

declare module "vitest" {
  interface Assertion {
    toBeVisible(): void;
  }
}

const SCALE = 1_000;

function dealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    dealKind: "FINANCED",
    // The denomination the SERVER vouches for. Present in every fixture because
    // a payload without one now correctly HIDES the money rather than spelling
    // it at a guessed scale — the fixture must supply what the server supplies.
    denomination: { code: "JOD", scale: 3 },
    dealRef: "app_2048",
    applicationId: "app_2048",
    saleId: null,
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
      profit: {
        available: true,
        basis: "MANAGEMENT_ESTIMATE",
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
    /**
     * Derived from the evidence unless a case sets it explicitly, because that
     * is what the server does: the flag is the ungated workflow condition and
     * the evidence is the gated detail, so on any caller who can see the
     * amounts the two arrive together.
     *
     * Setting the flag WITHOUT the evidence is the `view:finance`-less case and
     * is spelled out by the tests that need it, never reached by accident here.
     */
    settlementAdviceRequiresReconciliation:
      "settlementAdviceRequiresReconciliation" in overrides
        ? overrides.settlementAdviceRequiresReconciliation
        : overrides.settlementAdviceDiscrepancy != null,
  } as unknown as DealCockpitData;
}

function renderCockpit(deal: DealCockpitData | null | undefined = dealFixture()) {
  return render(<DealCockpitView deal={deal} onRecordSupplierReceipt={async () => {}} />);
}

/**
 * The statuses rendered INSIDE the Status Log card, in document order.
 *
 * Scoped deliberately. Both fixtures also render the deal's current status in
 * the HEADER BADGE, so a global `getAllByText("SaleStatusCompleted")` is
 * satisfied whether or not the timeline row exists — which let a row-dropping
 * renderer pass an earlier version of these tests. Reading the sequence from
 * within the card asserts what the operator actually reads as history.
 *
 * The card is located from its own heading (`CardTitle` → `CardHeader` → `Card`)
 * rather than by a test id, so the shared component needs no test-only markup.
 * Each entry renders its status as the first `<p>` of the row and its actor and
 * moment as the second.
 */
function statusLogStatuses(): string[] {
  const card = screen.getByText("StatusLogHeading").parentElement?.parentElement;
  if (!card) throw new Error("Status Log card not found — the heading moved.");
  return Array.from(card.querySelectorAll<HTMLElement>("p:first-of-type")).map(
    (p) => p.textContent?.trim() ?? ""
  );
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

/**
 * A corrupt stored moment loses ONE cell, never the screen.
 *
 * `z.number()` and `v.number()` both accept every finite double, and date-fns
 * `format` throws `RangeError: Invalid time value` on `NaN`, `±Infinity` and
 * any finite value outside the ±8.64e15 ms Date domain. The timeline was
 * already guarded; the header's "last updated" and the essentials' "opened on"
 * went straight to `format()` and would have taken the whole cockpit down.
 */
describe("a corrupt moment in the header or essentials never loses the screen", () => {
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["one past the Date domain", 8_640_000_000_000_001],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ])("createdAt = %s renders the deal with a calm dash where the date would be", (_label, moment) => {
    // `updatedAt` undefined so the header falls through to `createdAt`, and
    // the essentials cell reads `createdAt` directly — both guarded paths hit.
    renderCockpit(dealFixture({ createdAt: moment, updatedAt: undefined }));
    const header = screen.getByTestId("deal-header");
    expect(header.textContent).toContain("DealCockpitTitle");
    expect(header.textContent).toContain("LastUpdated: —");
    expect(screen.getByText("DealOwner").parentElement?.textContent).toContain("—");
    // The rest of the screen is intact, not a blank error boundary.
    expect(screen.getByText(/2,410/)).toBeTruthy();
  });

  test("a corrupt updatedAt alone is guarded too, without touching a valid createdAt", () => {
    renderCockpit(dealFixture({ updatedAt: Number.NaN }));
    expect(screen.getByTestId("deal-header").textContent).toContain("LastUpdated: —");
    expect(screen.getByText("DealOwner").parentElement?.textContent).toMatch(/Jul 2026/);
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
          profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        },
      })
    );
    expect(screen.getByText("ProfitNotCalculable")).toBeTruthy();
    expect(screen.getByText("ProfitNeedsApprovedPurchase")).toBeTruthy();
  });

  test("an ACTUAL_UNPOSTABLE loss is labelled actual everywhere on the same screen", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: {
            available: true,
            basis: "MANAGEMENT_ESTIMATE",
            amountMinor: -500 * SCALE,
            currency: "JOD",
            classification: "ACTUAL_UNPOSTABLE",
            postable: false,
            lines: [{ key: "APPROVED_PURCHASE", sign: 1, amountMinor: 9_000 * SCALE }],
          },
        },
      })
    );

    expect(screen.queryByText("LossEstimated")).toBeNull();
    expect(screen.getAllByText("LossActual")).toHaveLength(1);
    expect(screen.getByText("ProfitActualUnpostable")).toBeTruthy();
  });
});

/**
 * SCRUM-29's central risk, pinned on the rendered screen.
 *
 * One screen now shows two genuinely different kinds of money. A financed
 * deal's headline is a MANAGEMENT figure built on a spread that appears on no
 * invoice — it must always carry its qualifier and must never be posted. A cash
 * deal's is an ordinary accounting result that reconciles to the GL — stamping
 * "estimated, never posted" on it would be a false statement about a real
 * accounting figure, and it is the failure this whole polymorphic design exists
 * to prevent.
 *
 * These assert the qualifier's PRESENCE on one and its ABSENCE on the other, in
 * both directions, because a test that only checked the financed side would pass
 * happily against a screen that badged everything.
 */
function cashDealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return dealFixture({
    dealKind: "CASH",
    dealRef: "sale_7731",
    applicationId: null,
    saleId: "sale_7731",
    status: "COMPLETED",
    financeCompanyName: "",
    // The shorter rail: no credit decision, appraisal or gap stages at all.
    stages: [
      { key: "SALE_AGREED", state: "COMPLETE" },
      { key: "HANDOVER", state: "COMPLETE" },
      { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement" },
    ],
    documents: [],
    timeline: [
      { toStatus: "COMPLETED", changedAt: Date.UTC(2026, 7, 1), actorName: "ليث العمري" },
    ],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: true,
      routeKnown: true,
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000 * SCALE,
        currency: "JOD",
        reconcilesToLedger: true,
        // The shape `accountingProfit` actually emits for a SOURCED vehicle:
        // VEHICLE_COST is ALWAYS present and is a real zero on consignment,
        // with the supplier's entitlement beside it. An earlier fixture
        // carried the entitlement WITHOUT the cost line — a shape the server
        // never produces — and let a tile reading "vehicle cost: 0" pass.
        lines: [
          { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
          { key: "VEHICLE_COST", sign: -1, amountMinor: 0 },
          { key: "SUPPLIER_ENTITLEMENT", sign: -1, amountMinor: 17_000 * SCALE },
        ],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [
        {
          party: "SUPPLIER",
          name: "شركة عمّان للاستيراد",
          position: "OWED_TO_DEALERSHIP",
          amountMinor: 3_000 * SCALE,
          currency: "JOD",
          receivableId: "recv_1",
        },
      ],
      appraisalGapMinor: undefined,
    },
    ...overrides,
  });
}

describe("a cash headline and a financed headline cannot be confused", () => {
  test("the FINANCED headline always carries its unpostable qualifier", () => {
    renderCockpit();
    expect(screen.getByText("ProfitEstimatedAwaitingSettlement")).toBeTruthy();
    expect(screen.getByText("ManagementFigureNote")).toBeTruthy();
  });

  test("the CASH headline carries NO estimate badge and NO management-figure note", () => {
    renderCockpit(cashDealFixture());

    // The amount is still shown — this is not "the figure is withheld".
    // `getAllByText`: 3,000 is also the supplier's outstanding claim on this
    // fixture, and the point here is that the headline renders at all.
    expect(screen.getAllByText(/3,000/).length).toBeGreaterThan(0);

    // ...but nothing on the screen may describe it as an estimate or as a
    // number that is never posted. It is a real accounting result.
    expect(screen.queryByText("ProfitEstimatedAwaitingSettlement")).toBeNull();
    expect(screen.queryByText("ProfitActualUnpostable")).toBeNull();
    expect(screen.queryByText("ManagementFigureNote")).toBeNull();
  });

  test("a cash deal whose earnings were never recorded refuses rather than showing zero", () => {
    const { container } = renderCockpit(
      cashDealFixture({
        money: {
          ...cashDealFixture().money,
          profit: { available: false, reason: "UnknownMargin" },
        },
      })
    );
    expect(screen.getByText("ProfitNotCalculable")).toBeTruthy();
    expect(screen.getByText("ProfitUnknownMargin")).toBeTruthy();
    // The specific damage this prevents: a formatted amount standing in for
    // "nobody recorded what this deal earned". `.text-3xl` is the headline
    // figure's own class, so this asserts no headline NUMBER was rendered —
    // scoped deliberately, because a zero elsewhere on the screen (an expense
    // total that really is nil) is honest and must not fail this test.
    expect(container.querySelector(".text-3xl")).toBeNull();
  });
});

/**
 * The six-fact summary reads the SERVER's own facts and labels them for what
 * they are. Three ways it could lie, each pinned:
 *
 * 1. Selecting the lines by `dealKind`. An applicationless FINANCED/LEASE sale
 *    is `dealKind: "FINANCED"` (`sales.dealCockpit`) and its profit is an
 *    ACCOUNTING_RESULT built on `SALE_PRICE` — reading it as a management
 *    estimate found no `APPROVED_PURCHASE` line and reported the recorded sale
 *    price as "not recorded". The basis the server puts on the profit is the
 *    only thing that says which lines exist.
 * 2. Reporting "not recorded" for figures the server already serves. When the
 *    management profit is unavailable ONLY for want of the supplier settlement,
 *    the approved amount and the contribution are on the record and travel in
 *    `handoverEvidence`, already redacted and already denominated.
 * 3. Calling the approved purchase amount "deal value". The quote's vehicle
 *    price can differ from what the finance company approved; the tile has to
 *    say which one it is.
 */
describe("the six-fact summary reads server facts, never dealKind", () => {
  test("an applicationless FINANCED sale shows its recorded sale price under the sale-price label", () => {
    renderCockpit(
      cashDealFixture({
        // What `sales.dealCockpit` emits for `financingType: "FINANCED"` with
        // no application: FINANCED, still no applicationId, accounting basis.
        dealKind: "FINANCED",
        applicationId: null,
      })
    );
    // `getAllByText`: the same line labels also head the collapsed breakdown.
    expect(screen.getAllByText("LineSalePrice").length).toBeGreaterThan(0);
    expect(screen.getAllByText("LineSupplierEntitlement").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/20,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/17,000/).length).toBeGreaterThan(0);
    expect(screen.queryByText("NotRecorded")).toBeNull();
    expect(screen.queryByText("LineApprovedPurchase")).toBeNull();
  });

  /**
   * The summary TILES, as distinct from the collapsed breakdown. The same
   * label keys head both, so a global `getAllByText` cannot tell "the tile
   * says entitlement" from "the breakdown lists it" — which is exactly how a
   * tile reading "vehicle cost: 0" on every consignment stayed green.
   */
  function summaryTile(labelKey: string): string | null {
    const label = screen
      .queryAllByText(labelKey)
      .find((el) => el.tagName === "P" && el.closest("details") === null);
    return label?.parentElement?.textContent ?? null;
  }

  /**
   * The screen renders the lines the server named and classifies NOTHING from
   * their combination. An earlier build substituted the entitlement for a zero
   * cost and hid the entitlement beside a non-zero cost — deciding, on the
   * client, which figure "explains" the margin. Whether a zero VEHICLE_COST on
   * a SOURCED vehicle is meaningful is the server's economics, not this tile's.
   */
  test("the real SOURCED shape renders BOTH its zero vehicle cost AND its supplier entitlement", () => {
    // What `accountingProfit` emits for a SOURCED vehicle: SALE_PRICE 20,000,
    // VEHICLE_COST 0 AND SUPPLIER_ENTITLEMENT 17,000.
    renderCockpit(cashDealFixture());
    // The served SIGN travels with each figure: the inflow is unsigned, both
    // deductions carry the minus — a "17,000" tile with no sign would read
    // as money the dealership receives.
    expect(summaryTile("LineSalePrice")).toMatch(/LineSalePrice20,000 د\.أ/);
    expect(summaryTile("LineVehicleCost")).toMatch(/LineVehicleCost− 0 د\.أ/);
    expect(summaryTile("LineSupplierEntitlement")).toMatch(/LineSupplierEntitlement− 17,000 د\.أ/);
  });

  test("a DIRECT purchase whose recognized cost is zero keeps its zero — no entitlement, no substitution", () => {
    renderCockpit(
      cashDealFixture({
        money: {
          ...cashDealFixture().money,
          profit: {
            ...cashDealFixture().money!.profit,
            amountMinor: 20_000 * SCALE,
            lines: [
              { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
              { key: "VEHICLE_COST", sign: -1, amountMinor: 0 },
            ],
          },
        },
      })
    );
    expect(summaryTile("LineVehicleCost")).toMatch(/LineVehicleCost− 0 د\.أ/);
    expect(screen.queryByText("LineSupplierEntitlement")).toBeNull();
  });

  test("a non-zero vehicle cost served BESIDE an entitlement renders both, suppressing neither", () => {
    renderCockpit(
      cashDealFixture({
        money: {
          ...cashDealFixture().money,
          profit: {
            ...cashDealFixture().money!.profit,
            lines: [
              { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
              { key: "VEHICLE_COST", sign: -1, amountMinor: 16_000 * SCALE },
              { key: "SUPPLIER_ENTITLEMENT", sign: -1, amountMinor: 1_000 * SCALE },
            ],
          },
        },
      })
    );
    expect(summaryTile("LineVehicleCost")).toMatch(/− 16,000 د\.أ/);
    expect(summaryTile("LineSupplierEntitlement")).toMatch(/− 1,000 د\.أ/);
  });

  test("a financed estimate renders every line the server served, in the server's order", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: {
            ...dealFixture().money!.profit,
            lines: [
              { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
              { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500 * SCALE },
              { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
              { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
            ],
          },
        },
      })
    );
    const tiles = screen
      .getAllByText(/^Line/)
      .filter((el) => el.tagName === "P" && el.closest("details") === null)
      .map((el) => el.textContent);
    expect(tiles).toEqual([
      "LineApprovedPurchase",
      "LineSupplierSettlement",
      "LineDealerContribution",
      "LineActualExpenses",
    ]);
    expect(summaryTile("LineApprovedPurchase")).toMatch(/LineApprovedPurchase12,500 د\.أ/);
    expect(summaryTile("LineSupplierSettlement")).toMatch(/− 9,500 د\.أ/);
    // No tile stands in for a line the server did not send.
    expect(screen.queryByText("NotRecorded")).toBeNull();
  });

  /**
   * Every served line is visible in BOTH places — the tiles and the collapsed
   * working — zeros included and in server order. An earlier breakdown kept an
   * allowlist of keys and dropped a zero on any other line, so a zero
   * customer-direct amount, a zero contribution on a fully funded deal, and any
   * key the server adds later vanished from the working while still being in
   * the sum it explains.
   */
  test("zero-valued and unfamiliar lines stay visible in the tiles AND the breakdown, in server order", () => {
    const { container } = renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: {
            ...dealFixture().money!.profit,
            lines: [
              { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
              { key: "CUSTOMER_PLANNED_TO_DEALER", sign: 1, amountMinor: 0 },
              { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500 * SCALE },
              { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 0 },
              { key: "FUTURE_SERVER_LINE", sign: -1, amountMinor: 0 },
              { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
            ],
          },
        },
      })
    );
    const served = [
      "LineApprovedPurchase",
      "LineCustomerPlannedToDealer",
      "LineSupplierSettlement",
      "LineDealerContribution",
      "FUTURE_SERVER_LINE",
      "LineActualExpenses",
    ];
    // Tiles: one per line, server order, zeros spelled with their sign.
    const tiles = Array.from(container.querySelectorAll("p"))
      .filter((el) => served.includes(el.textContent ?? "") && el.closest("details") === null)
      .map((el) => el.textContent);
    expect(tiles).toEqual(served);
    expect(summaryTile("LineCustomerPlannedToDealer")).toMatch(/LineCustomerPlannedToDealer0 د\.أ/);
    expect(summaryTile("LineDealerContribution")).toMatch(/LineDealerContribution− 0 د\.أ/);
    expect(summaryTile("FUTURE_SERVER_LINE")).toMatch(/FUTURE_SERVER_LINE− 0 د\.أ/);
    // Breakdown: the same six terms, same order, nothing filtered.
    const breakdown = Array.from(container.querySelectorAll("details dt")).map((el) => el.textContent);
    expect(breakdown).toEqual(served);
    const breakdownValues = Array.from(container.querySelectorAll("details dd")).map((el) => el.textContent);
    expect(breakdownValues).toEqual([
      "12,500 د.أ",
      "0 د.أ",
      "− 9,500 د.أ",
      "− 0 د.أ",
      "− 0 د.أ",
      "− 90 د.أ",
    ]);
  });

  test("a management profit awaiting the supplier settlement still shows the served approved amount and contribution", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: { available: false, reason: "NoSupplierSettlement" },
        },
        handoverEvidence: {
          approvedPurchaseAmountMinor: 12_500 * SCALE,
          financeCompanyFundedPortionMinor: 11_500 * SCALE,
          dealerContributionMinor: 500 * SCALE,
          approvedAmountIsFarFromEvidence: false,
          currency: { code: "JOD", scale: 3 },
        },
      })
    );
    expect(screen.getByText("ProfitNotCalculable")).toBeTruthy();
    expect(screen.getByText("LineApprovedPurchase")).toBeTruthy();
    expect(screen.getByText(/12,500 د\.أ/)).toBeTruthy();
    expect(screen.getByText("LineDealerContribution")).toBeTruthy();
    expect(screen.getByText(/^500 د\.أ/)).toBeTruthy();
    expect(screen.queryByText("NotRecorded")).toBeNull();
  });

  test("a served figure is spelled at the SERVED scale, never the deal's", () => {
    // The evidence carries its own denomination. A two-decimal pin read at the
    // deal's three-decimal scale would print 1,250,000 as 1,250.
    language.locale = "en";
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: { available: false, reason: "NoSupplierSettlement" },
        },
        handoverEvidence: {
          approvedPurchaseAmountMinor: 1_250_000,
          financeCompanyFundedPortionMinor: null,
          dealerContributionMinor: null,
          approvedAmountIsFarFromEvidence: false,
          currency: { code: "USD", scale: 2 },
        },
      })
    );
    expect(screen.getByText(/12,500 USD/)).toBeTruthy();
    expect(screen.queryByText(/1,250 USD/)).toBeNull();
  });

  test("evidence the server withheld or cannot denominate is 'not recorded', never a guessed figure", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: { available: false, reason: "NoSupplierSettlement" },
        },
        handoverEvidence: {
          approvedPurchaseAmountMinor: 12_500 * SCALE,
          financeCompanyFundedPortionMinor: null,
          dealerContributionMinor: null,
          approvedAmountIsFarFromEvidence: false,
          currency: null,
        },
      })
    );
    expect(screen.queryByText(/12,500/)).toBeNull();
    expect(screen.getAllByText("NotRecorded").length).toBeGreaterThan(0);
  });

  test("the approved purchase amount is labelled as such, not as the deal value", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          profit: {
            ...dealFixture().money!.profit,
            lines: [
              { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
              { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
            ],
          },
        },
      })
    );
    // `getAllByText`: both lines also head the collapsed breakdown.
    expect(screen.getAllByText("LineApprovedPurchase").length).toBeGreaterThan(0);
    expect(screen.getAllByText("LineDealerContribution").length).toBeGreaterThan(0);
    expect(screen.queryByText("FactDealValue")).toBeNull();
  });

  test("the parties row carries a real heading", () => {
    renderCockpit();
    expect(screen.getByRole("heading", { name: "DealPartiesHeading" })).toBeTruthy();
  });

  test("an available accounting result with NO lines says the breakdown is unavailable, never 'not recorded'", () => {
    // The headline is real and served; only its working is absent. "Not
    // recorded" would claim the sale price was never entered.
    renderCockpit(
      cashDealFixture({
        money: {
          ...cashDealFixture().money,
          profit: { ...cashDealFixture().money!.profit, lines: [] },
        },
      })
    );
    expect(screen.getAllByText(/3,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ProfitBreakdownUnavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("NotRecorded")).toBeNull();
  });

  test.each([
    ["a cash sale", { dealKind: "CASH" }],
    ["an applicationless FINANCED sale", { dealKind: "FINANCED" }],
  ])("%s whose margin is unavailable asserts NO sale figures — and never approved-purchase ones", (_label, shape) => {
    // Server-identified by `applicationId: null` — the ONLY discriminator the
    // unavailable case may use, because an unavailable profit has no basis.
    renderCockpit(
      cashDealFixture({
        ...shape,
        applicationId: null,
        money: {
          ...cashDealFixture().money,
          profit: { available: false, reason: "UnknownMargin" },
        },
      })
    );
    expect(screen.queryByText("LineSalePrice")).toBeNull();
    expect(screen.queryByText("LineVehicleCost")).toBeNull();
    expect(screen.queryByText("LineApprovedPurchase")).toBeNull();
    expect(screen.queryByText("LineDealerContribution")).toBeNull();
    expect(screen.getByText("ProfitBreakdownUnavailable")).toBeTruthy();
  });

  /**
   * FINANCIAL. The sale read model serves a price and a cost ONLY inside an
   * available profit. When the server withholds the profit — a PENDING draft
   * that already has its sale price on the row, a legacy financed-direct row
   * it refuses to vouch for, an unreadable margin, a cancelled deal — the
   * screen used to paint "Sale price: Not recorded" and "Vehicle cost: Not
   * recorded". Both are false: the figures were not served, not absent. The
   * screen must state the profit is unavailable and why, and claim nothing
   * about the figures it was not given — no tile, no "not recorded", no zero.
   */
  describe("an unavailable sale profit is stated as unavailable, never as missing figures", () => {
    const REASONS = [
      "SaleNotCompleted",
      "FinancedDirectUnverified",
      "UnknownMargin",
      "DealCancelled",
    ] as const;

    /** Every MoneyFact tile's text, wherever it sits in the money card. */
    function moneyTiles(container: HTMLElement): string[] {
      return Array.from(container.querySelectorAll(".rounded-md.border.p-3")).map(
        (el) => el.textContent ?? ""
      );
    }

    test.each(REASONS)("%s: the reason is shown; no sale-price or cost tile, no 'not recorded', no figure", (reason) => {
      const { container } = renderCockpit(
        cashDealFixture({
          // A PENDING draft: its row carries the agreed price (20,000 on the
          // fixture's completed twin), but the server serves no profit for it
          // and therefore no price. The screen may not claim otherwise.
          status: reason === "SaleNotCompleted" ? "PENDING" : "COMPLETED",
          stages: [
            { key: "SALE_AGREED", state: "COMPLETE" },
            { key: "HANDOVER", state: "PENDING" },
            { key: "SETTLEMENT", state: "PENDING" },
          ],
          money: {
            ...cashDealFixture().money,
            profit: { available: false, reason },
            parties: [],
          },
        })
      );
      // The honest state, with the server's own reason.
      expect(screen.getByText("ProfitNotCalculable")).toBeTruthy();
      expect(screen.getByText(`Profit${reason}`)).toBeTruthy();
      expect(screen.getByText("ProfitBreakdownUnavailable")).toBeTruthy();
      // No claim about figures the server did not serve.
      expect(screen.queryByText("LineSalePrice")).toBeNull();
      expect(screen.queryByText("LineVehicleCost")).toBeNull();
      expect(screen.queryByText("LineSupplierEntitlement")).toBeNull();
      expect(screen.queryByText("NotRecorded")).toBeNull();
      expect(container.querySelector(".text-3xl")).toBeNull();
      // Not one money tile on the whole card — no value, no placeholder.
      expect(moneyTiles(container)).toEqual([]);
      // And no formatted amount anywhere in the financial summary, so a zero
      // or a stale 20,000 cannot leak in under another label.
      const card = screen.getByText("FinancialSummaryHeading").closest("[class*='rounded']")!;
      expect(card.textContent).not.toMatch(/\d[\d,]* د\.أ/);
    });

    test("a completed sale with a real 20,000 sale price still shows it once the server serves the profit", () => {
      // The control: same fixture, profit available. This is the ONLY route
      // by which a sale price reaches the screen, and it must still work.
      const { container } = renderCockpit(cashDealFixture());
      expect(summaryTile("LineSalePrice")).toMatch(/LineSalePrice20,000 د\.أ/);
      expect(screen.queryByText("ProfitBreakdownUnavailable")).toBeNull();
      // The tile selector the unavailable cases assert EMPTY does find tiles
      // when there are some: three line tiles and the supplier's party tile.
      expect(moneyTiles(container)).toHaveLength(4);
    });
  });

  test("an applicationless FINANCED sale is titled as a sale, not as a finance application", () => {
    renderCockpit(cashDealFixture({ dealKind: "FINANCED", applicationId: null }));
    expect(screen.getByText(/DealCockpitTitleCash/)).toBeTruthy();
    expect(screen.queryByText(/DealCockpitTitle$/)).toBeNull();
  });
});

describe("the cash rail is shorter, not greyed out", () => {
  test("the finance-only stages are ABSENT from a cash deal, not rendered inactive", () => {
    renderCockpit(cashDealFixture());
    // Not merely "not COMPLETE" — not present at all. A permanently-grey stage
    // teaches operators that grey means ignore, and this rail has to carry a
    // real blocker.
    expect(screen.queryByText("StageCreditDecision")).toBeNull();
    expect(screen.queryByText("StageAppraisal")).toBeNull();
    expect(screen.queryByText("StageGapResolution")).toBeNull();
    expect(screen.queryByText("StageApprovedPurchase")).toBeNull();
    // The stages it does have are there. `getAllByText` because the live stage
    // is named twice by design — once on the rail, once in the next-step card.
    expect(screen.getAllByText("StageSettlement").length).toBeGreaterThan(0);
  });

  test("a cash deal renders no document checklist at all rather than an empty one", () => {
    renderCockpit(cashDealFixture());
    // The rules are per finance company and their per-deal status lives on the
    // application, so a cash deal has nothing to show and no way to acquire it.
    // An empty card would invite a hunt for an upload control that does not exist.
    expect(screen.queryByText("DocumentsHeading")).toBeNull();
  });

  test("a cash deal shows no finance-company line in the header", () => {
    renderCockpit(cashDealFixture());
    expect(screen.queryByText(/شركة التمويل الوطني/)).toBeNull();
  });

  /**
   * Found by RENDERING the screen, not by reading it. The header used the one
   * title `DealCockpitTitle` — "Finance application" / `طلب تمويل` — so a cash
   * deal was headed by the name of a record it does not have. Invisible to
   * every test that existed, and plain the moment the page was looked at.
   */
  test("a cash deal is not titled 'finance application'", () => {
    renderCockpit(cashDealFixture());
    expect(screen.queryByText(/DealCockpitTitle$/)).toBeNull();
    expect(screen.getByText(/DealCockpitTitleCash/)).toBeTruthy();
  });

  test("a financed deal keeps the finance-application title", () => {
    renderCockpit();
    expect(screen.getByText(/DealCockpitTitle$/)).toBeTruthy();
  });

  /**
   * An OWNED cash sale has no third party at all — no supplier, no financier —
   * so the parties card would render a heading over nothing. Both existing
   * fixtures are consigned, which is why nothing caught this.
   */
  test("an owned cash deal renders no empty 'deal parties' card", () => {
    renderCockpit(
      cashDealFixture({
        money: { ...cashDealFixture().money, parties: [] },
      })
    );
    expect(screen.queryByText("DealPartiesHeading")).toBeNull();
  });

  test("a consigned cash deal still shows the parties card", () => {
    renderCockpit(cashDealFixture());
    expect(screen.getByText("DealPartiesHeading")).toBeTruthy();
  });

  test("a cash deal with no fee records renders no expenses card", () => {
    // A cash sale's costs are already capitalized into the vehicle cost and so
    // already inside the margin above. A card reading "expenses: 0" invites the
    // owner to subtract them a second time.
    renderCockpit(cashDealFixture());
    expect(screen.queryByText("ActualExpensesHeading")).toBeNull();
  });

  /**
   * The absent-not-empty rule is for CASH. Applying it on emptiness alone
   * silently changed the SHIPPED financed screen — on `origin/main` this card is
   * unconditional, so a financed deal awaiting its actuals showed "none recorded
   * yet", and gating it on `lines.length` removed that from production inside a
   * PR whose frozen scope explicitly excludes touching it.
   *
   * Missed by both adversarial reviewers and by me; caught by CodeRabbit.
   */
  test("a financed deal keeps its expenses card even with nothing recorded", () => {
    renderCockpit(
      dealFixture({
        money: {
          ...dealFixture().money,
          expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
        },
      })
    );
    expect(screen.getAllByText("ActualExpensesHeading").length).toBeGreaterThan(0);
    expect(screen.getByText("NoExpensesRecorded")).toBeTruthy();
  });

  /**
   * The server may emit a transition whose moment is unknown — `changedAt` is
   * optional precisely so a status is never withheld for want of a timestamp.
   *
   * The view must render that entry rather than throw. date-fns `format` raises
   * `RangeError: Invalid time value` on a non-finite input, and an uncaught
   * throw during render loses the WHOLE screen, not one row.
   */
  test("a transition with no recorded moment still renders its status", () => {
    renderCockpit(
      cashDealFixture({
        timeline: [
          { toStatus: "PENDING", changedAt: Date.UTC(2026, 6, 28), actorName: "ليث العمري" },
          { toStatus: "COMPLETED", actorName: "ليث العمري" },
        ],
      })
    );
    /**
     * Scoped to the Status Log, and asserting the SEQUENCE rather than mere
     * presence. A global `getAllByText("SaleStatusCompleted")` is satisfied by
     * the HEADER BADGE alone, so it passes even when the dateless row is
     * dropped — the precise regression this test exists to catch. Proven: with
     * the renderer mutated to filter out dateless rows, the earlier version of
     * this file passed 39/39.
     */
    expect(statusLogStatuses()).toEqual(["SaleStatusPending", "SaleStatusCompleted"]);
    // The missing moment leaves no orphaned separator behind it.
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  /**
   * The same rule for a moment that is present but unreadable.
   *
   * This renderer is SHARED, and the FINANCED timeline feeds it
   * `applicationStatusLog.changedAt` directly — declared `v.number()`, which
   * accepts NaN and Infinity. A guard of `changedAt !== undefined` passes both
   * straight into date-fns `format`, which throws `RangeError` and takes the
   * whole cockpit down. Guarding only the cash path would have left the screen
   * this component was originally built for still able to crash.
   */
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    /**
     * FINITE IS NOT RENDERABLE. `Number.isFinite` passes all three of these and
     * date-fns `format` throws `RangeError` on every one, because JavaScript's
     * `Date` domain stops at ±8,640,000,000,000,000 ms. `z.number()` accepts
     * them and `v.number()` stores them verbatim, so the corrupt row is
     * reachable through the ordinary public write path — not hypothetical.
     */
    ["one millisecond past the Date domain", 8640000000000001],
    ["1e300", 1e300],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
    ["a negative epoch past the domain", -8640000000000001],
  ])("a %s moment renders the status instead of crashing the cockpit", (_label, bad) => {
    renderCockpit(
      dealFixture({
        timeline: [{ toStatus: "APPROVED", changedAt: bad, actorName: "ليث العمري" }],
      })
    );
    /**
     * Scoped to the Status Log: the header badge also renders "Approved", so a
     * global query passes even if the row is dropped entirely. Exactly one row
     * was fed in, so exactly one must survive.
     */
    expect(statusLogStatuses()).toEqual(["Approved"]);
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  test("a cash deal renders no appraisal-gap line", () => {
    // The gap is the finance company's valuation against the price. A cash deal
    // has no appraisal, so the line has no meaning rather than a value of zero.
    renderCockpit(cashDealFixture());
    expect(screen.queryByText("AppraisalGapLabel")).toBeNull();
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

/**
 * SCRUM-30 — the exceptional state has to be visible and recoverable.
 *
 * The backend records a settlement advice that contradicts the approved amount
 * and flags the deal REQUIRES_RECONCILIATION rather than refusing the evidence.
 * That was only half a recovery path: the cockpit query returned
 * `settlementAdviceDiscrepancy` and the screen rendered nothing at all for it,
 * and the amendment mutation had no caller anywhere in the app. A dealer could
 * reach a state the system knew about, could not see, and could not leave.
 *
 * These render the screen rather than reading it, for the same reason the tests
 * above do: visibility is not a property of the query's return type.
 */
const DISCREPANCY = {
  recordedMinor: 17_995 * SCALE,
  approvedMinor: 18_000 * SCALE,
  currency: "JOD",
};

describe("a settlement advice that contradicts the approval", () => {
  test("is stated on the screen, with both figures and the difference", () => {
    renderCockpit(dealFixture({ settlementAdviceDiscrepancy: DISCREPANCY }));

    expect(screen.getByText("SettlementAdviceDiscrepancyTitle")).toBeTruthy();
    // Both records, because naming only one of them does not describe a
    // disagreement — and the difference, which is the number the operator
    // actually chases.
    expect(screen.getByText(/17,995/)).toBeTruthy();
    expect(screen.getByText(/18,000/)).toBeTruthy();
    expect(screen.getByText("SettlementAdviceDifference")).toBeTruthy();
  });

  test("is announced to assistive technology, not merely coloured red", () => {
    renderCockpit(dealFixture({ settlementAdviceDiscrepancy: DISCREPANCY }));
    const alerts = screen.getAllByRole("alert");
    expect(
      alerts.some((el) => el.textContent?.includes("SettlementAdviceDiscrepancyTitle"))
    ).toBe(true);
  });

  test("shows nothing at all on a deal whose advice agrees", () => {
    renderCockpit(dealFixture({ settlementAdviceDiscrepancy: null }));
    expect(screen.queryByText("SettlementAdviceDiscrepancyTitle")).toBeNull();
    expect(screen.queryByText("CorrectSettlementAdvice")).toBeNull();
  });

  test("the WARNING reaches a caller who cannot see the deal's money", () => {
    // A deal is stuck and the screen says so to whoever can open it. A warning
    // only the accountant can see is not a warning.
    //
    // This is the shape the server actually sends such a caller: the flag, and
    // no evidence. An earlier fixture handed the amounts to a `money: null`
    // caller to make this same point, which pinned a response `dealCockpit`
    // cannot produce — the amounts and `money` are withheld by one permission.
    renderCockpit(
      dealFixture({
        money: null,
        settlementAdviceDiscrepancy: null,
        settlementAdviceRequiresReconciliation: true,
      })
    );
    expect(screen.getByText("MoneyPanelHidden")).toBeTruthy();
    expect(screen.getByText("SettlementAdviceDiscrepancyTitle")).toBeTruthy();
    expect(screen.getByText("SettlementAdviceDiscrepancyBody")).toBeTruthy();
  });

  test("but the figures behind it do not, and neither does the correction", () => {
    // `approvedMinor` is one subtraction from the dealership's margin, and the
    // cheque number and payment date are the same class of record. The button
    // goes with them: correcting a figure you were never shown is a guess, and
    // `manage:finance` is an independent permission that a customized role can
    // hold without `view:finance`.
    render(
      <DealCockpitView
        deal={dealFixture({
          money: null,
          settlementAdviceDiscrepancy: null,
          settlementAdviceRequiresReconciliation: true,
        })}
        canCorrectAdvice
        onCorrectSettlementAdvice={async () => {}}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.queryByText(/17,995/)).toBeNull();
    expect(screen.queryByText(/18,000/)).toBeNull();
    expect(screen.queryByText("SettlementAdviceDifference")).toBeNull();
    expect(screen.queryByRole("button", { name: "CorrectSettlementAdvice" })).toBeNull();
  });

  test("scales by the currency the discrepancy was pinned to, not the org's", () => {
    // A deal pinned to a two-decimal currency. Reading 1,799,500 at the mocked
    // three-decimal scale renders 1,799.5 — the same class of defect the
    // approved-amount display already had, on the figures whose entire purpose
    // is to be compared against a document.
    language.locale = "en";
    renderCockpit(
      dealFixture({
        settlementAdviceDiscrepancy: {
          recordedMinor: 1_799_500,
          approvedMinor: 1_800_000,
          currency: "USD",
        },
      })
    );
    expect(screen.getByText(/17,995 USD/)).toBeTruthy();
    expect(screen.queryByText(/1,799\.5 USD/)).toBeNull();
  });

  test("says the figure is unknown rather than showing a zero", () => {
    renderCockpit(
      dealFixture({
        settlementAdviceDiscrepancy: {
          recordedMinor: null,
          approvedMinor: 18_000 * SCALE,
          currency: "JOD",
        },
      })
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
    // And no difference is claimed against an unknown: a difference computed
    // from a missing figure is not a smaller difference, it is not a difference.
    expect(screen.queryByText("SettlementAdviceDifference")).toBeNull();
  });
});

describe("correcting the advice", () => {
  function renderWithCorrection(onCorrect: (c: unknown) => Promise<void>) {
    return render(
      <DealCockpitView
        deal={dealFixture({ settlementAdviceDiscrepancy: DISCREPANCY })}
        canCorrectAdvice
        onCorrectSettlementAdvice={onCorrect as never}
        onRecordSupplierReceipt={async () => {}}
      />
    );
  }

  test("is offered to a caller who may amend it, and opens the dialog", async () => {
    renderWithCorrection(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "CorrectSettlementAdvice" }));

    expect(await screen.findByLabelText("SettlementAdviceAmountLabel")).toBeTruthy();
    // The other record is restated inside the dialog: the operator is about to
    // change one of the two and needs the other in front of them while they do.
    expect(screen.getAllByText(/18,000/).length).toBeGreaterThan(0);
  });

  test("is not offered to a caller who may not", () => {
    // The server refuses them anyway; offering the action would send them to a
    // form whose only possible outcome is a permission error.
    renderCockpit(dealFixture({ settlementAdviceDiscrepancy: DISCREPANCY }));
    expect(screen.getByText("SettlementAdviceDiscrepancyTitle")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "CorrectSettlementAdvice" })).toBeNull();
  });

  test("refuses to submit until a reason is given", async () => {
    renderWithCorrection(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "CorrectSettlementAdvice" }));
    await screen.findByLabelText("SettlementAdviceAmountLabel");

    // The server enforces this too, but making the operator submit to discover
    // it means typing the reason twice.
    expect((screen.getByRole("button", { name: "SaveCorrection" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.change(screen.getByLabelText("SettlementAdviceReasonLabel"), {
      target: { value: "Advice re-read: the amount was transposed on entry." },
    });
    expect((screen.getByRole("button", { name: "SaveCorrection" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  test("sends the corrected advice, prefilled from what is recorded", async () => {
    const onCorrect = vi.fn(async (_correction: unknown) => {});
    renderWithCorrection(onCorrect);
    fireEvent.click(screen.getByRole("button", { name: "CorrectSettlementAdvice" }));

    const amount = (await screen.findByLabelText(
      "SettlementAdviceAmountLabel"
    )) as HTMLInputElement;
    // Prefilled with the RECORDED figure — the operator is correcting it, and
    // retyping the whole number invites a second transcription error on the
    // first. In major units at the discrepancy's own scale.
    expect(amount.value).toBe("17995");

    fireEvent.change(amount, { target: { value: "18000" } });
    fireEvent.change(screen.getByLabelText("SettlementAdviceReasonLabel"), {
      target: { value: "Advice re-read: the amount was transposed on entry." },
    });
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    expect(onCorrect).toHaveBeenCalledTimes(1);
    const sent = onCorrect.mock.calls[0][0] as unknown as {
      amountMajor: number;
      reason: string;
    };
    expect(sent.amountMajor).toBe(18_000);
    expect(sent.reason).toBe("Advice re-read: the amount was transposed on entry.");
  });
});

/**
 * SCRUM-30 — the correction form must not submit blanks over what it was not
 * asked to change.
 *
 * Every field in this dialog is sent on every save, so an empty reference and
 * today's date were not "unchanged" — they were an instruction to erase the
 * cheque number and restate when the supplier was paid, issued by an operator
 * who only touched the amount. The server now preserves what it is not given,
 * and these pin the other half: the form opens showing what is on file.
 */
describe("the correction form and the evidence it was not asked to change", () => {
  const ADVISED = {
    recordedMinor: 17_995 * SCALE,
    approvedMinor: 18_000 * SCALE,
    currency: "JOD",
    recordedReference: "WIRE-4471",
    /**
     * Deliberately NOT midnight.
     *
     * `confirmSupplierDisbursement` stamps `Date.now()`, so a real recorded
     * advice carries a time of day and milliseconds. Every fixture here used to
     * be `Date.UTC(2026, 7, 5)` — already midnight — which made the form's
     * round trip through a date-only `<input type="date">` lossless by
     * construction and hid the fact that it truncates.
     */
    recordedAt: Date.UTC(2026, 7, 5, 14, 32, 17, 456),
  };

  function openCorrection(onCorrect: (c: unknown) => Promise<void>) {
    render(
      <DealCockpitView
        deal={dealFixture({ settlementAdviceDiscrepancy: ADVISED })}
        canCorrectAdvice
        onCorrectSettlementAdvice={onCorrect as never}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "CorrectSettlementAdvice" }));
  }

  test("opens showing the recorded reference and the recorded date", async () => {
    openCorrection(async () => {});

    const reference = (await screen.findByLabelText(
      "SettlementAdviceReferenceLabel"
    )) as HTMLInputElement;
    const date = screen.getByLabelText("SettlementAdviceDateLabel") as HTMLInputElement;

    expect(reference.value).toBe("WIRE-4471");
    expect(date.value).toBe("2026-08-05");
  });

  test("an amount-only correction resends them unchanged", async () => {
    const onCorrect = vi.fn(async (_correction: unknown) => {});
    openCorrection(onCorrect);

    const amount = (await screen.findByLabelText(
      "SettlementAdviceAmountLabel"
    )) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "18000" } });
    fireEvent.change(screen.getByLabelText("SettlementAdviceReasonLabel"), {
      target: { value: "Advice re-read: the amount was transposed on entry." },
    });
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    const sent = onCorrect.mock.calls[0][0] as unknown as {
      amountMajor: number;
      reference?: string;
      disbursedAt?: number;
    };
    expect(sent.amountMajor).toBe(18_000);
    // Not "" and not today. The operator changed one field; the cheque number
    // has to arrive exactly as it was on file.
    expect(sent.reference).toBe("WIRE-4471");
    // And the date is not resent AT ALL.
    //
    // Resending it looked like preservation and was not. The field is an
    // `<input type="date">`: the recorded instant goes in through
    // `msToDateInput`, which keeps the UTC calendar date and discards the time,
    // and comes back out through `dateInputToUtcMs`, which is documented to
    // produce UTC midnight. So an advice stamped 14:32:17.456 was rewritten to
    // 00:00:00.000 by an operator who only retyped the amount — and for anyone
    // west of UTC the displayed day moved with it.
    //
    // There is no way to preserve an instant through a date-only control, so
    // the form does not try: an untouched date sends nothing and the server
    // keeps what it already has. `undefined` here IS the preservation.
    expect(sent.disbursedAt).toBeUndefined();
  });

  test("the reference and the date can still be deliberately corrected", async () => {
    // The control. Preserving what was not touched must not become refusing to
    // change what was — the operator who mistyped the cheque number needs this
    // path as much as the one who mistyped the amount.
    const onCorrect = vi.fn(async (_correction: unknown) => {});
    openCorrection(onCorrect);

    await screen.findByLabelText("SettlementAdviceAmountLabel");
    fireEvent.change(screen.getByLabelText("SettlementAdviceReferenceLabel"), {
      target: { value: "WIRE-4472" },
    });
    fireEvent.change(screen.getByLabelText("SettlementAdviceDateLabel"), {
      target: { value: "2026-08-06" },
    });
    fireEvent.change(screen.getByLabelText("SettlementAdviceReasonLabel"), {
      target: { value: "Advice re-read: wrong cheque number and date were entered." },
    });
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    const sent = onCorrect.mock.calls[0][0] as unknown as {
      reference?: string;
      disbursedAt?: number;
    };
    expect(sent.reference).toBe("WIRE-4472");
    expect(sent.disbursedAt).toBe(Date.UTC(2026, 7, 6));
  });

  test("falls back to today only when nothing is recorded", async () => {
    const onCorrect = vi.fn(async (_correction: unknown) => {});
    render(
      <DealCockpitView
        deal={dealFixture({
          settlementAdviceDiscrepancy: {
            ...ADVISED,
            recordedReference: null,
            recordedAt: null,
          },
        })}
        canCorrectAdvice
        onCorrectSettlementAdvice={onCorrect as never}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "CorrectSettlementAdvice" }));

    const reference = (await screen.findByLabelText(
      "SettlementAdviceReferenceLabel"
    )) as HTMLInputElement;
    expect(reference.value).toBe("");
    // A date is still required by the input, and today is the only defensible
    // guess when the record carries none.
    expect((screen.getByLabelText("SettlementAdviceDateLabel") as HTMLInputElement).value).not.toBe(
      ""
    );
  });
});


/**
 * Whose move the rail says it is — and the one stage where the rail's own
 * authority field is not allowed to answer that question.
 *
 * `APPRAISAL` carries authority MIRROR because the dealership never values the
 * vehicle itself. Reading MIRROR as "the finance company" is right for every
 * other mirrored stage and WRONG here: the valuation may have been done by an
 * independent appraiser, and telling the operator the deal waits on the finance
 * company sends them chasing a party that was never involved.
 *
 * These assert against RECORDED SERVER PROVENANCE only. `t` is the identity
 * function in this file, so an unresolved key appears as itself and a wrongly
 * named party is stated out loud rather than silently mistranslated.
 */
describe("the rail names the party that actually owns each step", () => {
  function appraisalAt(provider: "FINANCE_COMPANY" | "INDEPENDENT" | null) {
    return render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "APPRAISAL", state: "CURRENT", authority: "MIRROR" }],
        })}
        activeAppraisalProvider={provider}
        onRecordSupplierReceipt={async () => {}}
      />
    );
  }

  test("an INDEPENDENT appraisal is never presented as the finance company's", () => {
    appraisalAt("INDEPENDENT");

    expect(screen.getAllByText("AppraisalByIndependent").length).toBeGreaterThan(0);
    // The precise defect: MIRROR must not be rendered as "finance company" here.
    expect(screen.queryByText("StageOwnerFinanceCompany")).toBeNull();
    expect(screen.queryByText("AppraisalByFinanceCompany")).toBeNull();
  });

  test("a FINANCE_COMPANY appraisal names the finance company", () => {
    appraisalAt("FINANCE_COMPANY");

    expect(screen.getAllByText("AppraisalByFinanceCompany").length).toBeGreaterThan(0);
    expect(screen.queryByText("AppraisalByIndependent")).toBeNull();
  });

  test("an unrecorded appraiser names NEITHER party", () => {
    appraisalAt(null);

    expect(screen.getAllByText("StageOwnerAppraiserNotRecorded").length).toBeGreaterThan(0);
    // Covers "no appraisal recorded yet" AND a DEALER_ESTIMATE, neither of
    // which this badge may represent as one of the two nameable parties.
    expect(screen.queryByText("AppraisalByIndependent")).toBeNull();
    expect(screen.queryByText("AppraisalByFinanceCompany")).toBeNull();
    expect(screen.queryByText("StageOwnerFinanceCompany")).toBeNull();
  });

  test("a mirrored stage that is NOT the appraisal still reads as the finance company", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "CREDIT_DECISION", state: "CURRENT", authority: "MIRROR" }],
        })}
        activeAppraisalProvider={null}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getAllByText("StageOwnerFinanceCompany").length).toBeGreaterThan(0);
    // …and says why no button is offered, in the focus row the operator acts from.
    expect(screen.getAllByText("StageMirrorNote").length).toBeGreaterThan(0);
  });

  test("a dealership stage reads as the dealership and carries no mirror note", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "HANDOVER", state: "CURRENT", authority: "DEALER" }],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getAllByText("StageOwnerDealership").length).toBeGreaterThan(0);
    expect(screen.queryByText("StageMirrorNote")).toBeNull();
  });

  test("an authority the client does not recognise names nobody", () => {
    // Fails CLOSED. A future server authority must render no owner at all
    // rather than defaulting into "Dealership", which would be a confident lie.
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "HANDOVER", state: "CURRENT", authority: "SOMETHING_NEW" }],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.queryByText("StageOwnerDealership")).toBeNull();
    expect(screen.queryByText("StageOwnerFinanceCompany")).toBeNull();
  });

  test("the disbursement stage is named, not printed as its raw key", () => {
    // The whole reason the previous release shipped a transitional dictionary
    // entry. This build maps the stage, so "DISBURSEMENT" must never be read
    // by an operator.
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            {
              key: "DISBURSEMENT",
              state: "BLOCKED",
              blocker: "AwaitingDisbursement",
              authority: "MIRROR",
            },
          ],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getAllByText("StageDisbursement").length).toBeGreaterThan(0);
    expect(screen.queryByText("DISBURSEMENT")).toBeNull();
    expect(screen.getAllByText("BlockerAwaitingDisbursement").length).toBeGreaterThan(0);
  });
});

/**
 * Customer money still held on a deal that is over.
 *
 * The applications LIST has always surfaced this as `DEPOSIT_PENDING`. The deal
 * screen said nothing, so the same deal read as a plain "Rejected" here while
 * the list said cash was outstanding. Presentational only: this asserts that
 * the screen SAYS it, never what anyone may do about it.
 */
describe("a stopped deal still holding the customer's deposit says so", () => {
  test("the deal screen surfaces an unresolved held deposit", () => {
    render(
      <DealCockpitView
        deal={dealFixture({ status: "REJECTED" })}
        depositAwaitingResolution
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getByTestId("deal-deposit-awaiting-resolution")).toBeTruthy();
    expect(screen.getAllByText("DepositAwaitingResolutionTitle").length).toBeGreaterThan(0);
  });

  test("nothing is claimed when no deposit is outstanding", () => {
    // The negative half. Without it the assertion above passes just as well
    // against a strip that is rendered unconditionally.
    render(
      <DealCockpitView
        deal={dealFixture({ status: "REJECTED" })}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.queryByTestId("deal-deposit-awaiting-resolution")).toBeNull();
    expect(screen.queryByText("DepositAwaitingResolutionTitle")).toBeNull();
  });
});

/**
 * One workflow state, one owner — across EVERY surface that names one.
 *
 * The rail badge and the next-step note both answer "whose move is this?", and
 * they answered it from different sources: the badge from RECORDED SERVER
 * PROVENANCE (`activeAppraisalProvider`), the note from the stage's static
 * `authority`. `APPRAISAL` carries `authority: "MIRROR"`, so a deal appraised
 * by an INDEPENDENT appraiser rendered "An independent appraiser" in the rail
 * and "This step is the finance company's" directly beneath it — the same
 * screen naming two different parties for one step.
 *
 * That is worse than the original defect this issue fixed, because the screen
 * now contradicts ITSELF rather than merely being wrong once.
 *
 * This was VISIBLE in the Gate B render and reported as clean. Rendering
 * produced the evidence; reading it missed the contradiction. So the property
 * is asserted mechanically here rather than left to a human reading a
 * screenshot: no surface may name a party the provenance does not support.
 */
describe("two surfaces describing one step must not name different parties", () => {
  function appraisalScreen(provider: "FINANCE_COMPANY" | "INDEPENDENT" | null) {
    return render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "APPRAISAL", state: "CURRENT", authority: "MIRROR" }],
        })}
        activeAppraisalProvider={provider}
        onRecordSupplierReceipt={async () => {}}
      />
    );
  }

  test("an INDEPENDENT appraisal is not called the finance company's by the note", () => {
    appraisalScreen("INDEPENDENT");

    // The badge is right — and was already right before this fix.
    expect(screen.getAllByText("AppraisalByIndependent").length).toBeGreaterThan(0);
    // The note was the surface still asserting the other party.
    expect(screen.queryByText("StageMirrorNote")).toBeNull();
  });

  test("an unrecorded appraiser is not called the finance company's by the note", () => {
    appraisalScreen(null);

    expect(screen.getAllByText("StageOwnerAppraiserNotRecorded").length).toBeGreaterThan(0);
    // `null` means "not on record, or a dealer estimate". Neither of those
    // licenses the note to name the finance company.
    expect(screen.queryByText("StageMirrorNote")).toBeNull();
  });

  test("a FINANCE_COMPANY appraisal DOES carry the note, because there it is true", () => {
    // The positive control. Without it the two assertions above pass equally
    // well against a note that was simply deleted, which would remove the
    // operator's only explanation for why the step has no button.
    appraisalScreen("FINANCE_COMPANY");

    expect(screen.getAllByText("AppraisalByFinanceCompany").length).toBeGreaterThan(0);
    expect(screen.getAllByText("StageMirrorNote").length).toBeGreaterThan(0);
  });

  test("a non-appraisal mirrored step is untouched by the provenance gate", () => {
    // The fix must narrow the note for APPRAISAL only. A stage whose owner
    // genuinely IS the finance company keeps both surfaces agreeing on it,
    // even when no appraisal provider is on record.
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "CREDIT_DECISION", state: "CURRENT", authority: "MIRROR" }],
        })}
        activeAppraisalProvider={null}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getAllByText("StageOwnerFinanceCompany").length).toBeGreaterThan(0);
    expect(screen.getAllByText("StageMirrorNote").length).toBeGreaterThan(0);
  });
});

/**
 * The live stage has ONE working surface on the screen.
 *
 * The rail used to name the current stage and a separate "next step" card
 * beneath it named the same stage again and held its button — two
 * representations of one fact, free to disagree. The compact rail now marks
 * the live node (`aria-current="step"`) as a progress readout only, and the
 * focus panel directly beneath it is the one block that carries the action;
 * both are rendered from the same `live` stage. The name therefore appears
 * exactly twice — rail node and panel heading — and the action exactly once,
 * on the block that keeps the `deal-next-step` id the specs anchor to.
 */
describe("the current stage has exactly one working surface, beneath the rail", () => {
  test("the rail marks the live stage, the panel names it, and the action lives on the panel", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
            { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
            { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
          ],
        })}
        workflowAction={{ stageKey: "HANDOVER", actionKey: "RegisterHandoverAction", onStart: () => {} }}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    // Rail node + panel heading, and nothing else names the stage.
    expect(screen.getAllByText("StageHandover")).toHaveLength(2);
    expect(screen.queryByText("NextStepHeading")).toBeNull();
    // The rail marks exactly the stage the panel is working.
    const rail = screen.getByTestId("deal-stage-rail");
    const current = rail.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("StageHandover");
    const focus = screen.getByTestId("deal-next-step");
    expect(focus.textContent).toContain("StageHandover");
    expect(focus.textContent).toContain("RegisterHandoverAction");
    // The rail is a readout: no button lives on it.
    expect(rail.querySelector("button")).toBeNull();
    // Exactly one recommended CTA on the whole screen.
    expect(screen.getAllByRole("button", { name: "RegisterHandoverAction" })).toHaveLength(1);
  });

  test("a finished deal shows one calm completion state, with the rail one click away", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          status: "CLOSED",
          stages: [
            { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
            { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
            { key: "SETTLEMENT", state: "COMPLETE", authority: "DEALER" },
          ],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );

    expect(screen.getByText("DealAllStagesComplete")).toBeTruthy();
    // No stage is being worked, so no working surface and no stopped notice.
    expect(screen.queryByTestId("deal-next-step")).toBeNull();
    expect(screen.queryByText("DealStopped")).toBeNull();
    // The rail is not painted by default; the operator can still ask for it.
    expect(screen.queryByTestId("deal-stage-rail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ShowStages" }));
    expect(screen.getByTestId("deal-stage-rail")).toBeTruthy();
    expect(screen.getByText("StageSettlement")).toBeTruthy();
  });

  test("every rail node states its state and its owner to assistive technology, not only by colour", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
            { key: "CREDIT_DECISION", state: "BLOCKED", blocker: "AwaitingCreditDecision", authority: "MIRROR" },
            { key: "HANDOVER", state: "PENDING", authority: "DEALER" },
            { key: "SETTLEMENT", state: "STOPPED", authority: "DEALER" },
          ],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    // The ACCESSIBLE NAME of each node carries label, state, owner and
    // blocker — asserted through the role, not by scraping text content.
    const items = within(screen.getByTestId("deal-stage-rail")).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(
      within(screen.getByTestId("deal-stage-rail")).getByRole("listitem", {
        name: /StageApplication.*StageStateComplete.*StageOwnerDealership/,
      })
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("deal-stage-rail")).getByRole("listitem", {
        name: /StageCreditDecision.*StageStateBlocked.*StageOwnerFinanceCompany.*BlockerAwaitingCreditDecision/,
      })
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("deal-stage-rail")).getByRole("listitem", {
        name: /StageHandover.*StageStatePending.*StageOwnerDealership/,
      })
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("deal-stage-rail")).getByRole("listitem", {
        name: /StageSettlement.*StageStateStopped/,
      })
    ).toBeTruthy();
    // Ownership of the non-live nodes is also VISIBLE, as muted text under
    // the label, for mouse, keyboard and touch users alike. Queried by the
    // text the operator reads and asserted visible — not scraped from
    // `span:not(.sr-only)`, which passed for text in any element that merely
    // lacked that one class.
    expect(within(items[0]).getByText("StageOwnerDealership")).toBeVisible();
    expect(within(items[2]).getByText("StageOwnerDealership")).toBeVisible();
  });

  test("in Arabic, inside an RTL container, the header and rail render the same identity, status and live stage", () => {
    language.locale = "ar";
    // Rendered inside a `dir="rtl"` wrapper so the bidi context matches what
    // the Arabic operator gets. What this CAN assert is content and the
    // direction attribute; what it CANNOT is paint — jsdom applies no
    // stylesheet, so `.dark` tokens, logical-property mirroring and layout
    // are unobservable here. Those are asserted in a real engine by
    // `playwright/visual/deal-cockpit.visual.spec.ts`.
    render(
      <div dir="rtl">
        <DealCockpitView
          deal={dealFixture({
            stages: [
              { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
              { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
            ],
          })}
          backHref="/org_1/deals"
          onRecordSupplierReceipt={async () => {}}
        />
      </div>
    );
    expect(screen.getByTestId("deal-header").closest("[dir='rtl']")).toBeTruthy();
    const header = screen.getByTestId("deal-header");
    expect(header.textContent).toContain("DealCockpitTitle");
    expect(header.textContent).toContain("#2048");
    expect(header.textContent).toContain("Approved");
    expect(header.textContent).toContain("StageOwnerDealership");
    expect(screen.getByRole("link", { name: "BackToDeals" }).getAttribute("href")).toBe("/org_1/deals");
    const rail = screen.getByTestId("deal-stage-rail");
    expect(rail.querySelectorAll("li")).toHaveLength(2);
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain("StageHandover");
    // The Arabic currency marker sits beside the figure on the same screen.
    expect(screen.getByText(/2,410 د\.أ/)).toBeTruthy();
  });

  test("a stage with nothing outstanding says so in the focus row, and a blocker replaces it", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.getByTestId("deal-next-step").textContent).toContain("BlockerDocumentsIncomplete");
    expect(screen.queryByText("StageReadyToProceed")).toBeNull();
  });
});
