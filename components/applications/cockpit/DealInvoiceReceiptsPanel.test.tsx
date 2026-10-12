/**
 * SCRUM-724 pilot containment in the deal's receipts panel: while the backend
 * reports the sale-invoice doors / retained-credit payout as unavailable (or does
 * not report them at all - a frontend deployed before the manual backend deploy),
 * the panel shows the reason and offers no action the backend would refuse.
 * Depositing / clearing an already-presented cheque stays available.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  status: undefined as unknown,
  cheques: [] as Array<Record<string, unknown>>,
  credits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: () => true }),
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) =>
      args === "skip" || getFunctionName(reference) !== "collections:saleInvoiceReceiptStatus" ? undefined : stubs.status,
    usePaginatedQuery: (reference: never) => {
      const name = getFunctionName(reference);
      const results = name === "collections:listSaleCustomerCheques" ? stubs.cheques : stubs.credits;
      return { results, status: "Exhausted", loadMore: () => {} };
    },
    useMutation: () => vi.fn(),
  };
});

import { DealInvoiceReceiptsPanel } from "./DealInvoiceReceiptsPanel";

const baseStatus = (over: Record<string, unknown>) => ({
  page: [], isDone: true, continueCursor: "", customerId: "c1", saleStatus: "COMPLETED",
  receiptCurrency: "JOD",
  invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 100000, availableToReserveMinor: 100000 },
  ...over,
});

const credit = {
  receiptMovementId: "m1", availableUnappliedMinor: 3000, currency: "JOD", receiptPosted: true,
  createdAt: 1, sourceChequeLabel: "Arab Bank #1", originatingSaleStatus: "CANCELLED",
};
const heldCheque = { chequeId: "q1", bank: "Arab Bank", chequeNumber: "1", chequeDate: 1, amount: 30, status: "HELD" };
const depositedCheque = { ...heldCheque, chequeId: "q2", status: "DEPOSITED" };

function renderPanel() {
  render(<DealInvoiceReceiptsPanel orgId={"org1" as never} saleId={"sale1" as never} />);
}

afterEach(() => {
  cleanup();
  stubs.status = undefined;
  stubs.cheques = [];
  stubs.credits = [];
});

describe("DealInvoiceReceiptsPanel under the SCRUM-724 pilot switches", () => {
  test.each([
    ["flags false", { saleInvoiceDoorsAvailable: false, retainedCreditPayoutAvailable: false }],
    ["flags absent (older backend)", {}],
  ])("%s: no record / register / reserve / activate / refund actions, reason shown", (_label, flags) => {
    stubs.status = baseStatus({
      ...flags,
      page: [{ applicationId: "a1", receiptMovementId: "m1", amountMinor: 1000, currency: "JOD",
        createdAt: 1, readiness: "ORIGINS_VERIFIED" }],
    });
    stubs.credits = [credit];
    stubs.cheques = [heldCheque];
    renderPanel();
    expect(screen.getByTestId("deal-invoice-doors-unavailable")).toBeTruthy();
    expect(screen.getByText("SaleInvoiceDoorsUnavailable")).toBeTruthy();
    expect(screen.getByTestId("deal-credit-payout-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "DealReceiptRecordButton" })).toBeNull();
    expect(screen.queryByRole("button", { name: "DealReceiptRegisterCheque" })).toBeNull();
    expect(screen.queryByRole("button", { name: "DealReceiptChooseCredit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "DealReceiptTryActivateButton" })).toBeNull();
    expect(screen.queryByRole("button", { name: "RetainedCreditRequestRefund" })).toBeNull();
  });

  test("flags true: the actions are offered (the panel is switch-driven, not hard-coded off)", () => {
    stubs.status = baseStatus({ saleInvoiceDoorsAvailable: true, retainedCreditPayoutAvailable: true });
    stubs.credits = [credit];
    renderPanel();
    expect(screen.queryByTestId("deal-invoice-doors-unavailable")).toBeNull();
    expect(screen.getByRole("button", { name: "DealReceiptRecordButton" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DealReceiptRegisterCheque" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "RetainedCreditRequestRefund" })).toBeTruthy();
  });

  test("with the doors off, an already-presented (DEPOSITED) cheque can still be cleared, even on a fully covered or cancelled sale", () => {
    stubs.status = baseStatus({
      saleStatus: "CANCELLED", saleInvoiceDoorsAvailable: false, retainedCreditPayoutAvailable: false,
      invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 0, availableToReserveMinor: 0 },
    });
    stubs.cheques = [depositedCheque, heldCheque];
    renderPanel();
    expect(screen.getAllByRole("button", { name: "DealReceiptClearCheque" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "DealReceiptDepositCheque" })).toBeNull();
  });

  test("a status that has not loaded renders a loading state, never a crash", () => {
    stubs.status = undefined;
    renderPanel();
    expect(screen.getByText("Loading")).toBeTruthy();
  });
});
