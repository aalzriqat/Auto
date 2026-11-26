/**
 * SCRUM-1018 - "Confirm payment" on the first-payment evidence asks where the
 * customer paid. Paid at the showroom opens THE deposit dialog of this page's
 * "Deposit receipts" section (one dialog, one mutation), offered exactly when
 * that section offers "Record deposit" enabled; paid to the finance company opens
 * the evidence form. Production deal D-000024 nearly recorded showroom cash as
 * finance-company evidence.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import type { DealCockpitData, FinanceDecisionWiring } from "./DealCockpit";
import type { DealQuoteDepositReceiptsProps } from "./DealQuoteDepositReceipts";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", symbol: "JOD", displayLabel: "JOD", format: String, formatCompact: String }),
}));
vi.mock("@/components/accounting/AccountingTabShared", () => ({ scaleForCurrency: () => 3 }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("convex/react")>(),
  useQuery: (reference: FunctionReference<"query">) => {
    const name = getFunctionName(reference);
    if (name === "customerFinanceCompanyPayments:firstPayment") {
      return {
        proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
        agreement: "agreement-1", canConfirm: true, canVoid: true, closed: false, records: [],
      };
    }
    if (name === "paymentVouchers:listQuoteReceipts") return { receipts: [] };
    if (name.startsWith("delivered")) return null;
    return undefined;
  },
  useMutation: () => vi.fn(),
}));
// The deposit form itself is covered by its own suite; here only WHICH dialog opens, for which quote.
vi.mock("@/components/sales/wizard/components/RecordDepositDialog", () => ({
  RecordDepositDialog: ({ open, quoteId }: { open: boolean; quoteId: string }) =>
    open ? <div role="dialog" aria-label="deposit-dialog" data-quote-id={quoteId} /> : null,
}));

import { DealCockpitView } from "./DealCockpit";

const orgId = "org_1" as Id<"organizations">;
const applicationId = "app_2048" as Id<"financeApplications">;
const quoteId = "quote_1" as Id<"quotes">;

function deal(): DealCockpitData {
  return {
    dealKind: "FINANCED", economicsStamp: "v2|7", denomination: { code: "JOD", scale: 3 }, economicsRecorded: true,
    dealRef: "app_2048", applicationId: "app_2048", saleId: null, canonicalSaleId: null, status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28), updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "Customer", phone: "0790112233" },
    vehicle: { id: "v1", label: "Vehicle", vin: "VIN", consigned: false, supplierName: "" },
    salespersonName: "Sales", financeCompanyName: "Lender",
    settlementAdviceRequiresReconciliation: false, settlementAdviceDiscrepancy: null,
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "NoApprovedPurchaseAmount" },
      { key: "SETTLEMENT", state: "PENDING" },
    ],
    documents: [], timeline: [], money: null,
  } as unknown as DealCockpitData;
}

const noop = async () => {};
const financeDecision = {
  currency: "JOD", canRecordQuotation: true, canRecordApproval: true, canEstablishLtvPercent: true, isOwnDeal: false,
  calculation: { state: "UNAVAILABLE" }, appraisal: null, canRecordAppraisal: true,
  onRecordQuotation: noop, onRecordApproved: noop, onReopenApproved: noop, onRecordAppraisal: noop,
  firstPaymentEvidence: { orgId, applicationId },
  facts: {
    approvedPurchaseRecorded: false, submittedQuotationMinor: null, approvedPurchaseAmountMinor: null,
    financeCompanyFundedPortionMinor: null, unfinancedPortionMinor: null, dealerContributionMinor: null,
    appliedLtvPercent: null, closed: false, ltvMissing: false, handedOver: false, appraisalAmountMinor: null,
  },
} as unknown as FinanceDecisionWiring;

function renderDeal(receipts: Partial<DealQuoteDepositReceiptsProps> = {}) {
  render(
    <DealCockpitView
      deal={deal()}
      financeDecision={financeDecision}
      onRecordSupplierReceipt={noop}
      quoteDepositReceipts={{ orgId, quoteId, receiptQuoteId: quoteId, canRecord: true, hasPendingRequest: false, ...receipts }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "CustFcPayConfirmAction" }));
}

afterEach(cleanup);

describe("first payment paid at the showroom", () => {
  test("opens the deposit section's own dialog for the deal's receipt quote, not the evidence form", () => {
    renderDeal();
    fireEvent.click(screen.getByRole("button", { name: "FirstPaymentPaidShowroom" }));
    const deposit = screen.getByRole("dialog", { name: "deposit-dialog" });
    expect(deposit.getAttribute("data-quote-id")).toBe(quoteId);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "CustFcPayDialogTitle" })).toBeNull();
  });

  test("the deposit section's own button still opens that same dialog", () => {
    renderDeal();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "FirstPaymentWherePaidTitle" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "RecordDeposit" }));
    expect(screen.getByRole("dialog", { name: "deposit-dialog" }).getAttribute("data-quote-id")).toBe(quoteId);
  });

  test.each([
    ["the role may only request a deposit", { canRecord: false }],
    ["a deposit request is waiting", { hasPendingRequest: true }],
    ["the deal has no receipt quote", { receiptQuoteId: undefined }],
  ])("is unavailable when %s", (_case, receipts) => {
    renderDeal(receipts);
    expect((screen.getByRole("button", { name: "FirstPaymentPaidShowroom" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("FirstPaymentPaidShowroomUnavailable")).toBeTruthy();
    expect((screen.getByRole("button", { name: "FirstPaymentPaidFinanceCompany" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("paid to the finance company opens the evidence form and no deposit dialog", () => {
    renderDeal();
    fireEvent.click(screen.getByRole("button", { name: "FirstPaymentPaidFinanceCompany" }));
    expect(screen.getByRole("dialog", { name: "CustFcPayDialogTitle" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "deposit-dialog" })).toBeNull();
  });
});
