/**
 * Which URL owns a deal, and which query answers for its money.
 *
 * SCRUM-29 asks for ONE canonical Deal screen keyed on the sale. The first
 * implementation shipped two: the sale-keyed route detected a finance
 * application and `router.replace()`d back to the application-keyed route, and
 * the application route never sent a finalized application anywhere — so one
 * deal kept two permanent addresses and the "unified" screen was only unified
 * for cash. None of the earlier tests could see that, because every one of them
 * exercised `DealCockpitView` directly and the defect lived in the two wrappers
 * above it.
 *
 * The rule these tests pin:
 *
 *   - `/sales/{saleId}/deal` renders BOTH kinds and never navigates away.
 *   - A financed sale's money still comes from `applications.dealCockpit`, so
 *     there is no second source of truth for a figure that moves real money.
 *   - `/applications/{applicationId}/deal` canonicalizes to the sale URL once a
 *     sale exists.
 *   - The delegate does NOT canonicalize, or the two routes would redirect into
 *     each other forever.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { DealCockpitData } from "./DealCockpit";

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

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  replace: vi.fn(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: () => vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: stubs.replace, push: vi.fn() }),
}));

const { queryResults, replace } = stubs;

import { DealCockpit, SaleDealCockpit } from "./DealCockpit";

const ORG = "org1" as Id<"organizations">;
const SALE = "sale1" as Id<"sales">;
const APP = "app_2048" as Id<"financeApplications">;
const SCALE = 1_000;

/** The financed shape, as `applications.dealCockpit` returns it. */
function financedDeal(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    dealKind: "FINANCED",
    dealRef: "app_2048",
    applicationId: APP,
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
    stages: [{ key: "APPLICATION", state: "COMPLETE" }],
    documents: [],
    timeline: [{ toStatus: "APPROVED", changedAt: Date.UTC(2026, 6, 28), actorName: "ليث العمري" }],
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
      parties: [],
      appraisalGapMinor: undefined,
    },
    settlementAdviceRequiresReconciliation: false,
    ...overrides,
  } as unknown as DealCockpitData;
}

/** The cash shape, as `sales.dealCockpit` returns it. */
function cashDeal(overrides: Record<string, unknown> = {}): DealCockpitData {
  return {
    ...financedDeal(),
    dealKind: "CASH",
    dealRef: "sale1",
    applicationId: null,
    saleId: SALE,
    financingApplicationId: null,
    financeCompanyName: null,
    status: "COMPLETED",
    stages: [{ key: "SALE_AGREED", state: "COMPLETE" }],
    timeline: [{ toStatus: "PENDING", changedAt: Date.UTC(2026, 6, 28), actorName: "ليث العمري" }],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000 * SCALE,
        currency: "JOD",
        reconcilesToLedger: true,
        lines: [{ key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE }],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [],
      appraisalGapMinor: undefined,
    },
    ...overrides,
  } as unknown as DealCockpitData;
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  replace.mockReset();
});

describe("the sale URL is the deal's one address", () => {
  test("a CASH sale renders on the sale route and navigates nowhere", () => {
    queryResults.set("sales:dealCockpit", cashDeal());
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

    expect(screen.getAllByText("DealCockpitTitleCash").length).toBeGreaterThan(0);
    expect(replace).not.toHaveBeenCalled();
  });

  /**
   * The defect this file exists for. Before the fix this navigated to
   * `/org1/applications/app_2048/deal` and rendered a bare `Skeleton`, so the
   * sale-keyed screen did not serve a financed deal at all.
   */
  test("a FINANCED sale renders ON the sale route rather than redirecting away", () => {
    queryResults.set("sales:dealCockpit", cashDeal({ financingApplicationId: APP, money: null }));
    queryResults.set("applications:dealCockpit", financedDeal());

    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

    // Never sent to the application URL...
    expect(replace).not.toHaveBeenCalled();
    // ...and the FINANCED money is what rendered, which is only possible if the
    // application-keyed query answered. `sales.dealCockpit` returns `money: null`
    // for a financed sale, so this qualifier cannot come from it.
    expect(screen.getAllByText("ProfitEstimatedAwaitingSettlement").length).toBeGreaterThan(0);
  });

  test("the delegate does NOT canonicalize, so the two routes cannot loop", () => {
    // A finalized application — the exact condition that triggers the redirect
    // on the application route — reached through the SALE route.
    queryResults.set("sales:dealCockpit", cashDeal({ financingApplicationId: APP, money: null }));
    queryResults.set("applications:dealCockpit", financedDeal({ saleId: SALE }));

    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

    expect(replace).not.toHaveBeenCalled();
  });
});

describe("the application URL hands a finalized deal to the sale", () => {
  test("a finalized application canonicalizes to the sale URL", () => {
    queryResults.set("applications:dealCockpit", financedDeal({ saleId: SALE }));

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(replace).toHaveBeenCalledWith(`/${ORG}/sales/${SALE}/deal`);
  });

  /**
   * Before finalization there is no sale to key on, so the application URL is
   * still the deal's only address and must render normally.
   */
  test("an application with no sale yet stays where it is", () => {
    queryResults.set("applications:dealCockpit", financedDeal({ saleId: null }));

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getAllByText("ProfitEstimatedAwaitingSettlement").length).toBeGreaterThan(0);
  });

  test("a deal still loading is not redirected on absent evidence", () => {
    // `useQuery` returns undefined while in flight. Redirecting here would send
    // the operator away from a deal that may have no sale at all.
    queryResults.set("applications:dealCockpit", undefined);

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(replace).not.toHaveBeenCalled();
  });
});
