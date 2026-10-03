/**
 * The workflow TAIL on the cockpit — handover, expected payment, close.
 *
 * SCRUM-78: the stage rail named `تسليم المركبة` as the next step and the screen
 * contained nothing that performed it. All three tail actions lived only in
 * `Finance Applications → row → Review`, a screen the rail never mentions, which
 * is also why the financed E2E stayed green while the cockpit could not take a
 * single one of them.
 *
 * These are CONTAINER tests, not view tests. `FinanceCompanyDecision.test.tsx`
 * hands `DealCockpitView` a `workflowAction` fixture, so it proves what the
 * next-step block does with an answer and nothing about how the answer is
 * chosen — and the choosing is where this issue's defects live: which of three
 * separate permissions gates which step, which step is offered when, and whether
 * a retried close is the same close.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  const en = dictionaries.en as Record<string, string>;
  return {
    // Identity `t`, so a missing translation surfaces as its key rather than
    // silently rendering something plausible. The one exception is a closing-readiness
    // REASON: the list swaps a reason key with no translation for a generic line
    // (SCRUM-420 S420-01), so identity there would test the fallback, not the code.
    useLanguage: () => ({
      t: (key: string) => (key.startsWith("ClosingReason_") ? (en[key] ?? key) : key),
      isRtl: false,
      locale: "en",
    }),
  };
});

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    scale: 3,
  }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  permissions: new Set<string>(),
  /** Every mutation call this render made: name → the list of args it got. */
  mutationCalls: new Map<string, unknown[]>(),
  /** Names whose next call should reject, and with what (a string becomes an Error). */
  mutationFailures: new Map<string, string | Error>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_sales" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const resultOf = (reference: never) => stubs.queryResults.get(getFunctionName(reference));
  return {
    // As the real hook does: an Error result THROWS during render.
    useQuery: (reference: never) => {
      const result = resultOf(reference);
      if (result instanceof Error) throw result;
      return result;
    },
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(Object.entries(queries).map(([key, { query }]) => [key, resultOf(query)])),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
        const failure = stubs.mutationFailures.get(name);
        if (failure !== undefined) {
          stubs.mutationFailures.delete(name);
          throw typeof failure === "string" ? new Error(failure) : failure;
        }
        return null;
      };
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ConvexError } from "convex/values";
import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { WITHHELD_READINESS_REASON_FALLBACK } from "@/lib/closingReadinessReasonCodes";
import { dictionaries } from "@/lib/i18n/dictionaries";

const WITHHELD_COSTS_CLOSABLE_EN = (dictionaries.en as Record<string, string>).ClosingReason_WITHHELD_COSTS_CLOSABLE;

const { queryResults, permissions, mutationCalls, mutationFailures } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;

const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const HANDOVER_MUTATION = "applications:registerVehicleHandover";
const EXPECTED_PAYMENT_MUTATION = "applications:registerExpectedPayment";
const FINALIZE_MUTATION = "applications:finalizeDeal";

/**
 * The rail as the server draws it at each point in the tail.
 *
 * Written as the real five-state shape rather than a two-state stand-in: the
 * step after handover is a BLOCKED settlement stage, and an action attached to a
 * stage the rail reports as merely PENDING would never render.
 */
