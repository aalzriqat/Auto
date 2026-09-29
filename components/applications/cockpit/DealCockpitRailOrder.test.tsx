/**
 * SCRUM-417 UX PR 2 (S1) -- the RENDERED rail shows the executable order.
 *
 * Real `deriveDealStages` output is rendered through the real container, so the
 * order, the node numbers and the "Stage n / 8" kicker are all read off what an
 * operator would see. The server's order is pinned elsewhere and not touched.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { deriveDealStages } from "@/convex/utils/financingEconomics";
import type { DealStageFacts } from "@/convex/utils/financingEconomics";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
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
    useQuery: (reference: never, args: unknown) =>
      args === "skip" ? undefined : stubs.queryResults.get(getFunctionName(reference)),
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))]),
      ),
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

const { queryResults, permissions } = stubs;
const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;

const facts = (overrides: Partial<DealStageFacts>): DealStageFacts => ({
  status: "APPROVED",
  creditDecision: "APPROVED",
  appraisalStatus: "FINALIZED",
  approvedDealerPurchaseAmountMinor: 12_500_000,
  documentRulesApply: true,
  requiredDocumentsComplete: true,
  ...overrides,
});

function renderDeal(overrides: Partial<DealStageFacts>) {
  const stages = deriveDealStages(facts(overrides));
  queryResults.set("dealWorkspace:financedDealCockpit", {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: overrides.status ?? "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: null,
    vehicle: null,
    salespersonName: "",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages,
    documents: [],
    timeline: [],
    money: null,
  });
  queryResults.set("applications:get", {
    _id: APP,
    quoteId: "quote_1",
    status: overrides.status ?? "APPROVED",
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
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
});

const nodes = () => within(screen.getByTestId("deal-stage-rail")).getAllByRole("button");
const label = (node: HTMLElement) => (node.getAttribute("aria-label") ?? "").split(" · ")[0];
const number = (node: HTMLElement) => node.querySelector("bdi")?.textContent;

const EXECUTABLE_LABELS = [
  "StageApplication",
  "StageCreditDecision",
  "StageAppraisal",
  "StageApprovedPurchase",
  "StageDeliveryActions",
  "StageHandover",
  "StageSettlement",
  "StageDisbursement",
];

describe("S1 -- the rendered rail shows the executable order", () => {
  test("a deal at Documents: the payment confirmation is the LAST node, numbered 8, and not current", () => {
    renderDeal({ requiredDocumentsComplete: false });
    expect(nodes().map(label)).toEqual(EXECUTABLE_LABELS);
    const payment = nodes().at(-1)!;
    expect(number(payment)).toBe("8");
    expect(payment.getAttribute("aria-current")).toBeNull();
    // The live node is Documents, at place 5 -- unchanged by the reorder.
    const live = nodes().filter((n) => n.getAttribute("aria-current") === "step");
    expect(live.map(label)).toEqual(["StageDeliveryActions"]);
    expect(screen.getByTestId("deal-next-step").textContent).toContain("5 / 8");
  });

  test("a deal at Handover: Handover is current and numbered 6, the payment is quiet and numbered 8", () => {
    renderDeal({});
    expect(nodes().map(label)).toEqual(EXECUTABLE_LABELS);
    const live = nodes().filter((n) => n.getAttribute("aria-current") === "step");
    expect(live.map(label)).toEqual(["StageHandover"]);
    expect(number(live[0])).toBe("6");
    expect(screen.getByTestId("deal-next-step").textContent).toContain("6 / 8");
    const payment = nodes().at(-1)!;
    expect(number(payment)).toBe("8");
    expect(payment.getAttribute("aria-current")).toBeNull();
    expect(payment.getAttribute("aria-label")).toContain("StageStatePending");
  });

  // The state every closed financed deal is in until the finance company pays:
  // CLOSED, handed over, and the settlement NOT complete (the money has not
  // arrived). Production never produces `settlementComplete: true` with no
  // `disbursedAt`, so that is not the fixture.
  const closedAwaitingPayment = {
    status: "CLOSED" as const,
    finalizedSaleId: "sale_1" as never,
    handoverStatus: "HANDED_OVER" as const,
    settlementComplete: false,
  };
  const stateOf = (node: HTMLElement) =>
    ["StageStateComplete", "StageStateCurrent", "StageStateBlocked", "StageStatePending", "StageStateStopped"].find(
      (state) => (node.getAttribute("aria-label") ?? "").includes(state)
    );

  test("a closed deal awaiting the finance company: node 7 Settlement is PENDING, node 8 payment is the live step", () => {
    renderDeal(closedAwaitingPayment);
    expect(nodes().map(label)).toEqual(EXECUTABLE_LABELS);
    // The full node-state sequence, in displayed order.
    expect(nodes().map(stateOf)).toEqual([
      "StageStateComplete",
      "StageStateComplete",
      "StageStateComplete",
      "StageStateComplete",
      "StageStateComplete",
      "StageStateComplete",
      "StageStatePending",
      "StageStateBlocked",
    ]);
    expect(number(nodes()[6])).toBe("7");
    expect(label(nodes()[6])).toBe("StageSettlement");
    const live = nodes().filter((n) => n.getAttribute("aria-current") === "step");
    expect(live.map(label)).toEqual(["StageDisbursement"]);
    expect(live[0]).toBe(nodes().at(-1));
    expect(screen.getByTestId("deal-next-step").textContent).toContain("8 / 8");
  });

  test("UX2-F2b: the pending Settlement node says it completes after the finance company pays", () => {
    renderDeal(closedAwaitingPayment);
    expect(nodes()[6].getAttribute("aria-label")).toContain("BlockerSettlementAfterFinancePayment");
  });

  test("UX2-F2b: no such note on Settlement at Handover (it is waiting on the handover, not on the payment)", () => {
    renderDeal({});
    const settlement = nodes()[6];
    expect(label(settlement)).toBe("StageSettlement");
    expect(settlement.getAttribute("aria-label")).not.toContain("BlockerSettlementAfterFinancePayment");
  });
});

describe("S1 -- the payment stage names the SYSTEM confirmation, not the transfer", () => {
  test("English: 'Confirm finance company payment'", () => {
    expect((salesEn as Record<string, string>).StageDisbursement).toBe("Confirm finance company payment");
  });

  test("Arabic: a confirmation ('تأكيد'), not the bare payment", () => {
    const ar = (salesAr as Record<string, string>).StageDisbursement;
    expect(ar).toContain("تأكيد");
    expect(ar).toContain("شركة التمويل");
  });
});
