/**
 * SCRUM-417 UX PR 4 (O3) -- the clickable rail, the deep link and the back chip.
 *
 * (Fixture scaffolding is shared in spirit with DealCockpitRailOrder.test.tsx.)
 *
 * SCRUM-417 UX PR 2 (S1) -- the RENDERED rail shows the executable order.
 *
 * Real `deriveDealStages` output is rendered through the real container, so the
 * order, the node numbers and the "Stage n / 8" kicker are all read off what an
 * operator would see. The server's order is pinned elsewhere and not touched.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { deriveDealStages } from "@/convex/utils/financingEconomics";
import type { DealStageFacts } from "@/convex/utils/financingEconomics";

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
  replace: vi.fn(),
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
  useRouter: () => ({ replace: stubs.replace, push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import type { StageDeepLink } from "./dealStepView";

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

function renderDeal(overrides: Partial<DealStageFacts>, stageDeepLink?: StageDeepLink) {
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
  return render(<DealCockpit orgId={ORG} applicationId={APP} stageDeepLink={stageDeepLink} />);
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  stubs.replace.mockClear();
});

const node = (key: string) => screen.getByTestId(`deal-stage-node-${key}`);

/** Every flow zone in the grid, in order -- the live panels and cards. */
const zones = () => Array.from(document.querySelectorAll<HTMLElement>("[data-zone]"));

describe("O3 -- the rail is real buttons", () => {
  test("every node is a button; only the live one is aria-current", () => {
    renderDeal({});
    const buttons = within(screen.getByTestId("deal-stage-rail")).getAllByRole("button");
    expect(buttons).toHaveLength(8);
    expect(buttons.filter((b) => b.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(node("HANDOVER").getAttribute("aria-current")).toBe("step");
  });

  test("clicking the live node is normal: no view card, no chip", () => {
    renderDeal({});
    fireEvent.click(node("HANDOVER"));
    expect(screen.queryByTestId("deal-stage-view")).toBeNull();
    expect(screen.queryByTestId("deal-stage-view-back")).toBeNull();
  });

  test("a past step opens read-only, with its state, a back chip, and no action of its own", () => {
    renderDeal({});
    fireEvent.click(node("APPLICATION"));
    const view = screen.getByTestId("deal-stage-view");
    expect(view.getAttribute("data-mode")).toBe("past");
    expect(view.getAttribute("data-stage")).toBe("APPLICATION");
    expect(within(view).queryByTestId("deal-stage-view-needs")).toBeNull();
    // The live step is still there, still current, still the only aria-current.
    expect(screen.getByTestId("deal-next-step").textContent).toContain("StageHandover");
    expect(node("HANDOVER").getAttribute("aria-current")).toBe("step");
    expect(node("APPLICATION").getAttribute("aria-current")).toBeNull();
    expect(node("APPLICATION").getAttribute("aria-label")).toContain("StageViewing");
  });

  test("a future step says what it will need and who acts", () => {
    renderDeal({});
    fireEvent.click(node("SETTLEMENT"));
    const view = screen.getByTestId("deal-stage-view");
    expect(view.getAttribute("data-mode")).toBe("future");
    expect(within(view).getByTestId("deal-stage-view-needs").textContent).toContain("StageNeedsSettlement");
    expect(within(view).getByTestId("deal-stage-view-owner").textContent).toContain("StageOwnerDealership");
  });

  test("the back chip returns to the live step and clears the view", () => {
    renderDeal({});
    fireEvent.click(node("SETTLEMENT"));
    fireEvent.click(screen.getByTestId("deal-stage-view-back"));
    expect(screen.queryByTestId("deal-stage-view")).toBeNull();
    expect(screen.getByTestId("deal-next-step").textContent).toContain("StageHandover");
  });

  test("clicking the live node while viewing another step also returns", () => {
    renderDeal({});
    fireEvent.click(node("APPLICATION"));
    fireEvent.click(node("HANDOVER"));
    expect(screen.queryByTestId("deal-stage-view")).toBeNull();
  });

  test("viewing a step never unmounts or remounts what was already on screen", () => {
    renderDeal({});
    const before = zones();
    expect(before.length).toBeGreaterThan(1);
    const rail = screen.getByTestId("deal-stage-rail");
    const live = screen.getByTestId("deal-next-step");
    fireEvent.click(node("APPLICATION"));
    fireEvent.click(node("SETTLEMENT"));
    fireEvent.click(node("CREDIT_DECISION"));
    fireEvent.click(screen.getByTestId("deal-stage-view-back"));
    // The very same DOM nodes, not equal-looking new ones.
    for (const element of before) expect(document.body.contains(element)).toBe(true);
    expect(screen.getByTestId("deal-stage-rail")).toBe(rail);
    expect(screen.getByTestId("deal-next-step")).toBe(live);
    expect(zones()).toEqual(before);
  });
});

describe("O3 -- the ?stage= deep link", () => {
  const link = (value: string | null) => {
    const onChange = vi.fn();
    return { value, onChange } satisfies StageDeepLink;
  };

  test("a valid link opens that step's view on load", () => {
    renderDeal({}, link("SETTLEMENT"));
    expect(screen.getByTestId("deal-stage-view").getAttribute("data-stage")).toBe("SETTLEMENT");
  });

  test.each(["NOPE", "", "handover", "__proto__", "HANDOVER"])("%j falls back to the live step", (value) => {
    renderDeal({}, link(value));
    expect(screen.queryByTestId("deal-stage-view")).toBeNull();
    expect(screen.getByTestId("deal-next-step").textContent).toContain("StageHandover");
  });

  test("clicking a node writes the key; the live node and the chip clear it", () => {
    const deepLink = link(null);
    renderDeal({}, deepLink);
    fireEvent.click(node("APPLICATION"));
    expect(deepLink.onChange).toHaveBeenLastCalledWith("APPLICATION");
    fireEvent.click(node("HANDOVER"));
    expect(deepLink.onChange).toHaveBeenLastCalledWith(null);
  });

  test("the chip clears the link", () => {
    const deepLink = link("APPLICATION");
    renderDeal({}, deepLink);
    fireEvent.click(screen.getByTestId("deal-stage-view-back"));
    expect(deepLink.onChange).toHaveBeenLastCalledWith(null);
  });

  test("a link changes only the VIEW: the live stage and its action are untouched", () => {
    renderDeal({}, link("SETTLEMENT"));
    expect(node("HANDOVER").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("deal-next-step").textContent).toContain("StageHandover");
  });
});
describe("ROUND 2 -- the redirect to the sale keeps the viewed step", () => {
  const withCanonicalSale = (stageDeepLink: StageDeepLink | undefined) => {
    renderDeal({}, stageDeepLink);
    cleanup();
    stubs.replace.mockClear();
    const cockpit = queryResults.get("dealWorkspace:financedDealCockpit") as Record<string, unknown>;
    queryResults.set("dealWorkspace:financedDealCockpit", { ...cockpit, canonicalSaleId: "sale_9" });
    return render(<DealCockpit orgId={ORG} applicationId={APP} stageDeepLink={stageDeepLink} />);
  };
  test("?stage=SETTLEMENT travels with the redirect", () => {
    withCanonicalSale({ value: "SETTLEMENT", onChange: vi.fn() });
    expect(stubs.replace).toHaveBeenCalledWith("/org1/sales/sale_9/deal?stage=SETTLEMENT");
  });
  test("control: no viewed step, a bare sale URL", () => {
    withCanonicalSale({ value: null, onChange: vi.fn() });
    expect(stubs.replace).toHaveBeenCalledWith("/org1/sales/sale_9/deal");
  });
});