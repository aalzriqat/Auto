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
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
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
    accountingClassification: "PENDING_CLASSIFICATION",
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

  test("renders Classify Deal Accounting trigger and binds classifyDealAccounting mutation", async () => {
    setupDeal();
    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    const classifyBtn = await screen.findByRole("button", { name: /ClassifyDealAccounting/i });
    expect(classifyBtn).toBeTruthy();

    fireEvent.click(classifyBtn);

    const notesInput = screen.getByLabelText(/ClassificationNotes/i);
    fireEvent.change(notesInput, { target: { value: "All invoices and fee receipts verified." } });

    const confirmBtn = screen.getByRole("button", { name: /ConfirmClassify/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mutationCalls.get("financeDealCosts:classifyDealAccounting")).toBeDefined();
    });

    expect(mutationCalls.get("financeDealCosts:classifyDealAccounting")![0]).toMatchObject({
      orgId: ORG,
      applicationId: APP,
      notes: "All invoices and fee receipts verified.",
    });
  });
});
