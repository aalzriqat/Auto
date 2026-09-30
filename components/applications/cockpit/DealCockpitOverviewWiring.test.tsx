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
    // The cockpit reads closing readiness through the non-throwing useQueries (SCRUM-414 R2).
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))])
      ),
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

  // SCRUM-439, owner ruling 2026-09-28: "Vehicle handover fees and costs
  // should always be paid from custody cash." The owner recorded a 300
  // transfer fee the employee paid out of an 800 custody and the custody still
  // showed 0 spent — the form could only say "the dealership paid".
  describe("a handover cost is always paid out of custody cash (SCRUM-439)", () => {
    function withCosts(custody: unknown[], ready = true) {
      queryResults.set(COSTS_QUERY, { ...dealCosts(custody), custodyAccounting: ready ? { ready: true } : { ready: false, reason: "CHART_NOT_INITIALIZED" } });
    }
    function custodyTier(custody: unknown[] = [openCustody()], ready = true) {
      permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
      permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
      permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
      withCosts(custody, ready);
      queryResults.set(CANDIDATES_QUERY, {
        candidates: [
          { userId: "user_owner", name: "Owner", isActor: true },
          { userId: "user_rami", name: "Rami", isActor: false },
          { userId: "user_lina", name: "Lina", isActor: false },
        ],
        truncated: false,
      });
    }
    function openForm() {
      renderCockpit();
      fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
      const form = screen.getByTestId("deal-handover-cost-add");
      fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: "300" } });
      return form;
    }
    const recordCalls = () => mutations.get("financeDealCosts:recordDealFee")?.mock.calls.length ?? 0;
    const lina = () => ({ ...openCustody(), _id: "cust2", userId: "user_lina", userName: "Lina" });

    test("one chargeable record: the cost is the employee's and charged to it in one command, no pick needed", async () => {
      custodyTier();
      const form = openForm();
      expect((within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement).value).toBe("cust1");
      expect(within(form).getByTestId("deal-handover-cost-paid-by-note").textContent).toBe(salesEn.CostPaidFromCustodyNote);
      fireEvent.submit(form);
      const record = mutations.get("financeDealCosts:recordDealFee")!;
      await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE", custodyId: "cust1", actualAmountMinor: 300_000 });
    });

    test("several records: the form asks whose custody paid and refuses to save until it is answered", async () => {
      custodyTier([openCustody(), lina()]);
      const form = openForm();
      const paidFrom = within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement;
      expect(paidFrom.value).toBe("");
      expect((within(form).getByRole("button", { name: salesEn.SaveHandoverCost }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(form);
      expect(recordCalls()).toBe(0);
      fireEvent.change(paidFrom, { target: { value: "cust2" } });
      fireEvent.submit(form);
      const record = mutations.get("financeDealCosts:recordDealFee")!;
      await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE", custodyId: "cust2" });
    });

    test("never offers the dealership, the operator's own record, a closed, a legacy or another currency's record", () => {
      custodyTier([
        { ...openCustody(), _id: "mine", userId: "user_owner", userName: "Owner" },
        { ...openCustody(), _id: "closed", status: "RECONCILED" },
        { ...openCustody(), _id: "legacy", legacy: true },
        { ...openCustody(), _id: "usd", currency: "USD" },
        openCustody(),
        lina(),
      ]);
      const form = openForm();
      const options = Array.from((within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement).options).map((o) => o.value);
      expect(options).toEqual(["", "cust1", "cust2"]);
    });

    test("a customer-recoverable treatment is not offered — the server never charges it to custody", () => {
      custodyTier();
      const form = openForm();
      const treatments = Array.from((within(form).getByLabelText(salesEn.CostTreatmentLabel) as HTMLSelectElement).options).map((o) => o.value);
      expect(treatments).not.toContain("CUSTOMER_RECEIVABLE");
    });

    test("without custody authority the cost is still the employee's, sent unlinked to wait under 'Charge a cost'", async () => {
      permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
      permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
      withCosts([openCustody()]);
      const form = openForm();
      expect(within(form).queryByTestId("deal-handover-cost-paid-by")).toBeNull();
      expect(within(form).getByTestId("deal-handover-cost-paid-by-note").textContent).toBe(salesEn.CostPaidFromCustodyPendingNote);
      fireEvent.submit(form);
      const record = mutations.get("financeDealCosts:recordDealFee")!;
      await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE", actualAmountMinor: 300_000 });
      expect(record.mock.calls[0][0]).not.toHaveProperty("custodyId");
    });

    test("the holder recording their own spend, or a ledger that cannot post, leaves the charge to somebody else", async () => {
      custodyTier([{ ...openCustody(), userId: "user_owner", userName: "Owner" }]);
      let form = openForm();
      expect(within(form).queryByTestId("deal-handover-cost-paid-by")).toBeNull();
      cleanup();
      custodyTier([openCustody()], false);
      form = openForm();
      expect(within(form).queryByTestId("deal-handover-cost-paid-by")).toBeNull();
      fireEvent.submit(form);
      const record = mutations.get("financeDealCosts:recordDealFee")!;
      await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE" });
      expect(record.mock.calls[0][0]).not.toHaveProperty("custodyId");
    });

    test("with no open custody yet the cost is still the employee's, and the form says to hand the cash over and charge it", async () => {
      custodyTier([{ ...openCustody(), status: "RECONCILED" }]);
      const form = openForm();
      expect(within(form).queryByTestId("deal-handover-cost-paid-by")).toBeNull();
      expect(within(form).getByTestId("deal-handover-cost-needs-custody").textContent).toBe(salesEn.HandoverCostNeedsCustody);
      fireEvent.submit(form);
      const record = mutations.get("financeDealCosts:recordDealFee")!;
      await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE" });
      expect(record.mock.calls[0][0]).not.toHaveProperty("custodyId");
    });

    test("an authorised caller waits for the read that names them rather than being handed the unlinked path", () => {
      permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
      permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
      permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
      withCosts([openCustody()]);
      renderCockpit();
      expect((screen.getByRole("button", { name: salesEn.AddHandoverCost }) as HTMLButtonElement).disabled).toBe(true);
    });

    test("a record that closes while the form is open is never silently re-pointed", () => {
      custodyTier([openCustody(), lina()]);
      queryResults.set(COCKPIT_QUERY, cockpit());
      queryResults.set(APP_QUERY, { _id: APP, status: "APPROVED", salespersonId: "user_sales", economicsCurrency: "JOD", quote: null });
      const view = render(<DealCockpit orgId={ORG} applicationId={APP} />);
      fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
      const form = screen.getByTestId("deal-handover-cost-add");
      fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: "300" } });
      fireEvent.change(within(form).getByTestId("deal-handover-cost-paid-by"), { target: { value: "cust1" } });
      // The live read drops Rami's record (reconciled elsewhere); Lina's stays.
      withCosts([{ ...openCustody(), status: "RECONCILED" }, lina()]);
      view.rerender(<DealCockpit orgId={ORG} applicationId={APP} />);
      const stillOpen = screen.getByTestId("deal-handover-cost-add");
      expect(within(stillOpen).getByTestId("deal-handover-cost-paid-by-gone").textContent).toBe(salesEn.CostPaidFromCustodyGone);
      fireEvent.submit(stillOpen);
      expect(recordCalls()).toBe(0);
    });

    // Review round 1 on 4245ab0f8 (Sol F2 / Sonnet R1, same defect found
    // independently): the ONE record a form opens with is the operator's
    // answer, exactly as a pick is. It was re-derived on every render, so a
    // swap under an open form charged somebody else — or nobody.
    describe("the record the form opened with is the answer; any change is the operator's to decide", () => {
      function openLive(custody: unknown[]) {
        custodyTier(custody);
        queryResults.set(COCKPIT_QUERY, cockpit());
        queryResults.set(APP_QUERY, { _id: APP, status: "APPROVED", salespersonId: "user_sales", economicsCurrency: "JOD", quote: null });
        const view = render(<DealCockpit orgId={ORG} applicationId={APP} />);
        fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
        const form = screen.getByTestId("deal-handover-cost-add");
        fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: "300" } });
        return {
          swap(next: unknown[]) {
            withCosts(next);
            view.rerender(<DealCockpit orgId={ORG} applicationId={APP} />);
            return screen.getByTestId("deal-handover-cost-add");
          },
        };
      }

      test("the only record is replaced by another: nothing is sent to the new holder until the operator picks", async () => {
        const live = openLive([openCustody()]);
        const form = live.swap([{ ...openCustody(), status: "RECONCILED" }, lina()]);
        expect(within(form).getByTestId("deal-handover-cost-paid-by-gone").textContent).toBe(salesEn.CostPaidFromCustodyGone);
        expect((within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement).value).toBe("");
        fireEvent.submit(form);
        expect(recordCalls()).toBe(0);
        fireEvent.change(within(form).getByTestId("deal-handover-cost-paid-by"), { target: { value: "cust2" } });
        fireEvent.submit(form);
        const record = mutations.get("financeDealCosts:recordDealFee")!;
        await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
        expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE", custodyId: "cust2" });
      });

      test("the only record closes and none is left: the charge is not silently dropped, and recording it unlinked is an explicit step", async () => {
        const live = openLive([openCustody()]);
        const form = live.swap([{ ...openCustody(), status: "RECONCILED" }]);
        expect(within(form).getByTestId("deal-handover-cost-paid-by-gone").textContent).toContain(salesEn.CostPaidFromCustodyGoneNone);
        fireEvent.submit(form);
        expect(recordCalls()).toBe(0);
        // Not a dead end: the operator accepts the unlinked line on purpose.
        fireEvent.click(within(form).getByTestId("deal-handover-cost-paid-by-release"));
        expect(within(form).queryByTestId("deal-handover-cost-paid-by-gone")).toBeNull();
        fireEvent.submit(form);
        const record = mutations.get("financeDealCosts:recordDealFee")!;
        await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
        expect(record.mock.calls[0][0]).toMatchObject({ paidBy: "EMPLOYEE" });
        expect(record.mock.calls[0][0]).not.toHaveProperty("custodyId");
      });

      test("a record that appears after the form opened is offered, never adopted without a pick", async () => {
        const live = openLive([{ ...openCustody(), status: "RECONCILED" }]);
        const form = live.swap([openCustody()]);
        const paidFrom = within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement;
        expect(paidFrom.value).toBe("");
        fireEvent.submit(form);
        expect(recordCalls()).toBe(0);
        fireEvent.change(paidFrom, { target: { value: "cust1" } });
        fireEvent.submit(form);
        const record = mutations.get("financeDealCosts:recordDealFee")!;
        await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
        expect(record.mock.calls[0][0]).toMatchObject({ custodyId: "cust1" });
      });
    });

    // Review round 1 (Sol F4 / Sonnet R2): the member list is capped, so the
    // operator can fall outside it; their own record must still never be offered.
    test("an operator missing from a truncated member list is still never offered their own record", () => {
      custodyTier([{ ...openCustody(), _id: "mine", userId: "user_owner", userName: "Owner" }, lina()]);
      queryResults.set(CANDIDATES_QUERY, {
        actorId: "user_owner",
        candidates: [{ userId: "user_lina", name: "Lina", isActor: false }],
        truncated: true,
      });
      const form = openForm();
      const options = Array.from((within(form).getByTestId("deal-handover-cost-paid-by") as HTMLSelectElement).options).map((o) => o.value);
      expect(options).not.toContain("mine");
    });
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
