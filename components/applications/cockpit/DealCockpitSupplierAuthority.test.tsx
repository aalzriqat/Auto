/**
 * Who is offered "Settle supplier", decided at the CONTAINER.
 *
 * `supplierReceivables.recordReceipt` requires MANAGE_FINANCE. The party
 * summary used to offer the action from the deal's state alone — a direct
 * supplier route and a claim owed to the dealership — so a custom role that
 * could READ the money block (VIEW_FINANCE + VIEW_SALES) was shown a button the
 * server would refuse on click. The server was never wrong; the screen was
 * promising something it could not deliver.
 *
 * These tests render the two CONTAINERS, not the pure view, because the view
 * already defaults `canSettleSupplier` to `false`: a view-level test cannot
 * tell "the container wired the permission" from "the container forgot and the
 * default hid it". Rendering `DealCockpit` and `SaleDealCockpit` against a
 * controllable `usePermissions` is what catches the missing wire on either
 * path. The permission stub is shaped like the real hook — a list membership
 * check, OWNER short-circuit and all — so a test cannot pass by handing the
 * container a role name to pattern-match on.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import type { DealCockpitData } from "./DealStagePresentation";

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
  /**
   * The membership as the real `usePermissions` reads it: `undefined` while the
   * query is in flight, otherwise a role name and a flat permission list.
   */
  membership: undefined as { roleName: string; permissions: string[] } | undefined,
}));

// The same predicate the real hook applies, over the stubbed membership —
// nothing the containers could satisfy by reading a role name, except OWNER,
// which the product itself grants everything to.
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => {
    const membership = stubs.membership;
    const isOwner = membership?.roleName === "OWNER";
    return {
      permissions: membership?.permissions ?? [],
      isLoading: membership === undefined,
      isOwner,
      hasPermission: (permission: string) =>
        isOwner || (membership?.permissions ?? []).includes(permission),
      role: membership?.roleName,
      membership,
    };
  },
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: () => vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { DealCockpit, SaleDealCockpit } from "./DealCockpit";

type FinancedDealCockpitData = Extract<DealCockpitData, { dealKind: "FINANCED" }>;
type CashDealCockpitData = NonNullable<(typeof api.sales.dealCockpit)["_returnType"]>;

const ORG = "org1" as Id<"organizations">;
const SALE = "sale_7731" as Id<"sales">;
const APP = "app_2048" as Id<"financeApplications">;
const SCALE = 1_000;

/** A supplier the dealership must collect the margin FROM: the settle-able position. */
const SUPPLIER_OWES_MARGIN = {
  party: "SUPPLIER" as const,
  name: "شركة عمّان للاستيراد",
  position: "OWED_TO_DEALERSHIP" as const,
  amountMinor: 3_000 * SCALE,
  currency: "JOD",
  reference: undefined,
  receivableId: "recv_1" as Id<"vehicleSupplierReceivables">,
};

/**
 * A financed deal settled DIRECT_TO_SUPPLIER with the supplier holding the
 * margin — every deal-state condition for the action is met, so only the
 * caller's authority decides. Ids are the only casts; the shape is checked.
 */
function financedDirectDeal(): FinancedDealCockpitData {
  const profit = {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor: 2_410 * SCALE,
    currency: "JOD",
    classification: "ESTIMATED_AWAITING_SETTLEMENT",
    postable: false,
    lines: [{ key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE }],
  } satisfies NonNullable<FinancedDealCockpitData["money"]>["profit"];
  return {
    dealKind: "FINANCED",
    denomination: { code: "JOD", scale: 3 },
    dealRef: "app_2048",
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1" as Id<"customers">, name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1" as Id<"vehicles">,
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: true,
      supplierName: "شركة عمّان للاستيراد",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    activeAppraisalProvider: null,
    stages: [{ key: "APPLICATION", state: "COMPLETE", authority: "DEALER" }],
    documents: [],
    timeline: [],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: true,
      routeKnown: true,
      profit,
      managementProfit: profit,
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [SUPPLIER_OWES_MARGIN],
      appraisalGapMinor: undefined,
    },
    handoverEvidence: {
      approvedPurchaseAmountMinor: 12_500 * SCALE,
      financeCompanyFundedPortionMinor: 12_000 * SCALE,
      dealerContributionMinor: 500 * SCALE,
      approvedAmountIsFarFromEvidence: false,
      currency: { code: "JOD", scale: 3 },
    },
    settlementAdviceDiscrepancy: null,
    settlementAdviceRequiresReconciliation: false,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    economicsRecorded: true,
    economicsStamp: "fixture-economics-stamp",
    pendingDepositResolution: false,
  } satisfies FinancedDealCockpitData;
}