function stages(point: "AWAITING_HANDOVER" | "AFTER_HANDOVER") {
  return point === "AWAITING_HANDOVER"
    ? [
        { key: "APPROVED_PURCHASE", state: "COMPLETE" },
        { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
        { key: "HANDOVER", state: "CURRENT" },
        { key: "SETTLEMENT", state: "PENDING" },
      ]
    : [
        { key: "APPROVED_PURCHASE", state: "COMPLETE" },
        { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
        { key: "HANDOVER", state: "COMPLETE" },
        { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement" },
      ];
}

function cockpit(overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
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
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages: stages("AWAITING_HANDOVER"),
    documents: [],
    timeline: [],
    money: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  mutationCalls.clear();
  mutationFailures.clear();
});

/**
 * The close is offered only once `applications.get` has answered — its
 * refusal reason and the route control it points at read from that payload,
 * so a still-loading `app` keeps the step at its blocker. These tests are
 * about the tail's permissions and ordering, not about loading, so the
 * application payload is present unless a case says otherwise.
 */
function renderCockpit() {
  if (!queryResults.has("applications:get")) {
    queryResults.set("applications:get", {
      _id: APP,
      quoteId: "quote_1",
      status: "APPROVED",
      salespersonId: "user_other",
      companyId: "company_1",
      economicsCurrency: "JOD",
      quote: { totalFinancedAmount: 15000 },
      vehicle: { sourceType: "OWNED" },
      deposits: [],
      hasExternalFinancier: true,
      canSettleDirectToSupplier: false,
      directRouteRefusal: null,
    });
  }
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

/**
 * The next-step block, scoped.
 *
 * Every stage name appears twice on this screen — once on the rail, once in the
 * block that names the current step — so a global `getByText("StageHandover")`
 * either throws on the duplicate or, worse, passes against the rail row while
 * the block that is supposed to carry the action says nothing.
 */
function nextStepBlock(): HTMLElement {
  return screen.getByTestId("deal-next-step");
}

/** The whole tail, so a case can subtract exactly the one it is testing. */
function grantTheWholeTail() {
  permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
  permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
  permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
  // SCRUM-407: the close itself is an accountant's act.
  permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
}

/**
 * The close's own precondition (S414-R2-SKEW-1 / S414-R3-1): the cockpit offers
 * and submits it only on a LOADED, open READY verdict, so a case that takes the
 * close reads the readiness and has it READY. Every default template holding
 * `confirm:finance_disbursement` also holds `view:finance_applications`.
 */
function readyToClose() {
  grantTheWholeTail();
  permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
  queryResults.set("applications:getClosingReadiness", readinessVerdict("READY"));
}

/** The closing-readiness verdict as `applications.getClosingReadiness` returns it. */
function readinessVerdict(state: "READY" | "BLOCKED" | "UNAVAILABLE") {
  return {
    state,
    open: true,
    checks: [{ key: "CUSTODY_SETTLED", status: state === "READY" ? "READY" : state, reason: null }],
    unavailableReason: null,
    moneyWithheld: false,
  };
}

/**
 * The refusal a pre-SCRUM-414 `finalizeDeal` throws on currency drift, in plain
 * English. Realistic for these fixtures: the application is pinned to JOD and
 * the organization has since moved to SAR, while the org-settings read the
 * local denomination guard compares against has not answered — `useCurrency`
 * falls back to JOD, so that guard does not fire and only the readiness gate
 * stands between this sentence and a caller without money-read authority.
 */
const OLD_BACKEND_DRIFT_REFUSAL =
  "This deal's figures were recorded in JOD, but the organization's currency is now SAR. A deal is finalized in the currency its figures were recorded in — restore the organization's currency to JOD before finalizing it.";

describe("the step the rail names is a step this screen can take", () => {
  test("handover is offered on the stage the rail is naming", () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit());

    renderCockpit();

    // The defect verbatim: the block said HANDOVER and offered nothing. Both
    // halves are asserted on the SAME block, because "the rail names it" and
    // "the screen can do it" being true of different elements is exactly the
    // state the owner hit.
    const block = nextStepBlock();
    expect(within(block).getByText("StageHandover")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "RegisterHandoverAction" })).toBeTruthy();
  });

  test("the expected payment is offered once the vehicle has gone out", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );

    renderCockpit();

    expect(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeTruthy();
    // Not both at once: the server refuses a close with no expected payment, so
    // offering it here would be offering a guaranteed refusal.
    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
  });

  test.each([
    ["chequeNeedsCorrection"],
    ["chequeNeedsAccountingReview"],
  ])("the register step is withheld while %s is raised, and offered when it is not", (flag) => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false, [flag]: true })
    );
    renderCockpit();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
    cleanup();

    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false, [flag]: false })
    );
    renderCockpit();
    expect(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeTruthy();
  });

  test("closing is offered only once the payment fact the server demands is on file", () => {
    readyToClose();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();

    expect(screen.getByRole("button", { name: "FinalizeDealAction" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
  });

  test("nothing in the tail is offered on a deal that is already closed", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        status: "CLOSED",
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
      })
    );

    renderCockpit();

    // `finalizeDeal` answers a closed deal by returning the sale it already
    // made. A button for that is an invitation to wonder whether it worked.
    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
  });
});

