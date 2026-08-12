/**
 * Recording what the finance company told us — the operator path that did not
 * exist.
 *
 * `recordSubmittedQuotation` and `approveDealerPurchaseAmount` shipped with no
 * caller outside tests, so a configured deal could be approved and then never
 * finished: the figures the lifecycle needs had no screen. These tests pin the
 * three things that would quietly rebuild that dead end —
 *
 *   • the card must render for a caller with NO money block, because the role
 *     that records the approval (MANAGER) cannot see one;
 *   • a REDACTED amount must never be reported as an unrecorded one;
 *   • every reason an action is unavailable must be stated, never silent.
 *
 * — plus the two dialogs' provenance rules, which the server enforces exactly
 * and will refuse if the screen guesses them wrong.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DealCockpitData, FinanceDecisionWiring } from "./DealCockpit";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    // Identity `t`, so a missing translation shows up as its key rather than
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

// Currency-AWARE, as in the sibling suite: a constant scale would make every
// "is this figure scaled by the APPLICATION's currency?" assertion pass by
// construction, which is the defect the scale test exists to catch.
vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (code === "USD" ? 2 : 3),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpitView } from "./DealCockpit";

const JOD = 1_000;

/** A financed deal whose approved-purchase stage is the live blocker. */
function dealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    dealKind: "FINANCED",
    dealRef: "app_2048",
    applicationId: "app_2048",
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1",
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: false,
      supplierName: "",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "NoApprovedPurchaseAmount" },
      { key: "SETTLEMENT", state: "PENDING" },
    ],
    documents: [],
    timeline: [],
    // The MANAGER case: `view:finance` withheld, so the whole money block is
    // null. This is the DEFAULT here on purpose — the recorder has to work for
    // exactly this caller.
    money: null,
    ...overrides,
  } as unknown as DealCockpitData;
}

const noopAsync = async () => {};

/**
 * `facts` is merged rather than replaced, so a case that varies one fact does
 * not silently drop the rest. Spreading `overrides` wholesale would do exactly
 * that — and a fixture missing `closed` or `approvedPurchaseRecorded` renders a
 * different card than the one the case means to assert about.
 */
function wiring(overrides: Partial<FinanceDecisionWiring> = {}): FinanceDecisionWiring {
  const { facts, ...rest } = overrides;
  return {
    currency: "JOD",
    canRecordQuotation: true,
    canRecordApproval: true,
    isOwnDeal: false,
    calculatedQuotationMinor: null,
    appraisal: null,
    onRecordQuotation: noopAsync,
    onRecordApproved: noopAsync,
    ...rest,
    facts: {
      approvedPurchaseRecorded: false,
      submittedQuotationMinor: null,
      approvedPurchaseAmountMinor: null,
      financeCompanyFundedPortionMinor: null,
      unfinancedPortionMinor: null,
      dealerContributionMinor: null,
      appliedLtvPercent: null,
      closed: false,
      ...(facts ?? {}),
    },
  };
}

function renderCockpit(financeDecision: FinanceDecisionWiring, deal = dealFixture()) {
  return render(
    <DealCockpitView
      deal={deal}
      financeDecision={financeDecision}
      onRecordSupplierReceipt={async () => {}}
    />
  );
}

/** The card's own action buttons, excluding any inside an open dialog. */
function cardButton(name: string): HTMLElement | undefined {
  return screen
    .queryAllByRole("button", { name })
    .find((button) => button.closest('[role="dialog"]') === null);
}

afterEach(() => {
  cleanup();
  language.locale = "ar";
});