/** The cash equivalent, as `sales.dealCockpit` serves a consigned DIRECT sale. */
function cashDirectDeal(): CashDealCockpitData {
  return {
    dealKind: "CASH",
    financingApplicationId: null,
    dealRef: "sale_7731",
    saleId: SALE,
    applicationId: null,
    status: "COMPLETED",
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: undefined,
    customer: { id: "c1" as Id<"customers">, name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1" as Id<"vehicles">,
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: true,
      supplierName: "شركة عمّان للاستيراد",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    stages: [
      { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
      { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
      { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
    ],
    documents: [],
    timeline: [],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: true,
      routeKnown: true,
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000 * SCALE,
        currency: "JOD",
        reconcilesToLedger: true,
        lines: [
          { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
          { key: "VEHICLE_COST", sign: -1, amountMinor: 0 },
          { key: "SUPPLIER_ENTITLEMENT", sign: -1, amountMinor: 17_000 * SCALE },
        ],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [SUPPLIER_OWES_MARGIN],
      appraisalGapMinor: undefined,
    },
  } satisfies CashDealCockpitData;
}

/** The role under test: may READ finance and sales, may not MANAGE finance. */
const FINANCE_READER = {
  roleName: "Finance Reader",
  permissions: [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_FINANCE_APPLICATIONS],
};
/** A custom role holding exactly the permission the mutation requires. */
const FINANCE_MANAGER = {
  roleName: "Settlements",
  permissions: [...FINANCE_READER.permissions, PERMISSIONS.MANAGE_FINANCE],
};

function settleButton() {
  return screen.queryByRole("button", { name: "SettleSupplierAction" });
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.membership = undefined;
});

describe.each([
  {
    path: "the financed DealCockpit",
    mount: () => {
      stubs.queryResults.set("dealWorkspace:financedDealCockpit", financedDirectDeal());
      return render(<DealCockpit orgId={ORG} applicationId={APP} />);
    },
  },
  {
    path: "the cash SaleDealCockpit",
    mount: () => {
      stubs.queryResults.set("sales:dealCockpit", cashDirectDeal());
      return render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
    },
  },
])("$path offers the supplier settlement only to a caller who may record it", ({ mount }) => {
  test("a VIEW_FINANCE + VIEW_SALES custom role WITHOUT MANAGE_FINANCE sees no action and can open no dialog", () => {
    stubs.membership = FINANCE_READER;
    mount();

    // The claim itself is on screen — this role may read it...
    expect(screen.getByText("FactSupplier")).toBeTruthy();
    expect(screen.getByText("PositionOwedToDealership")).toBeTruthy();
    // ...but the action the server would refuse is absent, not merely disabled.
    expect(settleButton()).toBeNull();
    expect(screen.queryByText("SettleSupplierTitle")).toBeNull();
  });

  test("while the membership is still loading the action is withheld", () => {
    stubs.membership = undefined;
    mount();
    expect(settleButton()).toBeNull();
  });

  test("a caller holding MANAGE_FINANCE sees the action and opens the receipt dialog", () => {
    stubs.membership = FINANCE_MANAGER;
    mount();

    const button = settleButton();
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(screen.getByText("SettleSupplierTitle")).toBeTruthy();
  });

  test("an OWNER is granted the action by the product's own rule, not by a role-name match here", () => {
    // OWNER's list is empty on purpose: the real hook short-circuits on the
    // role, and that is the only role-based grant the containers may inherit.
    stubs.membership = { roleName: "OWNER", permissions: [] };
    mount();
    expect(settleButton()).not.toBeNull();
  });
});
