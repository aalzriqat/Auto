/**
 * The CONTAINER's wiring for the overview read model and the custody commands
 * — which queries it mounts, for whom, and what it sends the server.
 *
 * Same shape as `DealCockpitEconomicsWiring.test.tsx`: `DealCockpit` itself
 * is rendered with the Convex hooks mocked per function, and the assertions
 * are on the arguments, including whether a query is mounted at all.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { salesEn } from "@/lib/i18n/domains/sales";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (salesEn as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
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
  queryArgs: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  permissions: new Set<string>(),
  isOwner: false,
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_owner" },
    isOwner: stubs.isOwner,
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      return stubs.queryResults.get(name);
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      let fn = stubs.mutations.get(name);
      if (!fn) {
        fn = vi.fn(async () => "ok");
        stubs.mutations.set(name, fn);
      }
      return fn;
    },
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

const { queryResults, queryArgs, mutations, permissions } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_9" as Id<"financeApplications">;
const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const OVERVIEW_QUERY = "dealOverview:financedDealOverview";
const APP_QUERY = "applications:get";
const COSTS_QUERY = "financeDealCosts:listDealCosts";
const MEMBERS_QUERY = "memberships:list";
const CANDIDATES_QUERY = "financeDealCosts:listCustodyCandidates";

function cockpit() {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: null,
    vehicle: null,
    salespersonName: "",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    stages: [{ key: "HANDOVER", state: "CURRENT" }],
    documents: [],
    timeline: [],
    money: null,
    denomination: { code: "JOD", scale: 3 },
    economicsRecorded: false,
    economicsStamp: "v2|0",
  };
}

function dealCosts(custody: unknown[] = []) {
  return {
    currency: "JOD",
    fees: [],
    summary: {
      lineCount: 0,
      estimatedTotalMinor: 0,
      actualTotalMinor: 0,
      dealerBorneActualMinor: 0,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 0,
      fullyReconciled: false,
    },
    summaryUnavailable: null,
    expected: {
      source: "NO_TEMPLATES",
      currency: "JOD",
      rows: [],
      expectedTotalMinor: null,
      actualTotalMinor: 0,
      differenceMinor: null,
      unplannedLineIds: [],
      adoption: { state: "COMPANY_HAS_NO_TEMPLATES", liveTemplateCount: 0, liveRuleVersion: 1, adopted: null },
    },
    custody,
    custodyTruncated: false,
    accountingClassification: "PENDING_CLASSIFICATION",
  };
}

function openCustody() {
  return {
    _id: "cust1",
    userId: "user_rami",
    userName: "Rami",
    currency: "JOD",
    status: "OPEN",
    issuedMinor: 700_000,
    returnedMinor: 0,
    reimbursedMinor: 0,
    paidFeeIds: [],
    summary: {
      actualExpensesMinor: 0,
      employeeOwesDealerMinor: 700_000,
      reimbursementOutstandingMinor: 0,
      reimbursementOverpaidMinor: 0,
      overReturnedMinor: 0,
      settled: false,
    },
    summaryUnavailable: null,
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  queryArgs.clear();
  mutations.clear();
  permissions.clear();
  stubs.isOwner = false;
});

function renderCockpit() {
  queryResults.set(COCKPIT_QUERY, cockpit());
  queryResults.set(APP_QUERY, { _id: APP, status: "APPROVED", salespersonId: "user_sales", economicsCurrency: "JOD", quote: null });
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

describe("the overview read model", () => {
  test("is mounted for the deal once the cockpit has answered, and skipped before", () => {
    permissions.add(PERMISSIONS.VIEW_SALES);
    render(<DealCockpit orgId={ORG} applicationId={APP} />);
    expect(queryArgs.get(OVERVIEW_QUERY)).toBe("skip");
    cleanup();
    renderCockpit();
    expect(queryArgs.get(OVERVIEW_QUERY)).toEqual({ orgId: ORG, applicationId: APP });
  });
});

describe("the custody section", () => {
  test("without the disbursement permission the summary is read-only: no command, no candidate read, no general member list", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VIEW_USERS);
    queryResults.set(COSTS_QUERY, dealCosts([openCustody()]));
    renderCockpit();
    // The general member list (addresses, roles) is never this screen's read;
    // the permission-shaped candidate list is skipped without the permission.
    expect(queryArgs.has(MEMBERS_QUERY)).toBe(false);
    expect(queryArgs.get(CANDIDATES_QUERY)).toBe("skip");
    const panel = screen.getByTestId("deal-custody");
    expect(within(panel).getByTestId("custody-record-cust1")).toBeTruthy();
    expect(within(panel).getByTestId("custody-posted-note").textContent).toBe(salesEn.CustodyNoPermission);
    expect(within(panel).queryByRole("button", { name: salesEn.CustodyRecordReturn })).toBeNull();
    expect(within(panel).queryByTestId("custody-issue-button")).toBeNull();
  });

  test("with the disbursement permission the commands are wired through the posting mutations and the candidate read", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    const costs = { ...dealCosts([openCustody()]), custodyAccounting: { ready: true }, custodyPostsNow: true, plannedCustody: null, recommendedCustody: null, economicsFrozen: { frozen: false } };
    queryResults.set(COSTS_QUERY, costs);
    queryResults.set(CANDIDATES_QUERY, { candidates: [{ userId: "u2", name: "Rami" }], truncated: false });
    renderCockpit();
    expect(queryArgs.has(MEMBERS_QUERY)).toBe(false);
    expect(queryArgs.get(CANDIDATES_QUERY)).toEqual({ orgId: ORG });
    const panel = screen.getByTestId("deal-custody");
    fireEvent.click(within(panel).getByRole("button", { name: salesEn.CustodyRecordReturn }));
    const dialog = screen.getByTestId("custody-returned-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: "100" } });
    fireEvent.click(within(dialog).getByTestId("custody-returned-submit"));
    const move = mutations.get("financeDealCosts:recordCustodyMovement")!;
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0][0]).toMatchObject({ orgId: ORG, custodyId: "cust1", kind: "RETURNED", amountMinor: 100_000, method: "CASH" });
    expect(typeof move.mock.calls[0][0].idempotencyKey).toBe("string");
  });

  test("the candidate read is mounted on exactly the predicate that offers the custody commands, and the issue door waits for it (item 5)", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    const costs = { ...dealCosts([]), custodyAccounting: { ready: true }, custodyPostsNow: true, plannedCustody: null, recommendedCustody: null, economicsFrozen: { frozen: false } };
    queryResults.set(COSTS_QUERY, costs);
    // Before the cockpit has answered: no commands are offered and the read is skipped — together.
    queryResults.set(APP_QUERY, { _id: APP, status: "APPROVED", salespersonId: "user_sales", economicsCurrency: "JOD", quote: null });
    render(<DealCockpit orgId={ORG} applicationId={APP} />);
    expect(queryArgs.get(CANDIDATES_QUERY)).toBe("skip");
    expect(screen.queryByTestId("deal-custody")).toBeNull();
    cleanup();
    // The cockpit has answered, the read is in flight: the commands are
    // offered, the read is MOUNTED (never skipped while a command renders),
    // and the doors that need a person are shut until it answers.
    renderCockpit();
    expect(queryArgs.get(CANDIDATES_QUERY)).toEqual({ orgId: ORG });
    const panel = screen.getByTestId("deal-custody");
    expect((within(panel).getByTestId("custody-issue-button") as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByTestId("custody-plan-button") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    queryResults.set(CANDIDATES_QUERY, { candidates: [{ userId: "u2", name: "Rami" }], truncated: false });
    renderCockpit();
    expect((within(screen.getByTestId("deal-custody")).getByTestId("custody-issue-button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a frozen deal withholds every handover-cost edit and says why", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COSTS_QUERY, { ...dealCosts(), economicsFrozen: { frozen: true, reason: "SALE_FINALIZED" } });
    renderCockpit();
    expect(screen.queryByRole("button", { name: salesEn.AddHandoverCost })).toBeNull();
    expect(screen.getByTestId("deal-handover-costs-frozen").textContent).toBe(salesEn.HandoverCostAfterCloseNote);
  });

  test("an additional cost is always sent as paid by the DEALER — no custody link from this screen", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COSTS_QUERY, dealCosts([openCustody()]));
    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
    const form = screen.getByTestId("deal-handover-cost-add");
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: "120" } });
    fireEvent.submit(form);
    const record = mutations.get("financeDealCosts:recordDealFee")!;
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "DEALER", actualAmountMinor: 120_000 });
    expect(record.mock.calls[0][0]).not.toHaveProperty("custodyId");
  });

  // Old business rule: adopting company fee templates was offered to the owner on the cockpit handover panel.
  // Why obsolete: Company fee templates and adoption UX have been retired in favor of company adminFees (Execution Fees) as single authority.
  // New invariant: fee template adoption UX is retired, so the adopt button and notice are not rendered.
  test("fee template adoption UX is retired from the cockpit", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    const costs = dealCosts();
    costs.expected.adoption = { state: "AVAILABLE", liveTemplateCount: 2, liveRuleVersion: 2, adopted: null };
    queryResults.set(COSTS_QUERY, costs);
    stubs.isOwner = true;
    renderCockpit();
    expect(screen.queryByRole("button", { name: salesEn.AdoptCompanyFees })).toBeNull();
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();
  });
});
