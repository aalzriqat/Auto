/**
 * SCRUM-417 UX PR 1 -- dead-end repairs. CONTAINER tests: the choosing of the
 * step (which reason, which link, for which caller) is made in the containers,
 * so a view-level fixture of `workflowAction` would prove none of it.
 *
 * S2  a blocked handover names its blocker and who acts, never "Register".
 * S3  no documents entry point for a caller who cannot act on documents.
 * S4  a blocker that lives on another page links to it, only for a caller who
 *     can act there, and names who acts for everyone else.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  /** The args each query was last mounted with, "skip" included. */
  queryArgs: new Map<string, unknown>(),
  permissions: new Set<string>(),
  membershipUserId: "user_manager",
  mutationCalls: new Map<string, unknown[]>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: stubs.membershipUserId },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      // As the real hook: a skipped query returns undefined, so a read this
      // caller cannot make can never hand the screen data (round 2, W1).
      return args === "skip" ? undefined : stubs.queryResults.get(name);
    },
    // The closing-readiness read (SCRUM-414) goes through `useQueries`; a
    // skipped read is simply absent from the request, as with the real hook.
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          stubs.queryArgs.set(name, args);
          return [key, stubs.queryResults.get(name)];
        }),
      ),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
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

// The sale's own completion dialog (W3). Stubbed to a marker naming the sale
// it was opened for: the dialog's internals belong to the Sales page and are
// tested there; what THIS suite proves is that the cash step opens it, for
// this sale, and never as a blank new-sale form.
vi.mock("@/components/sales/SaleDialog", () => ({
  SaleDialog: ({ open, sale }: { open: boolean; sale?: { _id: string } | null }) =>
    open ? <div data-testid="sale-dialog">{sale?._id ?? "NEW-SALE"}</div> : null,
}));

import { DealCockpit, SaleDealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, queryArgs, permissions, mutationCalls } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const SALE = "sale_7731" as Id<"sales">;
const JOD = 1_000;

const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const APP_QUERY = "applications:get";

type Stage = { key: string; state: string; blocker?: string; authority?: string };

function cockpit(status: string, stages: Stage[], overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status,
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
    ...overrides,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function renderCockpit() {
  if (!queryResults.has(APP_QUERY)) queryResults.set(APP_QUERY, application());
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

const step = () => screen.getByTestId("deal-next-step");
const stepButton = () => within(step()).queryByTestId("deal-next-step-action");

afterEach(() => {
  cleanup();
  queryResults.clear();
  queryArgs.clear();
  permissions.clear();
  mutationCalls.clear();
  stubs.membershipUserId = "user_manager";
});

const SUPPLIER_ROW = {
  party: "SUPPLIER",
  name: "supplier",
  position: "OWED_TO_DEALERSHIP",
  amountMinor: 3_000 * JOD,
  currency: "JOD",
  reference: undefined,
  receivableId: "recv_1",
};

function cash(settlesDirectToSupplier: boolean) {
  return {
    dealKind: "CASH",
    financingApplicationId: null,
    dealRef: SALE,
    saleId: SALE,
    applicationId: null,
    status: "COMPLETED",
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: undefined,
    customer: null,
    vehicle: null,
    salespersonName: "",
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
      settlesDirectToSupplier,
      routeKnown: true,
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000 * JOD,
        currency: "JOD",
        reconcilesToLedger: true,
        lines: [],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [SUPPLIER_ROW],
      supplierReceipt: { actionable: true },
      appraisalGapMinor: undefined,
    },
  };
}

const link = () => within(step()).queryByTestId("deal-next-step-link");
const linkNote = () => within(step()).queryByTestId("deal-next-step-link-note");

describe("S2 -- a blocked handover is never offered as an action", () => {
  const handover = (state: "BLOCKED" | "CURRENT", status = "UNDER_REVIEW") =>
    cockpit(
      status,
      [
        { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "DEALER" },
        state === "BLOCKED"
          ? { key: "HANDOVER", state, blocker: "HandoverBlocked", authority: "DEALER" }
          : { key: "HANDOVER", state, authority: "DEALER" },
        { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
      ]
    );

  test("a caller holding the handover permission is told what blocks it, with no Register button", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(COCKPIT_QUERY, handover("BLOCKED"));
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("BlockerHandoverBlocked");
    expect(step().textContent).toContain("HandoverBlockedNeedsApproval");
  });

  test("the prerequisite is named before the permission: a caller without it hears the blocker, not 'ask for permission'", () => {
    queryResults.set(COCKPIT_QUERY, handover("BLOCKED"));
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("HandoverBlockedNeedsApproval");
    expect(step().textContent).not.toContain("HandoverNeedsPermission");
  });

  test("F1 -- an APPROVED deal whose stored handover status reads BLOCKED still offers Register handover (the server only requires APPROVED)", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(COCKPIT_QUERY, handover("BLOCKED", "APPROVED"));
    renderCockpit();
    expect(stepButton()?.textContent).toBe("RegisterHandoverAction");
    expect(step().textContent).not.toContain("HandoverBlockedNeedsApproval");
  });

  test("F1 -- the same stale-BLOCKED APPROVED deal without the permission gets the permission reason, not the approval one", () => {
    queryResults.set(COCKPIT_QUERY, handover("BLOCKED", "APPROVED"));
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("HandoverNeedsPermission");
    expect(step().textContent).not.toContain("HandoverBlockedNeedsApproval");
  });

  test("CONTROL -- the same caller on a CURRENT handover still gets the working step", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(COCKPIT_QUERY, handover("CURRENT"));
    renderCockpit();
    expect(stepButton()?.textContent).toBe("RegisterHandoverAction");
    expect(step().textContent).not.toContain("HandoverBlockedNeedsApproval");
  });

  test("CONTROL -- a CURRENT handover without the permission keeps its own permission reason", () => {
    queryResults.set(COCKPIT_QUERY, handover("CURRENT"));
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("HandoverNeedsPermission");
  });
});

