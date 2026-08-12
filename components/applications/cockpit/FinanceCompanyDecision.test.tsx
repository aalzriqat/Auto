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
import type { FinanceDecisionFacts } from "./FinanceCompanyDecisionCard";

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

const noopAsync = async (_values?: unknown) => {};

/**
 * `facts` is merged rather than replaced, so a case that varies one fact does
 * not silently drop the rest. Spreading `overrides` wholesale would do exactly
 * that — and a fixture missing `closed` or `approvedPurchaseRecorded` renders a
 * different card than the one the case means to assert about.
 */
type WiringOverrides = Partial<Omit<FinanceDecisionWiring, "facts">> & {
  facts?: Partial<FinanceDecisionFacts>;
};

function wiring(overrides: WiringOverrides = {}): FinanceDecisionWiring {
  const { facts, ...rest } = overrides;
  return {
    currency: "JOD",
    canRecordQuotation: true,
    canRecordApproval: true,
    isOwnDeal: false,
    calculation: { state: "UNAVAILABLE" },
    appraisal: null,
    onRecordQuotation: noopAsync,
    onRecordApproved: noopAsync,
    onRecordAppraisal: noopAsync,
    canRecordAppraisal: true,
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
      ltvMissing: false,
      handedOver: false,
      appraisalAmountMinor: null,
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
    // The APPROVED row must not claim the opposite of what the rail says.
    // Scoped to that row: the appraisal row above it legitimately reads "not
    // recorded yet" on this fixture, and a global query would pass on the wrong
    // element — the exact vacuity this suite has been bitten by before.
    const approvedRow = screen.getByText("ApprovedPurchaseLabel").closest("div")!;
    expect(within(approvedRow).queryByText("NotRecordedYet")).toBeNull();
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

  test("a deal whose frozen rules carry no purchase LTV asks for the rate instead of sending the operator to settings", async () => {
    // Found by RENDERING against a company created through the real settings
    // form: that form only ever asked for the customer-facing LTV, so
    // `resolveAppliedLtv` threw, and the throw — from `useQuery`, during
    // render — took the whole deal screen down with a Convex stack trace.
    //
    // The first fix hid the action and told the operator to add the rate in
    // Finance Settings. That instruction cannot repair the deal it appears on:
    // an application snapshots its company's rules at creation and never
    // re-reads them, so the edit governs future deals only. The action stays,
    // and the dialog asks for the rate that applies to THIS deal.
    const onRecordQuotation = vi.fn(noopAsync);
    renderCockpit(wiring({ facts: { ltvMissing: true }, onRecordQuotation }));

    expect(screen.getByText("FinanceCompanyLtvMissing")).toBeTruthy();
    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "13000" },
    });
    // Without the rate there is nothing to submit — the server would refuse.
    expect(
      (
        within(dialog).getByRole("button", {
          name: "RecordQuotationAction",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("DealPurchaseLtvLabel"), {
      target: { value: "90" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(onRecordQuotation).toHaveBeenCalledWith({
        submittedQuotationMinor: 13_000 * JOD,
        source: "MANUAL_ENTRY",
        overrideReason: undefined,
        // Per-deal, and only here: the deal moves without anyone rewriting the
        // immutable rules it was created under.
        ltvPercent: 90,
      })
    );
  });

  test("a deal whose rules DO carry a rate is never asked for one", () => {
    renderCockpit(wiring());

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    // Sending a per-deal rate where the company's rules already answer would
    // override them for a deal that never asked.
    expect(within(dialog).queryByLabelText("DealPurchaseLtvLabel")).toBeNull();
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
    renderCockpit(wiring({ calculation: { state: "AVAILABLE", minor: 12_500 * JOD }, onRecordQuotation }));

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
    renderCockpit(wiring({ calculation: { state: "AVAILABLE", minor: 12_500 * JOD }, onRecordQuotation }));

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
    renderCockpit(wiring({ calculation: { state: "UNAVAILABLE" }, onRecordQuotation }));

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

  test("nothing can be submitted while the calculator is still answering", () => {
    renderCockpit(wiring({ calculation: { state: "LOADING" } }));

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");

    // The window between opening the dialog and the suggestion arriving was
    // indistinguishable from "no calculation exists", so anything entered in it
    // would have been recorded as a MANUAL_ENTRY — a claim about provenance,
    // not a description of the wait — and a solver-divergent figure would have
    // gone on the record with no override reason behind it.
    expect(within(dialog).getByText("QuotationCalculatorLoading")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "13000" },
    });
    const submit = within(dialog).getByRole("button", { name: "RecordQuotationAction" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
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

describe("recording their appraisal", () => {
  /**
   * The stage the rail blocks on, which had no writer anywhere in the product.
   *
   * Sending the quotation moves the appraisal dimension to PENDING, so
   * `APPRAISAL / AwaitingAppraisal` becomes the live blocker immediately after
   * step one. Without this action the rail said the deal was waiting on an
   * appraisal while the economics workflow carried on around it — two
   * authorities on one screen, and no way to make the first one true.
   */
  test("is offered once the quotation has gone out, and records what the operator entered", async () => {
    const onRecordAppraisal = vi.fn(noopAsync);
    renderCockpit(
      wiring({ facts: { submittedQuotationMinor: 12_500 * JOD }, onRecordAppraisal })
    );

    fireEvent.click(cardButton("RecordAppraisalAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("AppraisalAmountLabel"), {
      target: { value: "11800" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordAppraisalAction" }));

    await waitFor(() => expect(onRecordAppraisal).toHaveBeenCalled());
    expect(onRecordAppraisal.mock.calls[0][0]).toMatchObject({
      appraisalAmountMinor: 11_800 * JOD,
      // Their valuation is the default; a dealer's own estimate is not offered
      // at all, because the server refuses it as an approval basis.
      providerType: "FINANCE_COMPANY",
    });
  });

  test("the whole row is absent before the quotation, because nothing has put it in play", () => {
    renderCockpit(wiring());

    // Asserting only on the BUTTON here was vacuous: the row that contains it
    // is not rendered either, so the assertion passed with the gate removed.
    // The row's own visibility is the rule, so that is what is pinned.
    expect(screen.queryByText("TheirAppraisalLabel")).toBeNull();
    expect(cardButton("RecordAppraisalAction")).toBeUndefined();
  });

  test("can still be corrected after an approval, with a reason and a warning", async () => {
    const onRecordAppraisal = vi.fn(noopAsync);
    renderCockpit(
      wiring({
        facts: {
          submittedQuotationMinor: 12_500 * JOD,
          appraisalAmountMinor: 11_500 * JOD,
          approvedPurchaseRecorded: true,
          approvedPurchaseAmountMinor: 11_500 * JOD,
        },
        onRecordAppraisal,
      })
    );

    // A recorded appraisal is a figure somebody typed, and a typo in it drives
    // the funding split. Withdrawing the only screen that can record one the
    // moment an approval exists left no way to correct it.
    fireEvent.click(cardButton("ReplaceAppraisalAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("AppraisalAmountLabel"), {
      target: { value: "11900" },
    });

    // The server refuses a reappraisal with no reason, and clears the approval
    // it invalidates — both said before the operator commits. The submit button
    // names the action it performs, like the heading above it: a dialog titled
    // "replace" whose button says "record" disagrees with itself.
    expect(
      (
        within(dialog).getByRole("button", {
          name: "ReplaceAppraisalAction",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(within(dialog).getByText(/ReappraisalReopensApproval/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("ReappraisalReasonLabel"), {
      target: { value: "أُدخل الرقم الأول خطأً" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "ReplaceAppraisalAction" }));

    await waitFor(() => expect(onRecordAppraisal).toHaveBeenCalled());
    expect(onRecordAppraisal.mock.calls[0][0]).toMatchObject({
      appraisalAmountMinor: 11_900 * JOD,
      reappraisalReason: "أُدخل الرقم الأول خطأً",
    });
  });

  test("warns before a FIRST appraisal silently withdraws a manual approval", () => {
    // `recordAppraisal` supersedes any approval on the deal, not only one that
    // was based on an appraisal — so the first appraisal on a manually approved
    // deal clears the approved amount, the funding split, the gap resolution
    // and handover readiness. Keying the warning on "is this a reappraisal"
    // left that case silent: an ordinary-looking first appraisal reopened the
    // whole deal.
    renderCockpit(
      wiring({
        facts: {
          submittedQuotationMinor: 12_500 * JOD,
          appraisalAmountMinor: null,
          approvedPurchaseRecorded: true,
          approvedPurchaseAmountMinor: 12_200 * JOD,
        },
      })
    );

    fireEvent.click(cardButton("RecordAppraisalAction")!);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("AppraisalWithdrawsApproval")).toBeTruthy();
  });

  test("is withdrawn once the vehicle has gone out, because the server refuses then", () => {
    // `recordAppraisal` does not supersede after handover — it declines. An
    // action offered there would promise a withdrawal that never happens.
    renderCockpit(
      wiring({
        facts: {
          submittedQuotationMinor: 12_500 * JOD,
          appraisalAmountMinor: 11_500 * JOD,
          handedOver: true,
        },
      })
    );

    expect(cardButton("ReplaceAppraisalAction")).toBeUndefined();
    expect(cardButton("RecordAppraisalAction")).toBeUndefined();
  });

  test("tells a caller who cannot record one who does", () => {
    renderCockpit(
      wiring({ canRecordAppraisal: false, facts: { submittedQuotationMinor: 12_500 * JOD } })
    );

    expect(screen.getByText("AppraisalNeedsReviewer")).toBeTruthy();
    expect(cardButton("RecordAppraisalAction")).toBeUndefined();
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

  test("notes typed under MANUAL do not follow a change of basis", async () => {
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

    fireEvent.click(within(dialog).getByRole("radio", { name: /BasisManual/ }));
    fireEvent.change(within(dialog).getByLabelText("BasisManualNotesLabel"), {
      target: { value: "Approved by phone at 12,200" },
    });
    // The notes field is hidden under an appraisal basis, so text left behind
    // by a change of mind would be stored against an approval nobody wrote it
    // for.
    fireEvent.click(within(dialog).getByRole("radio", { name: /BasisAppraisal/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    await waitFor(() => expect(onRecordApproved).toHaveBeenCalled());
    expect(onRecordApproved.mock.calls[0][0]).toMatchObject({
      basis: "APPRAISAL",
      notes: undefined,
    });
  });

  test("arrow keys move between the bases, and the group is one tab stop", () => {
    renderCockpit(
      wiring({
        facts: quotationRecorded,
        appraisal: { id: "appraisal_9", amountMinor: 11_800 * JOD },
      })
    );

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");
    const radios = within(dialog).getAllByRole("radio");

    // A radio group is ONE tab stop with arrow keys inside it. Hand-rolled from
    // buttons it was neither: every option was tab-focusable and the arrows did
    // nothing, so a keyboard user tabbed through the options of one control.
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].getAttribute("aria-checked")).toBe("false");

    // ...and it wraps rather than dead-ending at the last option.
    fireEvent.keyDown(radios[1], { key: "ArrowUp" });
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  });

  test("the server's refusal on the approval is shown in its form too", async () => {
    const onRecordApproved = vi.fn(async () => {
      throw new Error("You cannot approve the purchase amount on your own application.");
    });
    renderCockpit(
      wiring({
        facts: quotationRecorded,
        appraisal: { id: "appraisal_9", amountMinor: 11_800 * JOD },
        onRecordApproved,
      })
    );

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    // The quotation dialog had this pinned and this one did not, though both
    // rely on it: the refusals here name the rule to fix, and a faded toast is
    // not a recovery path.
    await waitFor(() =>
      expect(
        screen.getByText("You cannot approve the purchase amount on your own application.")
      ).toBeTruthy()
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
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
