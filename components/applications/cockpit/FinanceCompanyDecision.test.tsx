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
import { RecordSubmittedQuotationDialog } from "./RecordSubmittedQuotationDialog";

const JOD = 1_000;

/** A financed deal whose approved-purchase stage is the live blocker. */
/**
 * The server's stamp of the deal's economics, as `dealCockpit` issues it — a
 * revision counter, carrying no figure. The dialog sends this back rather than
 * an amount, so the mutation can refuse a deal whose economics moved while the
 * operator was reading them, without the token itself disclosing them.
 */
const STAMP = "v2|7";

function dealFixture(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    dealKind: "FINANCED",
    economicsStamp: STAMP,
    denomination: { code: "JOD", scale: 3 },
    economicsRecorded: true,
    handoverEvidence: {
      approvedPurchaseAmountMinor: null,
      financeCompanyFundedPortionMinor: null,
      dealerContributionMinor: null,
      approvedAmountIsFarFromEvidence: false,
      currency: { code: "JOD", scale: 3 },
    },
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
    onReopenApproved: noopAsync,
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

describe("a denomination nobody can vouch for", () => {
  test("withholds the money panel and says why, instead of guessing", () => {
    // A legacy row carrying "JD": JOD is scale 3, the fallback scaler answers
    // 2, and 11,500,000 fils renders as 115,000. Handover refuses such a deal,
    // which protects the irreversible step and leaves the dealer reading a
    // figure wrong by a factor of ten.
    render(
      <DealCockpitView
        deal={dealFixture({
          denomination: null,
          // Money withheld from this caller AND economics on the record. The
          // server states both, so the warning reaches a caller who cannot see
          // the figures either way.
          money: null,
          economicsRecorded: true,
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.getByText("EconomicsCurrencyUnusable")).toBeTruthy();
    expect(screen.getByText("EconomicsCurrencyUnusableHint")).toBeTruthy();
  });

  test("does not fire for a PRIVILEGED caller on a deal with no economics yet", () => {
    // The shape both reviewers said the suite never exercised, and the one the
    // dealership owner sees most: `dealCockpit` builds a money object for any
    // caller holding `view:finance` — zeroed rows, no economics recorded — so a
    // predicate keyed on `Boolean(deal.money)` put a red "record it again"
    // panel on every newly created financed deal. Nothing had been recorded
    // once.
    //
    // The money block is supplied EXPLICITLY. `dealFixture` defaults it to null
    // — the MANAGER case — and Codex caught that inheriting the default made
    // this test vacuous: with no money object the discarded `Boolean(deal.money)`
    // predicate is false too, so the case passed against the very code it was
    // written to condemn. A test that cannot fail on the old implementation is
    // not a regression test for it.
    render(
      <DealCockpitView
        deal={dealFixture({
          denomination: null,
          economicsRecorded: false,
          // What `buildCockpitMoney` actually returns for a deal on which
          // nothing has been recorded: a real object, present rows, no figures.
          // That presence is the whole trap — it is built from the caller's
          // PERMISSION, not from the deal having any money on it.
          money: {
            currency: "JOD",
            settlesDirectToSupplier: false,
            routeKnown: false,
            profit: { available: false, reason: "NoApprovedPurchaseAmount" },
            expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
            parties: [],
          },
        })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.queryByText("EconomicsCurrencyUnusable")).toBeNull();
  });

  test("does not fire for a CASH deal, whose payload carries no denomination", () => {
    // `sales.dealCockpit` projects no denomination at all. Reading that absence
    // as "unusable" would have hidden the figures on every live cash sale — a
    // regression far worse than the display fault this guards against.
    //
    // The keys are DELETED, not set to `undefined`. Both reviewers caught this
    // independently: spreading an explicit `undefined` leaves the key in place,
    // so `"denomination" in deal` stayed true and the case never touched the
    // absent-key path it names. It passed on a coincidence — `undefined !== null`
    // downstream — which is not the invariant being guarded.
    const cash = dealFixture({
      dealKind: "CASH",
      applicationId: null,
      // A cash sale HAS money — that is the entire point of the regression. The
      // fixture's default is null (the MANAGER case), and inheriting it made
      // this test pass against the broken predicate too, since `Boolean(null)`
      // is false either way. With the figures present, reading the missing
      // denomination as "unusable" replaces them, which is what must not happen.
      money: {
        currency: "JOD",
        settlesDirectToSupplier: false,
        routeKnown: true,
        profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
        parties: [],
      },
    }) as Record<string, unknown>;
    delete cash.denomination;
    delete cash.economicsRecorded;
    expect("denomination" in cash).toBe(false);
    expect("economicsRecorded" in cash).toBe(false);

    render(
      <DealCockpitView
        deal={cash as never}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.queryByText("EconomicsCurrencyUnusable")).toBeNull();
  });

  test("withholds the figures when the backend is too old to say whether economics exist", () => {
    // Version skew, which on this repository is the DEFAULT after a merge:
    // pushing to `main` auto-deploys the frontend while the Convex functions
    // stay on the previous version until deployed by hand. That response
    // carries `denomination` but not `economicsRecorded`.
    //
    // Codex found that reading the absent key as "nothing recorded" switched the
    // guard off in exactly that window, putting a legacy unspellable row back
    // through the guessing scale. Unknown has to fail closed.
    const oldBackend = dealFixture({ denomination: null }) as Record<string, unknown>;
    delete oldBackend.economicsRecorded;
    expect("denomination" in oldBackend).toBe(true);
    expect("economicsRecorded" in oldBackend).toBe(false);

    render(
      <DealCockpitView
        deal={oldBackend as never}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.getByText("EconomicsCurrencyUnusable")).toBeTruthy();
  });

  test("does not fire for a deal with no economics recorded", () => {
    // Absent currency on a deal with nothing to denominate is ordinary, not an
    // error — warning there would put a red panel on every new deal.
    render(
      <DealCockpitView
        deal={dealFixture({ denomination: null, money: null, economicsRecorded: false })}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(screen.queryByText("EconomicsCurrencyUnusable")).toBeNull();
  });
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

  /**
   * The exceptional per-deal rate, and who may name it.
   *
   * `recordSubmittedQuotation` refuses an `ltvPercent` from a caller without
   * `approve:finance_application`, because that number scales the finance
   * company's funded portion and therefore the dealership's own contribution.
   * Without a rate there is nothing to record at all — so for that caller on
   * that deal the action is withdrawn rather than opening a dialog that cannot
   * be submitted, exactly as the approval action already is. The row says who
   * unblocks it, because a withdrawn action with no named owner is a dead end.
   */
  test("the action is withdrawn from a caller who cannot set the deal's missing rate", () => {
    renderCockpit(wiring({ canRecordApproval: false, facts: { ltvMissing: true } }));

    expect(cardButton("RecordQuotationAction")).toBeUndefined();
    expect(screen.getByText("DealPurchaseLtvNeedsApprover")).toBeTruthy();
  });

  test("and is offered once the rate is not the thing standing in the way", () => {
    renderCockpit(wiring({ canRecordApproval: false, facts: { ltvMissing: false } }));

    // The withdrawal above is about the missing RATE, not about the permission:
    // recording what was sent is ordinary sales work on a configured deal.
    expect(cardButton("RecordQuotationAction")).toBeTruthy();
  });

  /**
   * The dialog's own guard, tested directly.
   *
   * The card no longer opens it in this state, so this is defence in depth
   * rather than a path an operator walks — and that is exactly why it needs a
   * test of its own: nothing else would notice if it stopped holding.
   */
  test("the dialog refuses the rate to a caller who cannot set it, whoever opens it", () => {
    render(
      <RecordSubmittedQuotationDialog
        open
        submitting={false}
        error={null}
        calculation={{ state: "UNAVAILABLE" }}
        requiresLtvPercent
        canSetLtvPercent={false}
        factor={JOD}
        money={(minor) => String(minor)}
        t={(key) => key}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("DealPurchaseLtvNeedsApprover")).toBeTruthy();
    expect(within(dialog).queryByLabelText("DealPurchaseLtvLabel")).toBeNull();

    // And the quotation cannot be recorded around it: the rate is not optional,
    // it is simply not this caller's to supply.
    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "13000" },
    });
    const submit = within(dialog).getByRole("button", { name: "RecordQuotationAction" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  test("an approver gets the field, and the rate travels with the quotation", async () => {
    const onRecordQuotation = vi.fn(noopAsync);
    renderCockpit(
      wiring({ canRecordApproval: true, onRecordQuotation, facts: { ltvMissing: true } })
    );

    fireEvent.click(cardButton("RecordQuotationAction")!);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("DealPurchaseLtvNeedsApprover")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("QuotationAmountLabel"), {
      target: { value: "13000" },
    });
    fireEvent.change(within(dialog).getByLabelText("DealPurchaseLtvLabel"), {
      target: { value: "90" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordQuotationAction" }));

    await waitFor(() =>
      expect(onRecordQuotation).toHaveBeenCalledWith({
        submittedQuotationMinor: 13_000 * JOD,
        source: "MANUAL_ENTRY",
        overrideReason: undefined,
        ltvPercent: 90,
      })
    );
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

  /**
   * The state a real deal reached in production on the day this shipped.
   *
   * The vehicle had gone out with no appraisal on file. `recordAppraisal`
   * refuses after handover, so the action is correctly withdrawn — but the
   * stage rail goes on naming the appraisal as the next step, and the row said
   * nothing at all, because the only note here fired on the PERMISSION. To the
   * dealership's owner, who holds every permission, that is a deal stopped on a
   * step with no button and no explanation.
   *
   * The recovery exists and is what the note now names: the approved amount can
   * still be recorded on the MANUAL basis, which needs no appraisal.
   */
  test("says why the appraisal is closed once the vehicle has gone out", () => {
    renderCockpit(
      wiring({
        canRecordAppraisal: true,
        facts: { submittedQuotationMinor: 12_500 * JOD, handedOver: true },
      })
    );

    expect(cardButton("RecordAppraisalAction")).toBeUndefined();
    expect(screen.getByText("AppraisalClosedByHandover")).toBeTruthy();
    // Not the permission note: this caller has the permission. Saying a manager
    // must do it would send the owner to look for someone who does not exist.
    expect(screen.queryByText("AppraisalNeedsReviewer")).toBeNull();
  });

  test("still blames the permission when that is what is missing", () => {
    renderCockpit(
      wiring({
        canRecordAppraisal: false,
        facts: { submittedQuotationMinor: 12_500 * JOD, handedOver: false },
      })
    );

    expect(screen.getByText("AppraisalNeedsReviewer")).toBeTruthy();
    expect(screen.queryByText("AppraisalClosedByHandover")).toBeNull();
  });
});

describe("recording what the finance company approved", () => {
  const quotationRecorded = { submittedQuotationMinor: 12_500 * JOD };

  /**
   * The same approved amount under 90% and under 70% leaves the dealership a
   * different contribution, so the rate driving that split is stated at the
   * point the money decision is committed — and on the exceptional per-deal path
   * it was typed by a manager rather than configured on the company, which makes
   * this the last place it can be recognised as wrong.
   */
  test("names the rate the funding split will be computed at", () => {
    renderCockpit(
      wiring({ facts: { ...quotationRecorded, appliedLtvPercent: 90 }, appraisal: null })
    );

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("90%")).toBeTruthy();
    expect(within(dialog).getByText("ApprovedPurchaseLtvDrivesSplit")).toBeTruthy();
  });

  test("says nothing about a rate the deal does not have yet", () => {
    renderCockpit(
      wiring({ facts: { ...quotationRecorded, appliedLtvPercent: null }, appraisal: null })
    );

    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByText("ApprovedPurchaseLtvDrivesSplit")).toBeNull();
  });

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

    fireEvent.keyDown(radios[1], { key: "ArrowUp" });
    expect(radios[0].getAttribute("aria-checked")).toBe("true");

    // ...and the ENDS wrap rather than dead-ending, which is the half the
    // previous version of this test claimed in a comment and never exercised:
    // both assertions above stay inside the group, so a component that simply
    // clamped at the ends would have passed them.
    const last = radios.length - 1;
    fireEvent.keyDown(radios[0], { key: "ArrowUp" });
    expect(radios[last].getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radios[last], { key: "ArrowDown" });
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

/**
 * Correcting an amount already on the record — SCRUM-77.
 *
 * Found in production: a manager recorded 150,000 JOD against a 17,000
 * quotation and a 16,000 appraisal, and the deal sealed itself. The card
 * withdraws the record action the moment an amount exists (correctly — the
 * server refuses to move a quotation an approval rests on), `reopenApproval`
 * had no caller anywhere outside tests, and no numeric check stood between the
 * keystroke and a 150,000 JOD expected remittance. So the wrong figure was
 * permanent, and nothing had questioned it on the way in.
 *
 * Both halves are pinned here: a way OUT of a wrong amount, and a challenge
 * BEFORE one goes in.
 */
describe("a recorded approved amount can be corrected", () => {
  const recorded = {
    submittedQuotationMinor: 17_000 * JOD,
    approvedPurchaseRecorded: true,
    approvedPurchaseAmountMinor: 150_000 * JOD,
  };

  test("the action is offered, and as a correction rather than a fresh recording", () => {
    renderCockpit(wiring({ facts: recorded }));

    expect(cardButton("CorrectApprovedPurchaseAction")).toBeTruthy();
    // Not the first-time action wearing the same clothes. An operator who sees
    // "record" on a deal that already has an amount cannot tell whether the
    // figure took, which is what makes a silent overwrite feel safe.
    expect(cardButton("RecordApprovedPurchaseAction")).toBeUndefined();
  });

  test("it is withheld from the deal's own salesperson, who could reopen and then be refused", () => {
    renderCockpit(wiring({ isOwnDeal: true, facts: recorded }));

    // `reopenApproval` would let them through — it asks only for the approval
    // permission — but `approveDealerPurchaseAmount` refuses them. Offering it
    // would trade a deal with a wrong number for one with NO number.
    expect(cardButton("CorrectApprovedPurchaseAction")).toBeUndefined();
    expect(screen.getByText("ApprovedPurchaseNotOwnDeal")).toBeTruthy();
  });

  test("handover seals it, and the card says so instead of going quiet", () => {
    renderCockpit(wiring({ facts: { ...recorded, handedOver: true } }));

    expect(cardButton("CorrectApprovedPurchaseAction")).toBeUndefined();
    expect(screen.getByText("ApprovedPurchaseSealedByHandover")).toBeTruthy();
  });

  test("a caller who cannot approve is not told about a correction they cannot make", () => {
    renderCockpit(wiring({ canRecordApproval: false, facts: { ...recorded, handedOver: true } }));

    // Nothing on this screen ASKS for a correction, so a note for every viewer
    // would be permanent noise on deals where nothing is wrong.
    expect(screen.queryByText("ApprovedPurchaseSealedByHandover")).toBeNull();
  });

  test("reopening sends the reason, and lands on the recorder rather than an empty deal", async () => {
    const onReopenApproved = vi.fn(noopAsync);
    renderCockpit(wiring({ facts: recorded, onReopenApproved }));

    fireEvent.click(cardButton("CorrectApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");

    // The reason is the ONLY place the replaced figure survives: the override
    // row is the deal's whole history of this change.
    expect(
      within(dialog).getByRole("button", { name: "ReopenApprovedPurchaseAction" })
    ).toHaveProperty("disabled", true);

    fireEvent.change(within(dialog).getByLabelText("ReopenApprovalReasonLabel"), {
      target: { value: "entered as 150,000 by mistake" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "ReopenApprovedPurchaseAction" }));

    await waitFor(() =>
      expect(onReopenApproved).toHaveBeenCalledWith({ reason: "entered as 150,000 by mistake" })
    );
    // Reopening leaves the deal with no amount and handover blocked. Stopping
    // there would replace a wrong number with a missing one.
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("RecordApprovedPurchaseTitle")
    );
  });
});

describe("an amount unlike the deal's own figures is questioned before it is recorded", () => {
  const withAppraisal = {
    facts: { submittedQuotationMinor: 17_000 * JOD },
    appraisal: { id: "appraisal_1", amountMinor: 16_000 * JOD },
  };

  /** Opens the recorder on the MANUAL basis with an amount and a note. */
  function typeManualAmount(amountMajor: number) {
    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /BasisManual/ }));
    fireEvent.change(within(dialog).getByLabelText("ApprovedAmountLabel"), {
      target: { value: String(amountMajor) },
    });
    fireEvent.change(within(dialog).getByLabelText("BasisManualNotesLabel"), {
      target: { value: "what the company said" },
    });
    return dialog;
  }

  test("the production typo stops and states the figures side by side", async () => {
    const onRecordApproved = vi.fn(noopAsync);
    renderCockpit(wiring({ ...withAppraisal, onRecordApproved }));

    const dialog = typeManualAmount(150_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    // Nothing was written. This is the whole point: the check happens BEFORE
    // the funding split is derived from the wrong number, not after.
    expect(onRecordApproved).not.toHaveBeenCalled();
    expect(within(dialog).getByText("ApprovedAmountFarFromEvidence")).toBeTruthy();

    // And it is a question, not a refusal — AutoFlow is not entitled to decide
    // the finance company's number is impossible.
    fireEvent.click(within(dialog).getByRole("button", { name: "ApprovedAmountConfirmAction" }));
    await waitFor(() =>
      expect(onRecordApproved).toHaveBeenCalledWith(
        expect.objectContaining({ approvedAmountMinor: 150_000 * JOD, basis: "MANUAL" })
      )
    );
  });

  test("an ordinary negotiated figure records on the first click", async () => {
    const onRecordApproved = vi.fn(noopAsync);
    renderCockpit(wiring({ ...withAppraisal, onRecordApproved }));

    // 14,000 against a 16,000 appraisal is a normal commercial move. Nagging
    // here is how an operator learns to click through the warning that matters.
    const dialog = typeManualAmount(14_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    await waitFor(() =>
      expect(onRecordApproved).toHaveBeenCalledWith(
        expect.objectContaining({ approvedAmountMinor: 14_000 * JOD })
      )
    );
    expect(screen.queryByText("ApprovedAmountFarFromEvidence")).toBeNull();
  });

  test("going back from the question returns to the form with the amount intact", () => {
    renderCockpit(wiring(withAppraisal));

    const dialog = typeManualAmount(150_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "GoBack" }));

    expect(within(dialog).queryByText("ApprovedAmountFarFromEvidence")).toBeNull();
    expect(within(dialog).getByLabelText("ApprovedAmountLabel")).toHaveProperty("value", "150000");
  });
});

/**
 * The ordering guard Sonnet asked for on #231: both withdrawals at once.
 *
 * Each existing case varies one of `{canRecordAppraisal, handedOver}` while
 * holding the other at the value that makes the wrong branch fire, so a
 * refactor that swapped the two arms would pass them both.
 */
describe("handover outranks the permission when explaining the appraisal", () => {
  test("a caller with neither the permission nor a vehicle still present is told about the handover", () => {
    renderCockpit(
      wiring({
        canRecordAppraisal: false,
        facts: { submittedQuotationMinor: 12_500 * JOD, handedOver: true },
      })
    );

    expect(screen.getByText("AppraisalClosedByHandover")).toBeTruthy();
    expect(screen.queryByText("AppraisalNeedsReviewer")).toBeNull();
  });
});

/**
 * The answer reaches the server, and a retired question stops being asked.
 *
 * Both were fixes to review findings and neither was pinned by anything but the
 * type checker, which cannot tell whether a flag is passed on the right branch
 * or a footer still offers to confirm something nobody was asked about.
 */
describe("the departure question is carried to the server, and retired when it stops applying", () => {
  const withAppraisal = {
    facts: { submittedQuotationMinor: 17_000 * JOD },
    appraisal: { id: "appraisal_1", amountMinor: 16_000 * JOD },
  };

  function openManual(dialogAmount: number) {
    fireEvent.click(cardButton("RecordApprovedPurchaseAction")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /BasisManual/ }));
    fireEvent.change(within(dialog).getByLabelText("ApprovedAmountLabel"), {
      target: { value: String(dialogAmount) },
    });
    fireEvent.change(within(dialog).getByLabelText("BasisManualNotesLabel"), {
      target: { value: "what the company said" },
    });
    return dialog;
  }

  test("an acknowledged outlier carries the acknowledgement, and an ordinary amount does not", async () => {
    const onRecordApproved = vi.fn(noopAsync);
    const { unmount } = renderCockpit(wiring({ ...withAppraisal, onRecordApproved }));

    const dialog = openManual(150_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ApprovedAmountConfirmAction" }));

    // The server refuses an outlier without this, so the flag IS the answer
    // being carried across — not a note about what the screen displayed.
    await waitFor(() =>
      expect(onRecordApproved).toHaveBeenCalledWith(
        expect.objectContaining({ outlierAcknowledged: true })
      )
    );

    unmount();
    const onOrdinary = vi.fn(noopAsync);
    renderCockpit(wiring({ ...withAppraisal, onRecordApproved: onOrdinary }));
    const ordinary = openManual(14_000);
    fireEvent.click(within(ordinary).getByRole("button", { name: "RecordApprovedPurchaseAction" }));

    // Acknowledging a departure nobody was shown is the same as having no
    // guard: the flag must only ever answer a question that was asked.
    await waitFor(() =>
      expect(onOrdinary).toHaveBeenCalledWith(
        expect.objectContaining({ outlierAcknowledged: undefined })
      )
    );
  });

  test("changing the basis retires the question instead of leaving it on screen", () => {
    renderCockpit(wiring(withAppraisal));

    const dialog = openManual(150_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "RecordApprovedPurchaseAction" }));
    expect(within(dialog).getByText("ApprovedAmountFarFromEvidence")).toBeTruthy();

    // Only MANUAL can depart from anything — under APPRAISAL the amount IS one
    // of the reference figures. Leaving the confirmation pending offered to
    // confirm an amount nothing had been asked about.
    fireEvent.click(within(dialog).getByRole("radio", { name: /BasisAppraisal/ }));

    expect(within(dialog).queryByText("ApprovedAmountFarFromEvidence")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "ApprovedAmountConfirmAction" })
    ).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

/**
 * The step the rail names is a step the screen can take — SCRUM-78.
 *
 * The owner walked a real deal and found the cockpit announcing
 * "الخطوة التالية: تسليم المركبة" with nothing on the page that performs it.
 * Handover lived in `Finance Applications -> Review`, a screen the rail never
 * mentions, which is why the E2E stayed green while the workspace could not
 * finish a deal.
 */
describe("the stage the rail names carries its own action", () => {
  const awaitingHandover = dealFixture({
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "APPROVED_PURCHASE", state: "COMPLETE" },
      { key: "HANDOVER", state: "CURRENT" },
      { key: "SETTLEMENT", state: "PENDING" },
    ],
  });

  const handoverWiring = (overrides: Record<string, unknown> = {}) => ({
    confirming: false,
    submitting: false,
    error: null,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(noopAsync),
    ...overrides,
  });

  function renderAwaitingHandover(props: Record<string, unknown> = {}) {
    const handover = handoverWiring(
      (props.handover as Record<string, unknown> | undefined) ?? {}
    );
    render(
      <DealCockpitView
        deal={awaitingHandover}
        financeDecision={wiring({
          facts: {
            approvedPurchaseRecorded: true,
            approvedPurchaseAmountMinor: 150_000 * JOD,
            financeCompanyFundedPortionMinor: 127_500 * JOD,
            dealerContributionMinor: 22_500 * JOD,
          },
        })}
        workflowAction={{
          stageKey: "HANDOVER",
          actionKey: "RegisterHandoverAction",
          onStart: (props.onStart as () => void) ?? vi.fn(),
          unavailableReasonKey: props.unavailableReasonKey as string | undefined,
        }}
        handover={handover}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    return handover;
  }

  test("offers the handover action beside the step it names", () => {
    const onStart = vi.fn();
    renderAwaitingHandover({ onStart });

    const action = cardButton("RegisterHandoverAction");
    expect(action).toBeTruthy();
    fireEvent.click(action!);
    expect(onStart).toHaveBeenCalled();
  });

  test("a caller who cannot register it is told so, never left with silence", () => {
    renderAwaitingHandover({ unavailableReasonKey: "HandoverNeedsPermission" });

    // The defect this issue exists to remove: a named step with no button and
    // no reason. The button is correctly withheld; the reason must be there.
    expect(cardButton("RegisterHandoverAction")).toBeUndefined();
    expect(screen.getByText("HandoverNeedsPermission")).toBeTruthy();
  });

  test("the action is absent once handover is already complete", () => {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            { key: "APPLICATION", state: "COMPLETE" },
            { key: "HANDOVER", state: "COMPLETE" },
            { key: "SETTLEMENT", state: "CURRENT" },
          ],
        })}
        financeDecision={wiring()}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    expect(cardButton("RegisterHandoverAction")).toBeUndefined();
  });
});

describe("handover states the door it closes, with the figures to check", () => {
  const openDialog = (factOverrides: Record<string, unknown> = {}) => {
    const onSubmit = vi.fn(noopAsync);
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            { key: "APPLICATION", state: "COMPLETE" },
            { key: "HANDOVER", state: "CURRENT" },
          ],
          // The confirmation's figures come from the COCKPIT payload now, not
          // from `getEconomics` — a caller without `view:finance_applications`
          // never mounts that query, and used to get a blank confirmation over
          // a handover that sealed anyway.
          handoverEvidence: {
            approvedPurchaseAmountMinor: 150_000 * JOD,
            financeCompanyFundedPortionMinor: 127_500 * JOD,
            dealerContributionMinor: 22_500 * JOD,
            approvedAmountIsFarFromEvidence: false,
            currency: { code: "JOD", scale: 3 },
            ...factOverrides,
          },
        })}
        financeDecision={wiring({
          facts: {
            approvedPurchaseRecorded: true,
            approvedPurchaseAmountMinor: 150_000 * JOD,
            financeCompanyFundedPortionMinor: 127_500 * JOD,
            dealerContributionMinor: 22_500 * JOD,
          },
        })}
        workflowAction={{
          stageKey: "HANDOVER",
          actionKey: "RegisterHandoverAction",
          onStart: vi.fn(),
        }}
        handover={{
          confirming: true,
          submitting: false,
          onOpenChange: vi.fn(),
          onSubmit,
        }}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    return { dialog: screen.getByRole("dialog"), onSubmit };
  };

  test("warns that the approved amount can no longer be corrected", () => {
    const { dialog } = openDialog();
    expect(within(dialog).getByText("HandoverSealsApprovedAmount")).toBeTruthy();
    expect(within(dialog).getByText("HandoverVerifyBeforeContinuing")).toBeTruthy();
  });

  test("shows the amount and the split it asks the operator to verify", () => {
    // A confirmation that says "check the approved amount" without showing it
    // is asking someone to remember a number. The deal that prompted this
    // carried 150,000 against a 17,000 quotation, and this is the last screen
    // that would have shown it before the figure became permanent.
    const { dialog } = openDialog();
    expect(within(dialog).getByText(/150,000|150000/)).toBeTruthy();
    expect(within(dialog).getByText(/127,500|127500/)).toBeTruthy();
    expect(within(dialog).getByText(/22,500|22500/)).toBeTruthy();
  });

  test("still warns when the amount is withheld from this caller", () => {
    // `redactSettlementEvidence` hides the figure from weaker roles. The door
    // still closes for them, so removing the warning with the number would
    // take the safeguard away from exactly the callers least able to check.
    const { dialog } = openDialog({
      approvedPurchaseAmountMinor: null,
      financeCompanyFundedPortionMinor: null,
      dealerContributionMinor: null,
    });
    expect(within(dialog).getByText("HandoverSealsApprovedAmount")).toBeTruthy();
    expect(within(dialog).queryByText(/150,000|150000/)).toBeNull();
  });

  test("confirming sends the notes through to the caller", async () => {
    const { dialog, onSubmit } = openDialog();
    fireEvent.change(within(dialog).getByLabelText("HandoverNotesLabel"), {
      target: { value: "collected by the customer" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "ConfirmHandoverAction" }));

    // The payload carries the stamp the dialog was OPENED against, alongside
    // the notes. Not decoration: the server refuses a stamp that no longer
    // matches the deal, so a dialog that dropped this would be back to sealing
    // whatever happens to be on the deal at write time rather than what the
    // operator actually read.
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        notes: "collected by the customer",
        economicsStamp: STAMP,
      })
    );
  });
});