describe("a step the server would refuse is not offered as a step", () => {
  test("the close is withheld while the settlement route is outstanding, and says so", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
        // A consigned car with an external financier and no route recorded —
        // the ordinary shape of a consigned financed deal. `finalizeDeal` is
        // certain to reject it, and the operator only gets here AFTER handover
        // has sealed the approved amount.
        supplierSettlementRouteRequired: true,
      })
    );

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    // The prerequisite, not the permission: this caller holds every permission
    // in the tail and still cannot close, so naming the permission would be
    // true and useless.
    expect(within(block).getByText("FinalizeNeedsSettlementRoute")).toBeTruthy();
    expect(within(block).queryByText("FinalizeNeedsPermission")).toBeNull();
  });

  test("a caller who can neither record the route nor close is not sent to look for it", () => {
    // No FINALIZE_FINANCED_DEAL, and the route is missing too.
    //
    // `setSupplierSettlementRoute` takes `finalize:financed_deal`, and the
    // review dialog hides its selector without it — so "record the route in
    // Review" would send this caller to a screen with nothing on it. Two
    // individually correct sentences rebuilding the dead end between them.
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
        supplierSettlementRouteRequired: true,
      })
    );

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).getByText("FinalizeNeedsRouteAndPermission")).toBeTruthy();
    expect(within(block).queryByText("FinalizeNeedsSettlementRoute")).toBeNull();
    expect(within(block).queryByText("FinalizeNeedsPermission")).toBeNull();
  });

  // CodeRabbit #352: `finalizeDeal` re-runs the readiness evaluator, so a loaded
  // verdict that is not READY is a guaranteed refusal — not a step.

  test.each(["BLOCKED", "UNAVAILABLE"] as const)(
    "the close is withheld while closing readiness is %s, and says so",
    (state) => {
      grantTheWholeTail();
      queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));
      // A caller who may read the readiness; without it the query is skipped.
      permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
      queryResults.set("applications:getClosingReadiness", readinessVerdict(state));

      renderCockpit();

      const block = nextStepBlock();
      expect(within(block).queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
      expect(within(block).getByText("FinalizeNeedsClosingReadiness")).toBeTruthy();
    }
  );

  test("the close is offered once closing readiness is READY (control)", () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set("applications:getClosingReadiness", readinessVerdict("READY"));

    renderCockpit();

    expect(within(nextStepBlock()).getByRole("button", { name: "FinalizeDealAction" })).toBeTruthy();
    expect(within(nextStepBlock()).queryByText("FinalizeNeedsClosingReadiness")).toBeNull();
  });

  test("on a loaded READY verdict the close is offered AND submits (control)", async () => {
    readyToClose();
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));

    renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "FinalizeDealAction" }));
    const confirm = await screen.findByRole("button", { name: /ConfirmFinalizeAction/ });

    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mutationCalls.get(FINALIZE_MUTATION)).toHaveLength(1));
  });

  // S414-R2-SKEW-1: the close is offered only after a READY verdict has LOADED.
  // A read still in flight is not a failure, so no "could not be checked"
  // sentence either — the step waits at its blocker, as it does for `app`.
  test("while the readiness read is in flight the close is not offered yet", () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);

    const { rerender } = renderCockpit();

    expect(screen.getByTestId("closing-readiness-loading")).toBeTruthy();
    expect(within(nextStepBlock()).queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(screen.queryByText("FinalizeWaitsForReadiness")).toBeNull();

    queryResults.set("applications:getClosingReadiness", readinessVerdict("READY"));
    rerender(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(within(nextStepBlock()).getByRole("button", { name: "FinalizeDealAction" })).toBeTruthy();
  });
});

/**
 * S414-R3-1 (Codex) = the remainder of S414-R2-SKEW-1 (Sol), Option A.
 *
 * Invariant: the cockpit offers AND submits Finalize only while it holds a
 * successfully loaded, open READY verdict, so an older backend's detailed
 * refusal can never reach a caller without money-read authority through it.
 * Two paths broke it at 368162d11: a closer who cannot read the readiness (the
 * query is skipped, so nothing ever "loads"), and a dialog opened on READY that
 * stayed submittable after the verdict turned.
 */
