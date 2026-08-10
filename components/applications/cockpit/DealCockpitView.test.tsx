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

  test("is visible even to a caller who cannot see the deal's money", () => {
    // The whole reason the field lives outside `money`. The person who chases a
    // settlement advice is not always the person allowed to see margins, and a
    // warning only the accountant can see is not a warning.
    renderCockpit(dealFixture({ money: null, settlementAdviceDiscrepancy: DISCREPANCY }));
    expect(screen.getByText("MoneyPanelHidden")).toBeTruthy();
    expect(screen.getByText("SettlementAdviceDiscrepancyTitle")).toBeTruthy();
    expect(screen.getByText(/17,995/)).toBeTruthy();
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
