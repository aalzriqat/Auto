/**
 * SCRUM-446 (UI half), CONTAINER level: the cockpit given a CLOSED financed deal
 * whose DISBURSEMENT stage the server marks NOT_APPLICABLE (no finance company
 * pays the dealership).
 *
 * The defect this pins is a contradiction: a rail that says the payment step is
 * not needed beside an action slot that still offers to confirm a payment, or
 * refuses it with "nothing is expected from the finance company". The rail and the
 * slot read the same stage list, so they must agree.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

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
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_manager" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))])
      ),
    useQuery: (reference: never, args: unknown) =>
      args === "skip" ? undefined : stubs.queryResults.get(getFunctionName(reference)),
    useMutation: () => async () => null,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, permissions } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const GET_QUERY = "applications:get";

function cockpit(overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "CLOSED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: { id: "v1", label: "Volkswagen e-Golf 2020", vin: "WVWZZZAUZLW901234", consigned: false, supplierName: "" },
    salespersonName: "ليث العمري",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: true,
    supplierSettlementRouteRequired: false,
    stages: [],
    documents: [],
    timeline: [],
    money: null,
    activeAppraisalProvider: null,
    pendingDepositResolution: false,
    ...overrides,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP,
    quoteId: "quote_1",
    status: "CLOSED",
    salespersonId: "user_sales",
    companyId: undefined,
    economicsCurrency: "JOD",
    quote: { totalFinancedAmount: 15000, downPayment: 500, vehiclePrice: 17000 },
    vehicle: { sourceType: "OWNED", sourcedFromName: undefined },
    deposits: [],
    hasExternalFinancier: false,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
    supplierSettlementRoute: undefined,
    disbursedAt: undefined,
    supplierDisbursementStatus: undefined,
    approvedDealerPurchaseAmountMinor: 16_500_000,
    ...overrides,
  };
}

/** A closed deal with no finance company: every stage finished, DISBURSEMENT not needed. */
const FINISHED_NA_STAGES = [
  { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
  { key: "CREDIT_DECISION", state: "COMPLETE", authority: "MIRROR" },
  { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "MIRROR" },
  { key: "DELIVERY_ACTIONS", state: "COMPLETE", authority: "DEALER" },
  { key: "DISBURSEMENT", state: "NOT_APPLICABLE", authority: "MIRROR" },
  { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
  { key: "SETTLEMENT", state: "COMPLETE", authority: "DEALER" },
];

function renderCockpit(stageDeepLink?: { value: string | null; onChange: (key: string | null) => void }) {
  return render(<DealCockpit orgId={ORG} applicationId={APP} stageDeepLink={stageDeepLink} />);
}

function arrange(stages: unknown[]) {
  permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
  queryResults.set(COCKPIT_QUERY, cockpit({ stages }));
  queryResults.set(GET_QUERY, application());
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
});

describe("a CLOSED deal whose DISBURSEMENT stage is NOT_APPLICABLE", () => {
  test("is a finished deal: the calm completion line, not a rail waiting on something", () => {
    arrange(FINISHED_NA_STAGES);
    renderCockpit();

    expect(screen.getByTestId("deal-stages-toggle")).toBeTruthy();
    // No live stage, so no next-step card and no rail until it is opened.
    expect(screen.queryByTestId("deal-next-step")).toBeNull();
    expect(screen.queryByTestId("deal-stage-rail")).toBeNull();
  });

  test("Sol UI-446-1: the collapsed summary is neutral: no completion claim, no success tick, complete and not-needed counted apart", () => {
    arrange(FINISHED_NA_STAGES);
    renderCockpit();
    const summary = screen.getByTestId("deal-stages-toggle").parentElement as HTMLElement;
    expect(summary.textContent).not.toContain("DealAllStagesComplete");
    expect(summary.textContent).toContain("DealStagesFinished");
    expect(summary.textContent).toContain("6");
    expect(summary.textContent).toContain("DealStagesCompleteCount");
    expect(summary.textContent).toContain("1");
    expect(summary.textContent).toContain("DealStagesNotNeededCount");
    expect(summary.querySelector("svg.lucide-check")).toBeNull();
    expect(summary.querySelector(".text-emerald-800")).toBeNull();
  });

  test("control: an all-COMPLETE deal keeps the original completion line, tick and count", () => {
    arrange(FINISHED_NA_STAGES.map((stage) => ({ ...stage, state: "COMPLETE" })));
    renderCockpit();
    const summary = screen.getByTestId("deal-stages-toggle").parentElement as HTMLElement;
    expect(summary.textContent).toContain("DealAllStagesComplete");
    expect(summary.textContent).toContain("(7)");
    expect(summary.textContent).not.toContain("DealStagesFinished");
    expect(summary.querySelector("svg.lucide-check")).not.toBeNull();
  });

  test("the rail and the slot agree: not needed on the node, and NO payment action or refusal anywhere", () => {
    arrange(FINISHED_NA_STAGES);
    const { container } = renderCockpit();
    fireEvent.click(screen.getByTestId("deal-stages-toggle"));

    const node = screen.getByTestId("deal-stage-node-DISBURSEMENT");
    expect(node.getAttribute("aria-label")).toContain("StageStateNotApplicable");
    expect(node.getAttribute("aria-label")).toContain("StageNotApplicableReasonDisbursement");
    // The slot: neither the confirmation nor the sentence that used to contradict the rail.
    expect(screen.queryByRole("button", { name: "ConfirmDisbursement" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ConfirmSupplierDisbursement" })).toBeNull();
    expect(container.textContent).not.toContain("DisbursementUnavailable");
    expect(container.textContent).not.toContain("DisbursementNeedsPermission");
    expect(container.textContent).not.toContain("SupplierDisbursementUnavailable");
  });

  test("a caller without the confirmation permission gets the same answer: not needed, not 'ask a manager'", () => {
    arrange(FINISHED_NA_STAGES);
    permissions.delete(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    const { container } = renderCockpit();
    fireEvent.click(screen.getByTestId("deal-stages-toggle"));
    expect(container.textContent).not.toContain("DisbursementNeedsPermission");
    expect(screen.getByTestId("deal-stage-node-DISBURSEMENT").getAttribute("aria-label")).toContain(
      "StageStateNotApplicable"
    );
  });

  test("opening the step says it is not needed and why, names no owner; it has no button but the way back", () => {
    arrange(FINISHED_NA_STAGES);
    renderCockpit({ value: "DISBURSEMENT", onChange: () => {} });

    const view = screen.getByTestId("deal-stage-view");
    expect(view.getAttribute("data-mode")).toBe("notApplicable");
    expect(view.getAttribute("data-stage")).toBe("DISBURSEMENT");
    expect(within(view).getByText("StageStateNotApplicable")).toBeTruthy();
    expect(within(view).getByTestId("deal-stage-view-note").textContent).toBe("StageNotApplicableReasonDisbursement");
    // Sol UI-446-2: a not-needed step never shows an owner, not even "nobody".
    expect(within(view).queryByTestId("deal-stage-view-owner")).toBeNull();
    expect(view.textContent).not.toContain("StageViewWhoActs");
    expect(within(view).queryByTestId("deal-stage-view-needs")).toBeNull();
    expect(within(view).queryByTestId("deal-stage-view-record")).toBeNull();
    // The back control is the only control.
    expect(within(view).getAllByRole("button")).toHaveLength(1);
  });

  test("it names no finance-company owner anywhere on its node", () => {
    arrange(FINISHED_NA_STAGES);
    renderCockpit();
    fireEvent.click(screen.getByTestId("deal-stages-toggle"));
    const node = screen.getByTestId("deal-stage-node-DISBURSEMENT");
    expect(node.getAttribute("aria-label")).not.toContain("StageOwnerFinanceCompany");
    expect(within(node).queryByTestId("deal-stage-owner")).toBeNull();
    // Every other node keeps its owner.
    expect(within(screen.getByTestId("deal-stage-node-HANDOVER")).getByTestId("deal-stage-owner")).toBeTruthy();
  });
});

describe("controls: real stages still show their owner", () => {
  test("a past step (Handover) shows who acted", () => {
    arrange(FINISHED_NA_STAGES);
    renderCockpit({ value: "HANDOVER", onChange: () => {} });
    const view = screen.getByTestId("deal-stage-view");
    expect(view.getAttribute("data-mode")).toBe("past");
    expect(within(view).getByTestId("deal-stage-view-owner").textContent).toContain("StageOwnerDealership");
  });

  test("a future step shows who will act", () => {
    arrange(
      FINISHED_NA_STAGES.map((stage) =>
        stage.key === "HANDOVER" ? { ...stage, state: "PENDING" } : stage.key === "SETTLEMENT" ? { ...stage, state: "PENDING" } : stage
      )
    );
    renderCockpit({ value: "SETTLEMENT", onChange: () => {} });
    const view = screen.getByTestId("deal-stage-view");
    expect(view.getAttribute("data-mode")).toBe("future");
    expect(within(view).getByTestId("deal-stage-view-owner").textContent).toContain("StageOwnerDealership");
  });
});

/**
 * SCRUM-629 F-07 self-attack: a deal with no required document gets a
 * NOT_APPLICABLE documents stage. Read as "documents incomplete", it would send
 * every such deal's approver to a documents step that does not exist instead of
 * the credit decision — a dead end on exactly the deals F-07 is for.
 */
describe("an UNDER_REVIEW deal whose documents stage is NOT_APPLICABLE", () => {
  const underReview = (deliveryState: string) => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        status: "UNDER_REVIEW",
        stages: [
          { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
          { key: "CREDIT_DECISION", state: "CURRENT", authority: "MIRROR" },
          { key: "APPROVED_PURCHASE", state: "PENDING", authority: "MIRROR" },
          { key: "DELIVERY_ACTIONS", state: deliveryState, authority: "DEALER" },
          { key: "DISBURSEMENT", state: "PENDING", authority: "MIRROR" },
          { key: "HANDOVER", state: "PENDING", authority: "DEALER" },
          { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
        ],
      })
    );
    queryResults.set(GET_QUERY, application({ status: "UNDER_REVIEW" }));
  };

  test("the approver is offered the credit decision, not a documents step", () => {
    underReview("NOT_APPLICABLE");
    const { container } = renderCockpit();
    expect(screen.getByTestId("deal-next-step-action").textContent).toBe("RecordCreditDecisionAction");
    expect(container.textContent).not.toContain("CompleteDocumentsFirstAction");
    expect(container.textContent).not.toContain("CreditApprovalNeedsDocuments");
  });

  test("control: an outstanding documents stage still sends the approver to the documents first", () => {
    underReview("BLOCKED");
    const { container } = renderCockpit();
    expect(container.textContent).toContain("CreditApprovalNeedsDocuments");
    expect(screen.queryByTestId("deal-next-step-action")?.textContent).not.toBe("RecordCreditDecisionAction");
  });
});

describe("live-stage selection skips a NOT_APPLICABLE stage", () => {
  test("the stage after it is the live one, with its own card, and the payment stage is not", () => {
    arrange(
      FINISHED_NA_STAGES.map((stage) =>
        stage.key === "SETTLEMENT"
          ? { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" }
          : stage
      )
    );
    renderCockpit();

    const nodes = screen.getByTestId("deal-stage-rail").querySelectorAll('[aria-current="step"]');
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as HTMLElement).getAttribute("data-testid")).toBe("deal-stage-node-SETTLEMENT");
    expect(screen.getByTestId("deal-next-step")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ConfirmDisbursement" })).toBeNull();
  });

  test("a NOT_APPLICABLE stage does not stop the deal reading as unfinished while another stage is live", () => {
    // The server always makes the first unfinished reachable stage live, so the
    // shape to guard is NA + a BLOCKED settlement, never NA + PENDING alone.
    arrange(
      FINISHED_NA_STAGES.map((stage) => (stage.key === "SETTLEMENT" ? { ...stage, state: "BLOCKED" } : stage))
    );
    renderCockpit();
    expect(screen.queryByTestId("deal-stages-toggle")).toBeNull();
    expect(screen.getByTestId("deal-stage-rail")).toBeTruthy();
    expect(screen.queryByTestId("deal-stopped")).toBeNull();
  });
});