describe("the close needs a loaded READY verdict — to be offered and to be submitted", () => {
  test("a custom closer who cannot read the readiness is told why, and never reaches finalize", async () => {
    vi.mocked(toast.error).mockClear();
    // A custom role: may see the deal and close it, may NOT read the finance
    // application (no view:finance_applications, no view:finance), so the
    // readiness query is skipped. No route or denomination blocker.
    permissions.add(PERMISSIONS.VIEW_SALES);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));
    mutationFailures.set(FINALIZE_MUTATION, new ConvexError(OLD_BACKEND_DRIFT_REFUSAL));

    renderCockpit();
    const block = nextStepBlock();

    // Taken exactly as an operator would if it were offered, so a regression
    // shows the leak, not just a missing sentence.
    const offered = within(block).queryByRole("button", { name: "FinalizeDealAction" });
    if (offered) {
      fireEvent.click(offered);
      fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    }
    expect(document.body.textContent).not.toMatch(/JOD|SAR/);
    expect(toast.error).not.toHaveBeenCalled();
    expect(mutationCalls.get(FINALIZE_MUTATION)).toBeUndefined();
    expect(offered).toBeNull();
    expect(within(block).getByText("FinalizeNeedsReadinessAccess")).toBeTruthy();
    expect(within(block).queryByText("FinalizeNeedsPermission")).toBeNull();
  });

  test("a caller lacking BOTH the close and the readiness read is told about the close first", () => {
    permissions.add(PERMISSIONS.VIEW_SALES);
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));

    renderCockpit();

    expect(within(nextStepBlock()).getByText("FinalizeNeedsPermission")).toBeTruthy();
    expect(within(nextStepBlock()).queryByText("FinalizeNeedsReadinessAccess")).toBeNull();
  });

  test("the route is still named before the readiness access", () => {
    permissions.add(PERMISSIONS.VIEW_SALES);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true, supplierSettlementRouteRequired: true })
    );

    renderCockpit();

    expect(within(nextStepBlock()).getByText("FinalizeNeedsSettlementRoute")).toBeTruthy();
    expect(within(nextStepBlock()).queryByText("FinalizeNeedsReadinessAccess")).toBeNull();
  });

  test.each([
    {
      turn: "the read fails",
      verdict: (): unknown =>
        new Error(
          "[CONVEX Q(applications:getClosingReadiness)] Could not find public function for 'applications:getClosingReadiness'."
        ),
      reason: "FinalizeWaitsForReadiness",
    },
    {
      turn: "the verdict turns BLOCKED",
      verdict: (): unknown => readinessVerdict("BLOCKED"),
      reason: "FinalizeNeedsClosingReadiness",
    },
  ])("a dialog opened on READY cannot submit once $turn", async ({ verdict, reason }) => {
    vi.mocked(toast.error).mockClear();
    readyToClose();
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true }));
    mutationFailures.set(FINALIZE_MUTATION, new ConvexError(OLD_BACKEND_DRIFT_REFUSAL));

    const { rerender } = renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "FinalizeDealAction" }));
    const dialog = await screen.findByRole("dialog");
    const openConfirm = within(dialog).getByRole("button", { name: /ConfirmFinalizeAction/ });
    expect((openConfirm as HTMLButtonElement).disabled).toBe(false);

    // The verdict turns while the dialog is open.
    queryResults.set("applications:getClosingReadiness", verdict());
    rerender(<DealCockpit orgId={ORG} applicationId={APP} />);

    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: /ConfirmFinalizeAction/ });
    fireEvent.click(confirm);
    // Give a submit that slipped through the time to reach the stub and surface.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutationCalls.get(FINALIZE_MUTATION)).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/JOD|SAR/);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole("dialog")).getByText(reason)).toBeTruthy();
  });
});