/**
 * The handover door consumes SCRUM-77's anomaly verdict; it never forms one.
 *
 * Required in review: the confirmation must not present a materially unusual
 * amount with ordinary visual weight, and must not introduce a second formula
 * for "unusual". `getEconomics` derives it with the same rule and the same
 * comparison appraisal that `approveDealerPurchaseAmount` refuses on, and the
 * dialog only renders that verdict.
 */
describe("a flagged amount does not look ordinary at the one-way door", () => {
  function openHandover(flagged: boolean, amountMinor: number | null = 150_000 * JOD) {
    render(
      <DealCockpitView
        deal={dealFixture({
          stages: [
            { key: "APPLICATION", state: "COMPLETE" },
            { key: "HANDOVER", state: "CURRENT" },
          ],
          handoverEvidence: {
            approvedPurchaseAmountMinor: amountMinor,
            financeCompanyFundedPortionMinor: 127_500 * JOD,
            dealerContributionMinor: 22_500 * JOD,
            approvedAmountIsFarFromEvidence: flagged,
            currency: { code: "JOD", scale: 3 },
          },
        })}
        financeDecision={wiring({
          approvedAmountIsFarFromEvidence: flagged,
          facts: {
            approvedPurchaseRecorded: true,
            approvedPurchaseAmountMinor: amountMinor,
            financeCompanyFundedPortionMinor: 127_500 * JOD,
            dealerContributionMinor: 22_500 * JOD,
          },
        })}
        workflowAction={{
          stageKey: "HANDOVER",
          actionKey: "RegisterHandoverAction",
          onStart: vi.fn(),
        }}
        handover={{
          confirming: true,
          submitting: false,
          onOpenChange: vi.fn(),
          onSubmit: vi.fn(noopAsync),
        }}
        onRecordSupplierReceipt={async () => {}}
      />
    );
    return screen.getByRole("dialog");
  }

  test("says in words that the amount was flagged, not by colour alone", () => {
    const dialog = openHandover(true);
    // Colour is not a message on its own, and is not available to every reader.
    expect(within(dialog).getByText("HandoverAmountLooksUnusual")).toBeTruthy();
  });

  test("an ordinary amount is not dressed up as a problem", () => {
    const dialog = openHandover(false);
    expect(within(dialog).queryByText("HandoverAmountLooksUnusual")).toBeNull();
    // ...and the door is still stated, because it still closes.
    expect(within(dialog).getByText("HandoverSealsApprovedAmount")).toBeTruthy();
  });

  test("a flagged amount never blocks the handover", () => {
    // The verdict changes emphasis only. An unusual amount can be exactly what
    // the finance company approved, and AutoFlow does not get to refuse it.
    const dialog = openHandover(true);
    const confirm = within(dialog).getByRole("button", { name: "ConfirmHandoverAction" });
    expect(confirm).toHaveProperty("disabled", false);
  });

  test("no verdict is shown where the amount itself is withheld", () => {
    // The server withholds the judgement with the figure: on its own it would
    // tell a caller something about a number the row deliberately hides.
    const dialog = openHandover(false, null);
    expect(within(dialog).queryByText("HandoverAmountLooksUnusual")).toBeNull();
    expect(within(dialog).getByText("HandoverSealsApprovedAmount")).toBeTruthy();
  });
});

