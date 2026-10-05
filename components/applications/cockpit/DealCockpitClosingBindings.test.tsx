import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { DealCockpit } from "./DealCockpit";

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
  mutationCalls: new Map<string, unknown[]>(),
  mutationFailures: new Map<string, string>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_finance" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const resultOf = (reference: never) => stubs.queryResults.get(getFunctionName(reference));
  return {
    // As the real hook does: a query whose result is an Error (a function the
    // deployed backend does not have) THROWS during render.
    useQuery: (reference: never) => {
      const result = resultOf(reference);
      if (result instanceof Error) throw result;
      return result;
    },
    // The non-throwing form: an Error comes back as a value.
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
          throw new Error(failure);
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

const { queryResults, permissions, mutationCalls } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_1" as Id<"financeApplications">;

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  mutationCalls.clear();
});

function setupDeal() {
  permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
  permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);

  queryResults.set("dealWorkspace:financedDealCockpit", {
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
    stages: [
      { key: "APPROVED_PURCHASE", state: "COMPLETE" },
      { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
      { key: "HANDOVER", state: "COMPLETE" },
      { key: "SETTLEMENT", state: "COMPLETE" },
    ],
    documents: [],
    timeline: [],
    money: null,
  });

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

  queryResults.set("financeDealCosts:listDealCosts", {
    currency: "JOD",
    fees: [
      {
        _id: "fee_1" as Id<"financeDealFees">,
        feeType: "OWNERSHIP_TRANSFER",
        description: "Transfer Fee",
        actualAmountMinor: 150000,
        status: "RECORDED",
        currency: "JOD",
        paidBy: "DEALER",
        paidTo: "GOVERNMENT",
      },
    ],
    summary: {
      actualTotalMinor: 150000,
      estimatedTotalMinor: 150000,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 1,
      lineCount: 1,
      fullyReconciled: false,
    },
    summaryUnavailable: null,
    expected: null,
    custody: [],
    custodyTruncated: false,
    legalInvoiceAmountMinor: undefined,
  });
}