describe("the appraisal-gap stage", () => {
  /**
   * SCRUM-83, and this block used to assert the opposite.
   *
   * A finance company approving BELOW the quotation — the ordinary case, and the
   * whole reason an appraisal gap exists — left `gapResolution` at
   * PENDING_NEGOTIATION with nothing in the product able to write the values
   * that resolve it. The rail is strictly sequential, so that stage hid
   * handover, settlement and every action after it. This suite pinned that dead
   * end deliberately so it could not be "fixed" by quietly treating
   * PENDING_NEGOTIATION as resolved.
   *
   * It is now fixed the other way: the stage has a real action
   * (`resolveAppraisalGap`), and the blocked state is still not softened. The
   * assertions are the SAME contract read forward — the blocker text stays, and
   * the step is offered rather than explained away.
   */
  const GAP_MONEY = {
    currency: "JOD",
    settlesDirectToSupplier: false,
    routeKnown: true,
    profit: { available: false, reason: "NoSupplierSettlement" },
    expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
    parties: [],
    // The shortfall travels with the other AMOUNTS, under the same gate as the
    // rest of the money — the stage rail is deliberately qualitative.
    appraisalGapMinor: 1_000_000,
  };
  const GAP_STAGES = [
    { key: "APPRAISAL", state: "COMPLETE" },
    { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "GapUnresolved" },
    { key: "HANDOVER", state: "PENDING" },
    { key: "SETTLEMENT", state: "PENDING" },
  ];
  const GAP_MUTATION = "financingEconomics:resolveAppraisalGap";
  const ECONOMICS_QUERY = "financingEconomics:getEconomics";

  /** The economics row the cockpit reads the recorded figures from. */
  function economicsRow(overrides: Record<string, unknown> = {}) {
    return {
      application: {
        _id: APP,
        status: "APPROVED",
        salespersonId: "user_other",
        economicsCurrency: "JOD",
        submittedQuotationMinor: 12_500_000,
        approvedDealerPurchaseAmountMinor: 11_500_000,
        rawAppraisalGapMinor: 1_000_000,
        gapResolution: "PENDING_NEGOTIATION",
        financeCompanyFundedPortionMinor: 9_775_000,
        unfinancedPortionMinor: 1_725_000,
        dealerContributionMinor: 1_225_000,
        appliedLtvPercent: 85,
        ...overrides,
      },
      appraisals: [],
      overrides: [],
      approvedAmountIsFarFromEvidence: false,
    };
  }

  function gapDeal(overrides: Record<string, unknown> = {}) {
    return cockpit({ stages: GAP_STAGES, money: GAP_MONEY, economicsStamp: "v2|7", ...overrides });
  }

  test("offers the resolution action, without softening the blocked state", () => {
    grantTheWholeTail();
    // Granted SEPARATELY from the tail's own permissions on purpose: agreeing
    // who covers a shortfall is the approval authority, not the handover one.
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal());

    renderCockpit();

    const block = nextStepBlock();
    // The blocker itself still says the gap is unresolved — true until somebody
    // records who covers the shortfall, and the action is how they do that.
    expect(within(block).getByText("BlockerGapUnresolved")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "ResolveGapAction" })).toBeTruthy();
    // The old dead-end explanation is gone, because it is no longer true.
    expect(within(block).queryByText("GapResolutionUnavailable")).toBeNull();
  });

  test("withholds the action from a caller whose money is withheld, and names THAT obstacle", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    // The permission is GRANTED, so the only thing missing is the money.
    queryResults.set(COCKPIT_QUERY, gapDeal({ money: null }));

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "ResolveGapAction" })).toBeNull();
    expect(within(block).getByText("GapResolutionNeedsDealFigures")).toBeTruthy();
    expect(within(block).queryByText("GapResolutionNeedsPermission")).toBeNull();
  });

  test("a caller without the approval permission is told THAT, not something else", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    // NOT granting APPROVE_FINANCE_APPLICATION; the money IS visible.
    queryResults.set(COCKPIT_QUERY, gapDeal());

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "ResolveGapAction" })).toBeNull();
    expect(within(block).getByText("GapResolutionNeedsPermission")).toBeTruthy();
    expect(within(block).queryByText("GapResolutionNeedsDealFigures")).toBeNull();
    expect(within(block).queryByText("GapResolutionSealed")).toBeNull();
  });

  test("the salesperson is not offered the resolution on their own deal", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal());
    // The harness's caller is `user_sales`; make the deal theirs.
    queryResults.set("applications:get", {
      _id: APP,
      quoteId: "quote_1",
      status: "APPROVED",
      salespersonId: "user_sales",
      companyId: "company_1",
      economicsCurrency: "JOD",
      quote: { totalFinancedAmount: 15000 },
      vehicle: { sourceType: "OWNED" },
      deposits: [],
      hasExternalFinancier: true,
      canSettleDirectToSupplier: false,
      directRouteRefusal: null,
    });

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "ResolveGapAction" })).toBeNull();
    expect(within(block).getByText("GapResolutionSelfDeal")).toBeTruthy();
  });

  test("a CLOSED deal is not offered a gap resolution the server would refuse", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal({ status: "CLOSED" }));

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "ResolveGapAction" })).toBeNull();
    expect(within(block).getByText("GapResolutionSealed")).toBeTruthy();
  });

  /**
   * The handover seal and its one exception (SCRUM-116), keyed on the same two
   * timestamps the mutation compares. Handover now refuses an unsettled gap at
   * the server, so a gap still open after the vehicle went out is either a row
   * the handover already stamped (sealed — a repair decision) or one created by
   * the first approval recorded AFTER handover, which must be offered: it is
   * what finalization is waiting on, and nothing else can settle it.
   */
  const HANDED_OVER_STAGES = [
    { key: "APPRAISAL", state: "COMPLETE" },
    { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "GapUnresolved" },
    { key: "HANDOVER", state: "COMPLETE" },
    { key: "SETTLEMENT", state: "PENDING" },
  ];
  function handedOverApp(overrides: Record<string, unknown>) {
    return {
      _id: APP,
      quoteId: "quote_1",
      status: "APPROVED",
      salespersonId: "user_other",
      companyId: "company_1",
      economicsCurrency: "JOD",
      quote: { totalFinancedAmount: 15000 },
      vehicle: { sourceType: "OWNED" },
      deposits: [],
      hasExternalFinancier: true,
      canSettleDirectToSupplier: false,
      directRouteRefusal: null,
      ...overrides,
    };
  }

  test("a handed-over deal whose gap the handover already stamped is not offered a resolution", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal({ stages: HANDED_OVER_STAGES }));
    // Approved first, handed over afterwards: the pre-gate shape.
    queryResults.set(
      "applications:get",
      handedOverApp({ approvedPurchaseApprovedAt: 1_000, vehicleHandoverAt: 2_000 })
    );

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "ResolveGapAction" })).toBeNull();
    expect(within(block).getByText("GapResolutionSealed")).toBeTruthy();
  });

  test("a gap created by an approval recorded AFTER handover IS offered the resolution (SCRUM-116)", () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal({ stages: HANDED_OVER_STAGES }));
    queryResults.set(
      "applications:get",
      handedOverApp({ vehicleHandoverAt: 1_000, approvedPurchaseApprovedAt: 2_000 })
    );

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).getByRole("button", { name: "ResolveGapAction" })).toBeTruthy();
    expect(within(block).queryByText("GapResolutionSealed")).toBeNull();
  });

  test("the dialog shows the recorded quotation, the approved amount and the exact gap, and records a customer-absorbs split against the stamp the screen was opened with", async () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, gapDeal());
    queryResults.set(ECONOMICS_QUERY, economicsRow());

    renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "ResolveGapAction" }));
    const dialog = screen.getByRole("dialog");

    // The three figures, from the SERVER's row — never derived on this side.
    const figures = within(dialog).getByTestId("gap-figures");
    expect(figures.textContent).toContain("12,500");
    expect(figures.textContent).toContain("11,500");
    expect(within(dialog).getByTestId("gap-amount").textContent).toContain("1,000");

    // Customer absorbs (default): nothing to type for the share; the three
    // destinations must each be decided — blank is not zero.
    const submit = within(dialog).getByRole("button", { name: "ResolveGapAction" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getByTestId("gap-readiness").textContent).toBe("GapDestinationsIncomplete");
    fireEvent.change(within(dialog).getByLabelText("GapCashToDealer"), { target: { value: "700" } });
    fireEvent.change(within(dialog).getByLabelText("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(within(dialog).getByLabelText("GapToFinanceCompany"), { target: { value: "300" } });
    expect(within(dialog).getByTestId("gap-readiness").textContent).toBe("GapAllocationComplete");
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(mutationCalls.get(GAP_MUTATION)).toHaveLength(1));
    expect(mutationCalls.get(GAP_MUTATION)?.[0]).toEqual({
      orgId: ORG,
      applicationId: APP,
      economicsStamp: "v2|7",
      customerGapShareMinor: 1_000_000,
      dealerGapShareMinor: 0,
      customerGapCashToDealerMinor: 700_000,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 300_000,
      notes: undefined,
    });
  });

  test("dealer absorbs all: no customer part, no destinations to place, zeros sent by arithmetic", async () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal());

    renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "ResolveGapAction" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /GapDealerAbsorbs/ }));
    expect(within(dialog).queryByLabelText("GapCashToDealer")).toBeNull();
    const submit = within(dialog).getByRole("button", { name: "ResolveGapAction" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(mutationCalls.get(GAP_MUTATION)).toHaveLength(1));
    expect(mutationCalls.get(GAP_MUTATION)?.[0]).toMatchObject({
      customerGapShareMinor: 0,
      dealerGapShareMinor: 1_000_000,
      customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
    });
  });

  test("a split: the customer's part is typed, the dealership's is derived, and destinations that do not add up keep the button dead", async () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal());

    renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "ResolveGapAction" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /^GapSplit/ }));
    fireEvent.change(within(dialog).getByLabelText("GapCustomerShare"), { target: { value: "600" } });
    expect(within(dialog).getByText("GapDealerShare").parentElement?.textContent).toContain("400");
    fireEvent.change(within(dialog).getByLabelText("GapCashToDealer"), { target: { value: "500" } });
    fireEvent.change(within(dialog).getByLabelText("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(within(dialog).getByLabelText("GapToFinanceCompany"), { target: { value: "0" } });
    const submit = within(dialog).getByRole("button", { name: "ResolveGapAction" }) as HTMLButtonElement;
    // 500 ≠ 600: the shared identity refuses, and the reason is named.
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getByTestId("gap-readiness").textContent).toBe("GapAllocationMismatch");
    fireEvent.change(within(dialog).getByLabelText("GapInstallmentsToDealer"), { target: { value: "100" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(mutationCalls.get(GAP_MUTATION)).toHaveLength(1));
    expect(mutationCalls.get(GAP_MUTATION)?.[0]).toMatchObject({
      customerGapShareMinor: 600_000,
      dealerGapShareMinor: 400_000,
      customerGapCashToDealerMinor: 500_000,
      customerGapInstallmentToDealerMinor: 100_000,
      customerGapToFinanceCompanyMinor: 0,
    });
  });

  test("the server's refusal is shown in the dialog, which stays open", async () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE);
    queryResults.set(COCKPIT_QUERY, gapDeal());
    mutationFailures.set(GAP_MUTATION, "This deal's figures changed while you were agreeing the split.");

    renderCockpit();
    fireEvent.click(within(nextStepBlock()).getByRole("button", { name: "ResolveGapAction" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /GapDealerAbsorbs/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ResolveGapAction" }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain("figures changed")
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("does not offer handover from behind the blocked gap", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        stages: [
          { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "GapUnresolved" },
          { key: "HANDOVER", state: "PENDING" },
          { key: "SETTLEMENT", state: "PENDING" },
        ],
      })
    );

    renderCockpit();

    // The rail names the gap, so the gap is what the block answers for. Jumping
    // the queue would be this screen overruling the rail about the deal's
    // shape, which is the drift the whole cockpit exists to prevent.
    expect(screen.queryByRole("button", { name: "RegisterHandoverAction" })).toBeNull();
  });
});