describe("S3 -- the documents link is offered only to a caller who can act on documents", () => {
  const delivery = (status: string) =>
    cockpit(
      "APPROVED",
      [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
      { documents: [{ ruleId: "r1", name: "id", required: true, status }] }
    );

  test("a caller who can neither upload nor verify sees the reason and no link to the documents", () => {
    queryResults.set(COCKPIT_QUERY, delivery("MISSING"));
    renderCockpit();
    expect(step().textContent).toContain("DocumentsNeedUploader");
    expect(within(step()).queryByTestId("deal-go-to-documents")).toBeNull();
  });

  test("an uploader when the only outstanding document awaits VERIFICATION is told who verifies, with no link", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, delivery("UPLOADED"));
    renderCockpit();
    expect(step().textContent).toContain("DocumentsAwaitVerifier");
    expect(within(step()).queryByTestId("deal-go-to-documents")).toBeNull();
  });

  test("a closed deal offers no link either", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, { ...delivery("MISSING"), status: "CLOSED" });
    renderCockpit();
    expect(step().textContent).toContain("DocumentsSettled");
    expect(within(step()).queryByTestId("deal-go-to-documents")).toBeNull();
  });

  test("CONTROL -- an uploader on an open deal still gets the working step", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, delivery("MISSING"));
    renderCockpit();
    expect(stepButton()?.textContent).toBe("CompleteDocumentsAction");
  });
});