/**
 * SCRUM-61 — the operator can take the step the cockpit names.
 *
 * A backend mutation alone does not close a cockpit dead end. Before these, a
 * legitimate MANUAL direct-to-supplier deal was told its supplier receipt amount
 * was missing and offered nothing that could record it: the approval action is
 * gated on a submitted quotation, and a MANUAL deal structurally never has one.
 *
 * These pin the VISIBLE control and WHICH WRITER it reaches, because "the
 * mutation exists" and "the operator can call it" are different facts and only
 * the second one closes the workflow.
 */
describe("SCRUM-61: the manual provider's supplier amount is reachable from the cockpit", () => {
  // Reuses the file's own `wiring()` builder rather than hand-rolling a fixture:
  // it merges `facts` instead of replacing them, and supplies the `calculation`
  // the quotation dialog needs. My first version rebuilt the object by hand and
  // rendered a card the case did not mean to assert about.
  function manualWiring(overrides: WiringOverrides = {}) {
    return wiring({ onRecordDirectSupplierAmount: noopAsync, ...overrides });
  }

  const manualDeal = () =>
    dealFixture({ approvedPurchaseWriter: "MANUAL_DIRECT_SUPPLIER_AMOUNT" });

  test("the action is offered, and it calls the MANUAL writer — not the configured approval", async () => {
    const calls: Array<{ approvedAmountMinor: number; source: string }> = [];
    const configuredApproval = vi.fn();

    renderCockpit(
      manualWiring({
        onRecordApproved: configuredApproval,
        onRecordDirectSupplierAmount: async (values: {
          approvedAmountMinor: number;
          source: string;
        }) => {
          calls.push(values);
        },
      }),
      manualDeal()
    );

    const action = cardButton("DirectSupplierAmountAction");
    expect(action).toBeDefined();
    fireEvent.click(action!);

    // 17,000 in a scale-3 currency. Typed, never prefilled.
    fireEvent.change(screen.getByLabelText("DirectSupplierAmountLabel"), {
      target: { value: "17000" },
    });
    fireEvent.change(screen.getByLabelText("DirectSupplierAmountSourceLabel"), {
      target: { value: "Signed purchase agreement" },
    });

    const submit = screen
      .queryAllByRole("button", { name: "DirectSupplierAmountAction" })
      .find((button) => button.closest('[role="dialog"]') !== null);
    expect(submit).toBeDefined();
    fireEvent.click(submit!);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].approvedAmountMinor).toBe(17_000_000);
    expect(calls[0].source).toBe("Signed purchase agreement");
    // The whole point: it must NOT reach the configured approval mutation, which
    // needs the quotation and company-rule workflow this deal cannot satisfy.
    expect(configuredApproval).not.toHaveBeenCalled();
  });

  test("without the amount typed, the dialog cannot be submitted", () => {
    renderCockpit(
      manualWiring({ onRecordDirectSupplierAmount: async () => {} }),
      manualDeal()
    );
    fireEvent.click(cardButton("DirectSupplierAmountAction")!);

    const submit = screen
      .queryAllByRole("button", { name: "DirectSupplierAmountAction" })
      .find((button) => button.closest('[role="dialog"]') !== null);
    expect(submit).toBeDefined();
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    // A source alone is not enough either — both halves are required, and the
    // server refuses each independently.
    fireEvent.change(screen.getByLabelText("DirectSupplierAmountSourceLabel"), {
      target: { value: "Signed purchase agreement" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  test("a CONFIGURED deal is not offered the manual action at all", () => {
    renderCockpit(
      manualWiring({ onRecordDirectSupplierAmount: async () => {} }),
      dealFixture({ approvedPurchaseWriter: "CONFIGURED_APPROVAL" })
    );
    expect(cardButton("DirectSupplierAmountAction")).toBeUndefined();
  });

  // Withheld, EXPLAINED — never silently absent. Each mirrors a refusal the
  // server enforces, so the operator learns why rather than concluding the
  // screen is broken.
  for (const [label, overrides, reasonKey] of [
    ["without the permission", { canRecordApproval: false }, "DirectSupplierAmountNeedsPermission"],
    ["on their own deal", { isOwnDeal: true }, "DirectSupplierAmountOwnDeal"],
    [
      "after handover",
      { facts: { handedOver: true } },
      "DirectSupplierAmountSealed",
    ],
    ["once closed", { facts: { closed: true } }, "DirectSupplierAmountClosed"],
  ] as const) {
    test(`${label}, the action is withheld and the reason is shown`, () => {
      renderCockpit(
        manualWiring({ ...overrides, onRecordDirectSupplierAmount: async () => {} }),
        manualDeal()
      );
      expect(cardButton("DirectSupplierAmountAction")).toBeUndefined();
      expect(screen.getByText(reasonKey)).toBeTruthy();
    });
  }
});