describe("three permissions, not one", () => {
  test("a caller who may hand over but not register the payment is told, at each step", () => {
    // Exactly one of the three. Gating the tail on a single flag would either
    // hide the step this caller is entitled to take or offer the two they are
    // not.
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(COCKPIT_QUERY, cockpit());

    const { unmount } = renderCockpit();
    expect(screen.getByRole("button", { name: "RegisterHandoverAction" })).toBeTruthy();
    unmount();

    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );
    renderCockpit();

    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
    // Silence here is the dead end this issue exists to remove.
    expect(within(nextStepBlock()).getByText("ExpectedPaymentNeedsPermission")).toBeTruthy();
  });

  test("a caller who may register the payment but not close is told why closing is missing", () => {
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();

    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(within(nextStepBlock()).getByText("FinalizeNeedsPermission")).toBeTruthy();
  });

  // SCRUM-407 owner ruling: finalizing a financed deal is for accountants
  // only. `finalize:financed_deal` alone — what the default SALES template
  // holds — no longer offers the close; the server refuses it the same way.
  test("a caller holding finalize:financed_deal but not the accountant's permission is not offered the close", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();

    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(within(nextStepBlock()).getByText("FinalizeNeedsPermission")).toBeTruthy();
  });
});

describe("the mutations behind the buttons", () => {
  test("handover goes through the existing mutation, with no second write path", async () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit());

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "RegisterHandoverAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmHandoverAction/ }));

    await waitFor(() => {
      expect(mutationCalls.get(HANDOVER_MUTATION)).toEqual([
        { orgId: ORG, applicationId: APP, notes: undefined },
      ]);
    });
  });

  test("the expected payment carries the method and the date the form collected", async () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => {
      const calls = mutationCalls.get(EXPECTED_PAYMENT_MUTATION) ?? [];
      expect(calls).toHaveLength(1);
    });
    const [call] = mutationCalls.get(EXPECTED_PAYMENT_MUTATION) as Array<Record<string, unknown>>;
    expect(call.orgId).toBe(ORG);
    expect(call.applicationId).toBe(APP);
    // The form's own default. Asserted so a change to it is a decision rather
    // than a surprise arriving at a mutation that writes a cheque record.
    expect(call.method).toBe("BANK_TRANSFER");
    expect(typeof call.expectedDate).toBe("number");
  });

  test("a retried close is the SAME close — one idempotency key, reused", async () => {
    readyToClose();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );
    // The first attempt is refused the way the server refuses a real one: with
    // a message naming what to change. The operator fixes nothing and simply
    // tries again — the case a fresh key per click turns into two sales.
    mutationFailures.set(FINALIZE_MUTATION, "Record the settlement route before finalizing.");

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));

    const confirm = await screen.findByRole("button", { name: /ConfirmFinalizeAction/ });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(1);
    });
    // The refusal is kept on the dialog, not only in a toast that has gone by
    // the time the operator looks back.
    expect(await screen.findByText(/Record the settlement route/)).toBeTruthy();

    fireEvent.click(confirm);
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(2);
    });

    const calls = mutationCalls.get(FINALIZE_MUTATION) as Array<Record<string, unknown>>;
    expect(calls[0].idempotencyKey).toBeTruthy();
    // A second sale, a second set of journals and a second inventory movement
    // for one car is what a fresh key on retry buys.
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
  });

  // SCRUM-414 R1: below the finance tier a refused close carries only a
  // WITHHELD_* code and the generic fallback; the toast and the dialog show the
  // code's own translation, never the fallback English.
  test("a withheld finalize refusal is shown as its translated WITHHELD code", async () => {
    readyToClose();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );
    mutationFailures.set(
      FINALIZE_MUTATION,
      new ConvexError({ code: "WITHHELD_COSTS_CLOSABLE", message: WITHHELD_READINESS_REASON_FALLBACK })
    );

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(WITHHELD_COSTS_CLOSABLE_EN);
    });
    expect(await screen.findByText(WITHHELD_COSTS_CLOSABLE_EN)).toBeTruthy();
    expect(screen.queryByText(WITHHELD_READINESS_REASON_FALLBACK)).toBeNull();
  });

  // SCRUM-414 Codex R2 kept the tail alive on a backend without the readiness
  // query; S414-R2-SKEW-1 (Sol) is why the close is NOT offered there. Such a
  // backend predates the redacted refusals, so its `finalizeDeal` names both
  // currencies in plain English — to a MANAGER who may close but not read
  // money. The close waits for a verdict that loaded; every other step stays.
  test("a backend without the readiness query withholds the close, says why, and never reaches finalize", async () => {
    vi.mocked(toast.error).mockClear();
    grantTheWholeTail();
    // A caller who reads the readiness, so the missing query IS subscribed —
    // and no finance-read tier: the MANAGER template's combination.
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );
    queryResults.set(
      "applications:getClosingReadiness",
      new Error(
        "[CONVEX Q(applications:getClosingReadiness)] Could not find public function for 'applications:getClosingReadiness'."
      )
    );
    // The refusal a pre-SCRUM-414 `finalizeDeal` throws on currency drift —
    // app pinned JOD, org now SAR (see OLD_BACKEND_DRIFT_REFUSAL).
    mutationFailures.set(FINALIZE_MUTATION, new ConvexError(OLD_BACKEND_DRIFT_REFUSAL));

    renderCockpit();

    // The panel says the read failed; the deal screen itself is intact.
    expect(screen.getByTestId("closing-readiness-service-unavailable")).toBeTruthy();
    const block = nextStepBlock();

    // If a close were offered anyway, take it exactly as an operator would, so
    // a regression shows the leak rather than only a missing sentence.
    const offered = within(block).queryByRole("button", { name: "FinalizeDealAction" });
    if (offered) {
      fireEvent.click(offered);
      fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    }
    // Neither currency of the old refusal is anywhere on the screen or in a toast.
    expect(document.body.textContent).not.toMatch(/JOD|SAR/);
    expect(toast.error).not.toHaveBeenCalled();
    expect(mutationCalls.get(FINALIZE_MUTATION)).toBeUndefined();
    expect(offered).toBeNull();
    expect(within(block).getByText("FinalizeWaitsForReadiness")).toBeTruthy();
    expect(within(block).queryByText("FinalizeNeedsClosingReadiness")).toBeNull();
  });

  test("a close that succeeded does not lend its key to the next one", async () => {
    readyToClose();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(1);
    });

    // Reopened and run again — a different operation, which must not be
    // answered out of the first one's idempotency record.
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(2);
    });

    const calls = mutationCalls.get(FINALIZE_MUTATION) as Array<Record<string, unknown>>;
    expect(calls[1].idempotencyKey).not.toBe(calls[0].idempotencyKey);
  });
});