describe("DealCockpit closing bindings (TASK-DEAL-04)", () => {
  test("renders Record Legal Invoice trigger and binds recordLegalInvoice mutation", async () => {
    setupDeal();
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const recordInvoiceBtn = await screen.findByRole("button", { name: /RecordLegalInvoice/i });
    expect(recordInvoiceBtn).toBeTruthy();

    fireEvent.click(recordInvoiceBtn);

    const amountInput = screen.getByLabelText(/LegalInvoiceAmount/i);
    fireEvent.change(amountInput, { target: { value: "15000" } });

    const numberInput = screen.getByLabelText(/LegalInvoiceNumber/i);
    fireEvent.change(numberInput, { target: { value: "INV-999" } });

    const dateInput = screen.getByLabelText(/LegalInvoiceDate/i);
    fireEvent.change(dateInput, { target: { value: "2026-09-15" } });

    const submitBtn = screen.getByRole("button", { name: /SubmitLegalInvoice/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mutationCalls.get("financeDealCosts:recordLegalInvoice")).toBeDefined();
    });

    expect(mutationCalls.get("financeDealCosts:recordLegalInvoice")![0]).toMatchObject({
      orgId: ORG,
      applicationId: APP,
      legalInvoiceAmountMinor: 15000000,
      legalInvoiceNumber: "INV-999",
      issuedTo: "FINANCE_COMPANY",
    });
  });

  test("a refused legal invoice keeps the dialog open with the reason, and a retry closes it", async () => {
    // SCRUM-596 / F-28: the cockpit swallowed the refusal and the dialog closed
    // as if saved, so the operator never saw why the checklist stayed blocked.
    setupDeal();
    stubs.mutationFailures.set(
      "financeDealCosts:recordLegalInvoice",
      "The invoice date cannot be in the future."
    );
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    fireEvent.click(await screen.findByRole("button", { name: /RecordLegalInvoice/i }));
    fireEvent.change(screen.getByLabelText(/LegalInvoiceAmount/i), { target: { value: "15000" } });
    fireEvent.change(screen.getByLabelText(/LegalInvoiceNumber/i), { target: { value: "INV-999" } });
    fireEvent.change(screen.getByLabelText(/LegalInvoiceDate/i), { target: { value: "2026-09-15" } });
    fireEvent.click(screen.getByRole("button", { name: /SubmitLegalInvoice/i }));

    await waitFor(() => {
      expect(mutationCalls.get("financeDealCosts:recordLegalInvoice")).toHaveLength(1);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be in the future");
    expect((screen.getByLabelText(/LegalInvoiceNumber/i) as HTMLInputElement).value).toBe("INV-999");
    expect((screen.getByLabelText(/LegalInvoiceDate/i) as HTMLInputElement).value).toBe("2026-09-15");

    fireEvent.click(screen.getByRole("button", { name: /SubmitLegalInvoice/i }));
    await waitFor(() => {
      expect(mutationCalls.get("financeDealCosts:recordLegalInvoice")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/LegalInvoiceNumber/i)).toBeNull();
    });
  });

  test("renders Reconcile Fee action and binds reconcileDealFee mutation", async () => {
    setupDeal();
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const reconcileBtn = await screen.findByRole("button", { name: /ReconcileDealFee/i });
    expect(reconcileBtn).toBeTruthy();

    fireEvent.click(reconcileBtn);

    const notesInput = screen.getByLabelText(/ReconcileNotes/i);
    fireEvent.change(notesInput, { target: { value: "Verified against ministry receipt." } });

    const confirmBtn = screen.getByRole("button", { name: /ConfirmReconcile/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mutationCalls.get("financeDealCosts:reconcileDealFee")).toBeDefined();
    });

    expect(mutationCalls.get("financeDealCosts:reconcileDealFee")![0]).toMatchObject({
      orgId: ORG,
      feeId: "fee_1",
      notes: "Verified against ministry receipt.",
    });
  });

  // SCRUM-407: the manual classification is retired. The card shows the
  // server's automatic readiness instead, and offers no way to "classify".
  test("shows the server's closing readiness per check, and no classify action", async () => {
    setupDeal();
    queryResults.set("applications:getClosingReadiness", {
      state: "BLOCKED",
      open: true,
      moneyWithheld: false,
      checks: [
        { key: "REMITTANCE_KNOWN", status: "READY", reason: null },
        { key: "CUSTODY_SETTLED", status: "BLOCKED", reason: "A custody record on this deal is still open." },
        { key: "COSTS_CLOSABLE", status: "UNAVAILABLE", reason: "This deal has more than 500 live cost lines." },
        { key: "FIRST_PAYMENT_RECORDED", status: "NOT_APPLICABLE", reason: null },
      ],
    });
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const card = await screen.findByTestId("deal-closing-checklist");
    expect(within(card).getByTestId("closing-readiness").getAttribute("data-state")).toBe("BLOCKED");
    expect(within(card).getByText("ClosingReadinessStateBlocked")).toBeTruthy();
    const status = (key: string) => within(card).getByTestId(`closing-check-${key}`).getAttribute("data-status");
    expect(status("REMITTANCE_KNOWN")).toBe("READY");
    expect(status("CUSTODY_SETTLED")).toBe("BLOCKED");
    expect(status("COSTS_CLOSABLE")).toBe("UNAVAILABLE");
    expect(status("FIRST_PAYMENT_RECORDED")).toBe("NOT_APPLICABLE");
    // The blocking reason is the server's own sentence, shown beside its check.
    expect(
      within(within(card).getByTestId("closing-check-CUSTODY_SETTLED")).getByText(
        "A custody record on this deal is still open."
      )
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Classify/i })).toBeNull();
    expect(mutationCalls.size).toBe(0);
  });

  test("shows a loading line while the readiness read is in flight, never an empty verdict", async () => {
    setupDeal();
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const card = await screen.findByTestId("deal-closing-checklist");
    expect(within(card).getByTestId("closing-readiness-loading")).toBeTruthy();
    expect(within(card).queryByTestId("closing-readiness")).toBeNull();
  });

  // SCRUM-414 Codex R2: the frontend auto-deploys from main while the Convex
  // deploy is manual, so this screen can meet a backend that has no
  // `getClosingReadiness`. That must cost the panel its verdict, not the deal
  // screen its life.
  test("a backend without the readiness query: the panel says so calmly and every other action stays", async () => {
    setupDeal();
    queryResults.set(
      "applications:getClosingReadiness",
      new Error("[CONVEX Q(applications:getClosingReadiness)] Could not find public function for 'applications:getClosingReadiness'.")
    );
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const card = await screen.findByTestId("deal-closing-checklist");
    expect(within(card).getByTestId("closing-readiness-service-unavailable").textContent).toContain(
      "ClosingReadinessServiceUnavailable"
    );
    expect(within(card).queryByTestId("closing-readiness-loading")).toBeNull();
    expect(within(card).queryByTestId("closing-readiness")).toBeNull();
    // The rest of the cockpit is intact.
    expect(within(card).getByRole("button", { name: /RecordLegalInvoice/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ReconcileDealFee/i })).toBeTruthy();
    expect(mutationCalls.size).toBe(0);
  });

  test("a caller below the disbursement tier sees the readiness but is not offered the legal invoice", async () => {
    setupDeal();
    permissions.delete(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set("applications:getClosingReadiness", {
      state: "READY",
      open: true,
      moneyWithheld: true,
      checks: [{ key: "CUSTODY_SETTLED", status: "READY", reason: null }],
    });
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const card = await screen.findByTestId("deal-closing-checklist");
    expect(within(card).getByText("ClosingReadinessStateReady")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /RecordLegalInvoice/i })).toBeNull();
    expect(within(card).queryByTestId("deal-legal-invoice")).toBeNull();
  });

  // SCRUM-691 F-PNTR-5: production #pntr (CLOSED) still offered "Record legal
  // invoice" beside "no longer open to be closed"; `recordLegalInvoice`
  // refuses once `economicsFrozen` holds. The recorded invoice stays visible.
  test("a finalized deal shows its recorded invoice but no longer offers to record one", async () => {
    setupDeal();
    const costs = queryResults.get("financeDealCosts:listDealCosts") as Record<string, unknown>;
    queryResults.set("financeDealCosts:listDealCosts", {
      ...costs,
      economicsFrozen: { frozen: true, reason: "APPLICATION_CLOSED" },
      legalInvoiceAmountMinor: 10_850_000,
      legalInvoiceNumber: "INV-77",
      legalInvoiceDate: Date.UTC(2026, 9, 1),
      legalInvoiceIssuedTo: "FINANCE_COMPANY",
    });
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const card = await screen.findByTestId("deal-closing-checklist");
    expect(within(card).getByTestId("deal-legal-invoice")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /RecordLegalInvoice/i })).toBeNull();
  });
});