describe("the card is not behind the money gate", () => {
  test("renders for a caller with no money block at all", () => {
    renderCockpit(wiring());

    // The money panel is withheld...
    expect(screen.getByText("MoneyPanelHidden")).toBeTruthy();
    // ...and the recorder is still there, because MANAGER holds
    // `approve:finance_application` and not `view:finance`.
    expect(screen.getByText("FinanceDecisionHeading")).toBeTruthy();
    expect(cardButton("RecordQuotationAction")).toBeTruthy();
  });

  test("says AutoFlow records the decision rather than making one", () => {
    renderCockpit(wiring());
    expect(screen.getByText("FinanceDecisionIntro")).toBeTruthy();
  });

  test("is absent on a deal with no economics wiring — a cash sale", () => {
    render(
      <DealCockpitView
        deal={dealFixture({ dealKind: "CASH", applicationId: null })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.queryByText("FinanceDecisionHeading")).toBeNull();
  });
});

describe("a recorded amount this caller cannot see", () => {
  test("reports it as recorded-but-hidden, never as unrecorded", () => {
    renderCockpit(
      wiring({
        facts: {
          // The stage rail's answer, derived by the SERVER from the unredacted
          // row: the amount IS on the record.
          approvedPurchaseRecorded: true,
          // ...and `redactSettlementEvidence` withheld it from this caller.
          approvedPurchaseAmountMinor: null,
          submittedQuotationMinor: 12_500 * JOD,
          financeCompanyFundedPortionMinor: null,
          unfinancedPortionMinor: null,
          dealerContributionMinor: null,
          appliedLtvPercent: null,
          closed: false,
        },
      })
    );

    expect(screen.getByText("RecordedAmountHidden")).toBeTruthy();
    // The row must not claim the opposite of what the rail says...
    expect(screen.queryByText("NotRecordedYet")).toBeNull();
    // ...nor invite the operator to record an amount that already exists.
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
  });

  test("and the quotation can no longer be re-recorded once an approval exists", () => {
    renderCockpit(
      wiring({
        facts: {
          approvedPurchaseRecorded: true,
          approvedPurchaseAmountMinor: 12_000 * JOD,
          submittedQuotationMinor: 12_500 * JOD,
          financeCompanyFundedPortionMinor: null,
          unfinancedPortionMinor: null,
          dealerContributionMinor: null,
          appliedLtvPercent: null,
          closed: false,
        },
      })
    );

    // The server refuses to move the figure an approval was based on, and
    // reopening has no screen — so offering the action would produce a refusal
    // with nowhere to go.
    expect(cardButton("RecordQuotationAction")).toBeUndefined();
  });
});

describe("every unavailable action says why", () => {
  test("the quotation has to come first", () => {
    renderCockpit(wiring());

    expect(screen.getByText("QuotationNeededFirst")).toBeTruthy();
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
    // The step the operator CAN take is still offered.
    expect(cardButton("RecordQuotationAction")).toBeTruthy();
  });

  test("a salesperson cannot record the approval on their own deal", () => {
    renderCockpit(
      wiring({
        isOwnDeal: true,
        facts: { submittedQuotationMinor: 12_500 * JOD },
      })
    );

    expect(screen.getByText("ApprovedPurchaseNotOwnDeal")).toBeTruthy();
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
  });

  test("a caller without the approval permission is told who records it", () => {
    renderCockpit(
      wiring({
        canRecordApproval: false,
        facts: { submittedQuotationMinor: 12_500 * JOD },
      })
    );

    expect(screen.getByText("ApprovedPurchaseNeedsApprover")).toBeTruthy();
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
  });

  test("a closed deal offers nothing and says so", () => {
    renderCockpit(
      wiring({
        facts: { submittedQuotationMinor: 12_500 * JOD, closed: true },
      })
    );

    expect(screen.getByText("FinanceDecisionClosed")).toBeTruthy();
    expect(cardButton("RecordQuotationAction")).toBeUndefined();
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
  });
});

describe("the derived figures", () => {
  test("are read-only and scaled by the APPLICATION's currency, not the org's", () => {
    renderCockpit(
      wiring({
        // The org is JOD (scale 3); this deal was pinned to USD (scale 2).
        currency: "USD",
        facts: {
          approvedPurchaseRecorded: true,
          approvedPurchaseAmountMinor: 1_200_000,
          submittedQuotationMinor: 1_250_000,
          financeCompanyFundedPortionMinor: 1_000_000,
          unfinancedPortionMinor: 200_000,
          dealerContributionMinor: 50_000,
          appliedLtvPercent: 90,
          closed: false,
        },
      })
    );

    // 1,000,000 minor USD is 10,000 — at the org's JOD scale it would render as
    // 1,000, which is the 100x class of error this scale exists to prevent.
    // Exact strings, not substrings: `/2,000 USD/` also matches the approved
    // amount's "12,000 USD" two rows above, which would let a wrong figure pass.
    expect(screen.getByText("10,000 USD")).toBeTruthy();
    expect(screen.getByText("2,000 USD")).toBeTruthy();
    expect(screen.getByText("500 USD")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("DerivedEconomicsNote")).toBeTruthy();

    // Derived, therefore not editable: the card has no inputs at all.
    expect(document.querySelectorAll("input").length).toBe(0);
  });
});

describe("recording the submitted quotation", () => {
  test("a figure equal to the calculation is recorded as calculated, with no reason", async () => {
    const onRecordQuotation = vi.fn(noopAsync);
    renderCockpit(wiring({ calculatedQuotationMinor: 12_500 * JOD, onRecordQuotation }));

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "QuotationUseCalculated" }));
    expect(within(dialog).getByText("QuotationMatchesCalculation")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(onRecordQuotation).toHaveBeenCalledWith({
        submittedQuotationMinor: 12_500 * JOD,
        source: "SYSTEM_CALCULATED",
        overrideReason: undefined,
      })
    );
  });

  test("a figure that departs from the calculation cannot be recorded without a reason", async () => {
    const onRecordQuotation = vi.fn(noopAsync);
    renderCockpit(wiring({ calculatedQuotationMinor: 12_500 * JOD, onRecordQuotation }));

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "13000" },
    });

    expect(within(dialog).getByText("QuotationDiffersFromCalculation")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "RecordQuotationAction" });
    // The server refuses an override with no reason; the form refuses first,
    // so the operator learns it before the round trip.
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("QuotationOverrideReasonLabel"), {
      target: { value: "اتُّفق عليه هاتفياً" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(onRecordQuotation).toHaveBeenCalledWith({
        submittedQuotationMinor: 13_000 * JOD,
        source: "CALCULATED_WITH_OVERRIDE",
        overrideReason: "اتُّفق عليه هاتفياً",
      })
    );
  });

  test("with no calculation available it is recorded as a manual entry", async () => {
    const onRecordQuotation = vi.fn(noopAsync);
    renderCockpit(wiring({ calculatedQuotationMinor: null, onRecordQuotation }));

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("QuotationCalculatorUnavailable")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "11500" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(onRecordQuotation).toHaveBeenCalledWith({
        submittedQuotationMinor: 11_500 * JOD,
        // Never SYSTEM_CALCULATED: the server refuses that label when the
        // solver never ran, and the refusal would name a rule the operator was
        // never shown.
        source: "MANUAL_ENTRY",
        overrideReason: undefined,
      })
    );
  });

  test("the server's refusal is shown in the form, and the form stays open", async () => {
    const onRecordQuotation = vi.fn(async () => {
      throw new Error("The submitted quotation must be greater than zero.");
    });
    renderCockpit(wiring({ onRecordQuotation }));

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "11500" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(
        screen.getByText("The submitted quotation must be greater than zero.")
      ).toBeTruthy()
    );
    // Still open: a refusal the operator can act on is worthless behind a
    // closed dialog and a faded toast.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("recording what the finance company approved", () => {
  const quotationRecorded = { submittedQuotationMinor: 12_500 * JOD };

  test("with no appraisal on file, only the amount they named is offered — and it needs a note", async () => {
    const onRecordApproved = vi.fn(noopAsync);
    renderCockpit(wiring({ facts: quotationRecorded, appraisal: null, onRecordApproved }));

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("NoAppraisalOnFile")).toBeTruthy();
    // An appraisal-based option with no appraisal is an offer the server can
    // only refuse, so it is absent rather than disabled.
    expect(within(dialog).queryByRole("radio", { name: /BasisAppraisal/ })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: /BasisQuotationException/ })).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("ApprovedAmountLabel"), {
      target: { value: "12000" },
    });
    const submit = within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("BasisManualNotesLabel"), {
      target: { value: "اعتُمد بمبلغ 12,000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    await waitFor(() =>
      expect(onRecordApproved).toHaveBeenCalledWith({
        approvedAmountMinor: 12_000 * JOD,
        basis: "MANUAL",
        appraisalId: undefined,
        notes: "اعتُمد بمبلغ 12,000",
      })
    );
  });

  test("an appraisal-based approval sends the appraisal's own figure and its id", async () => {
    const onRecordApproved = vi.fn(noopAsync);
    renderCockpit(
      wiring({
        facts: quotationRecorded,
        appraisal: { id: "appraisal_9", amountMinor: 11_800 * JOD },
        onRecordApproved,
      })
    );

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");

    // The amount is the evidence, so it is not typed: an editable copy would
    // invite a figure the server is bound to refuse.
    expect(within(dialog).queryByLabelText("ApprovedAmountLabel")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    await waitFor(() =>
      expect(onRecordApproved).toHaveBeenCalledWith({
        approvedAmountMinor: 11_800 * JOD,
        basis: "APPRAISAL",
        appraisalId: "appraisal_9",
        notes: undefined,
      })
    );
  });
});
