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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const SCALE = 1_000;

function dealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    dealKind: "FINANCED",
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
        postable: true,
        lines: [
          { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
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