describe("S4 -- a blocker on another page links to it, for the caller who can act there", () => {
  const settlement = () =>
    cockpit("APPROVED", [
      { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "DEALER" },
      { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
      { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
    ], { expectedPaymentRegistered: true });
  const heldDepositApp = () =>
    application({
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      vehicle: { sourceType: "SOURCED" },
      deposits: [{ _id: "d1", amount: 500, status: "HELD", method: "CASH" }],
    });

  test("a held vehicle deposit links to the vehicles page for a caller who may resolve it", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    permissions.add(PERMISSIONS.VIEW_VEHICLES);
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(APP_QUERY, heldDepositApp());
    renderCockpit();
    expect(step().textContent).toContain("FinalizeNeedsHeldDepositResolved");
    expect(link()?.getAttribute("href")).toBe(`/${ORG}/vehicles`);
    expect(linkNote()).toBeNull();
  });

  test("a caller who cannot resolve deposits gets no link and is told who does", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.VIEW_VEHICLES);
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(APP_QUERY, heldDepositApp());
    renderCockpit();
    expect(link()).toBeNull();
    expect(linkNote()?.textContent).toBe("DepositManagerNeedsApprover");
  });

  test("a resolver who cannot open the vehicles page is told, rather than linked to a refusal", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(APP_QUERY, heldDepositApp());
    renderCockpit();
    expect(link()).toBeNull();
    expect(linkNote()).not.toBeNull();
  });

  test("CONTROL -- a step with a working button carries no link", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit("APPROVED", [
        { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "DEALER" },
        { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
        { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
      ])
    );
    renderCockpit();
    expect(stepButton()?.textContent).toBe("RegisterHandoverAction");
    expect(link()).toBeNull();
  });

  describe("the cash sale's deposit decision", () => {
    const QUOTE = "quote_9";
    const SALE_RECORD = { _id: SALE, orgId: ORG, status: "PENDING", saleDate: Date.UTC(2026, 7, 1), quoteId: QUOTE };
    const pending = () => ({
      ...cash(false),
      status: "PENDING",
      stages: [
        { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
        { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
        { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
      ],
    });
    const grant = (...extra: string[]) => {
      for (const p of [
        PERMISSIONS.CREATE_SALES,
        PERMISSIONS.EDIT_SALES,
        PERMISSIONS.VIEW_CUSTOMERS,
        PERMISSIONS.VIEW_VEHICLES,
        PERMISSIONS.VIEW_USERS,
        ...extra,
      ]) {
        permissions.add(p);
      }
    };
    const withDeposit = () => {
      queryResults.set("sales:dealCockpit", pending());
      queryResults.set("sales:get", SALE_RECORD);
      queryResults.set("deposits:quoteAllocation", {
        currency: "JOD",
        scale: 3,
        totalReceivedMinor: 2_000 * JOD,
        heldTotalMinor: 2_000 * JOD,
        vehicles: [],
      });
    };

    test("links to the Sales page for a caller who can open it", () => {
      grant(PERMISSIONS.VIEW_SALES);
      withDeposit();
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(step().textContent).toContain("CashSaleCompletionNeedsDepositDecision");
      expect(link()?.getAttribute("href")).toBe(`/${ORG}/sales/sales`);
    });

    test("a caller who cannot open the Sales page gets no link and is told who acts", () => {
      grant();
      withDeposit();
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(link()).toBeNull();
      expect(linkNote()?.textContent).toBe("SalesPageNeedsAccess");
    });
  });

  describe("supplier settlement on a consigned cash sale", () => {
    // Server-consistent: THROUGH_DEALERSHIP means `settlesDirectToSupplier` is
    // false and the row is a payable the dealership owes (sales.ts ~2359, 2675).
    const withPosition = (position: string) => {
      const base = cash(false);
      return { ...base, money: { ...base.money, parties: [{ ...SUPPLIER_ROW, position }] } };
    };
    const financeCaller = () => {
      permissions.add(PERMISSIONS.MANAGE_FINANCE);
      permissions.add(PERMISSIONS.VIEW_FINANCE);
    };

    test("a payable the dealership owes links to the supplier payables page for a finance caller", () => {
      financeCaller();
      queryResults.set("sales:dealCockpit", withPosition("DEALERSHIP_OWES"));
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(step().textContent).toContain("SupplierPayableRecordedOnPayables");
      expect(step().textContent).not.toContain("CashSettlementNotRecordedHere");
      expect(link()?.getAttribute("href")).toBe(`/${ORG}/sourcing`);
      expect(link()?.textContent).toContain("OpenSourcingPayablesAction");
    });

    test("MANAGE_FINANCE without VIEW_FINANCE cannot open the payables list, so no link", () => {
      permissions.add(PERMISSIONS.MANAGE_FINANCE);
      queryResults.set("sales:dealCockpit", withPosition("DEALERSHIP_OWES"));
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(link()).toBeNull();
      expect(linkNote()?.textContent).toBe("SupplierPayablesNeedFinanceRole");
    });

    test("a caller who cannot act on finance gets no link and is told who does", () => {
      queryResults.set("sales:dealCockpit", withPosition("DEALERSHIP_OWES"));
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(step().textContent).toContain("SupplierPayableRecordedOnPayables");
      expect(link()).toBeNull();
      expect(linkNote()?.textContent).toBe("SupplierPayablesNeedFinanceRole");
    });

    test("an UNKNOWN obligation is not a payable anyone can pay: note, never a link", () => {
      financeCaller();
      queryResults.set("sales:dealCockpit", withPosition("UNKNOWN"));
      render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
      expect(step().textContent).toContain("CashSettlementNotRecordedHere");
      expect(link()).toBeNull();
      expect(linkNote()?.textContent).toBe("SupplierSettlementNeedsPermission");
    });
  });
});