describe("SCRUM-447 finance-company cheque panel wiring in the cockpit", () => {
  const FC_PANEL = {
    chequePaymentRegistered: true,
    chequeNeedsCorrection: false,
    chequeNeedsAccountingReview: false,
    chequeFaceAttested: false,
    chequeFaceUnrecorded: true,
    unattestedChequeId: "cheque_1",
    expectedPaymentCorrectable: false,
    expectedPaymentReRegistrable: false,
  };

  test("an attest with no unattested cheque to write to stays open and reports, never a success", async () => {
    grantTheWholeTail();
    permissions.add(PERMISSIONS.MANAGE_FINANCE);
    queryResults.set(COCKPIT_QUERY, cockpit({ stages: stages("AFTER_HANDOVER"), ...FC_PANEL }));
    vi.mocked(toast.success).mockClear();

    const view = renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FcAttestChequeFace" }));
    fireEvent.change(await screen.findByLabelText("FcChequeFaceLabel"), { target: { value: "1500" } });
    fireEvent.change(screen.getByLabelText("FcAttestNoteLabel"), { target: { value: "read off the cheque" } });

    // The deal refreshes underneath the open dialog: the cheque it named is gone.
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), ...FC_PANEL, unattestedChequeId: null })
    );
    view.rerender(<DealCockpit orgId={ORG} applicationId={APP} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("UnexpectedError");
    expect(screen.getByLabelText("FcChequeFaceLabel")).toBeTruthy();
    expect(mutationCalls.get("applications:attestChequeFace")).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("registering from the cheque panel opens the payment form clean of a stale refusal", async () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), ...FC_PANEL, chequeFaceUnrecorded: false, unattestedChequeId: null, expectedPaymentReRegistrable: true })
    );

    renderCockpit();
    // A first attempt through the rail is refused and the form shows why.
    mutationFailures.set(EXPECTED_PAYMENT_MUTATION, "Stale refusal text");
    fireEvent.click(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm$/ }));
    await screen.findByText("Stale refusal text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Stale refusal text")).toBeNull());

    // Reopened from the cheque panel instead: a fresh form, not the old refusal.
    fireEvent.click(screen.getByRole("button", { name: "RegisterExpectedPayment" }));
    await screen.findByRole("button", { name: /^Confirm$/ });
    expect(screen.queryByText("Stale refusal text")).toBeNull();
  });
});
