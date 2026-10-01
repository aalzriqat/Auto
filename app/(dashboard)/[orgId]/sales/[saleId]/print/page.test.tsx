/**
 * SCRUM-258: the Bill of Sale totals come ONLY from `sales.getBillOfSaleEconomics`. The sale row
 * here carries deliberately wrong `loanAmount` / `downPayment` / `apr` / `termMonths` /
 * `tradeInValue`; none of them may reach the page. When the query has nothing authoritative (or
 * throws) the page says "unavailable" and the print button is disabled.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  sale: undefined as unknown,
  economics: undefined as unknown,
  economicsThrows: false,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "sales:get") return stubs.sale;
      if (name === "sales:getBillOfSaleEconomics") {
        if (stubs.economicsThrows) throw new Error("Could not find public function");
        return stubs.economics;
      }
      return undefined;
    },
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ saleId: "sale1" }),
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ dealershipName: "Test Motors", currencySymbol: "JD" }),
}));
vi.mock("@/components/print/DocumentLetterhead", () => ({ DocumentLetterhead: () => null }));

import PrintBillOfSalePage from "./page";

const sale = (financingType: "CASH" | "FINANCED") => ({
  _id: "sale1",
  financingType,
  saleDate: 1_700_000_000_000,
  salePrice: 13_000,
  dealerFees: 100,
  taxAmount: 50,
  warrantySold: 0,
  gapSold: 0,
  // Caller-supplied values that must never be printed.
  loanAmount: 111_111,
  downPayment: 222_222,
  apr: 77,
  termMonths: 99,
  tradeInValue: 333_333,
  vehicle: {
    make: "Kia", model: "Sportage", year: 2024, trim: "", vin: "VIN1", color: "Blue", mileage: 10, fuelType: "Gas",
  },
  customer: { firstName: "Buyer", lastName: "One" },
  salesperson: { name: "Rep" },
});

const cash = (over: Record<string, unknown>) => ({
  kind: "CASH", currency: "JOD", vehicle: 13_000, taxes: 50, dealerFees: 100, warranty: 0, gap: 0,
  vehicleSettledWithSupplier: false, totalBilled: 13_150, tradeInCredit: 0, depositsApplied: 0, balanceDue: 13_150, ...over,
});

afterEach(() => {
  cleanup();
  stubs.sale = undefined;
  stubs.economics = undefined;
  stubs.economicsThrows = false;
});

/** Intl separates the currency code with a no-break space; compare with a plain one. */
const textOf = (container: HTMLElement) => (container.textContent ?? "").replace(/\u00a0/g, " ");
const printButton = () => screen.getByRole("button", { name: /PrintDocumentBtn/ }) as HTMLButtonElement;

describe("Bill of Sale print page", () => {
  test("CASH: a consigned direct-to-supplier sale labels the car as paid to the supplier and bills 0 for it", () => {
    stubs.sale = sale("CASH");
    stubs.economics = cash({ vehicle: 0, vehicleSettledWithSupplier: true, totalBilled: 150, balanceDue: 150 });
    const { container } = render(<PrintBillOfSalePage />);
    expect(screen.getByText("VehiclePaidToSupplier")).toBeTruthy();
    expect(screen.queryByText("SalePrice")).toBeNull();
    const text = textOf(container);
    expect(text).toContain("JOD 0.000");
    // The sale row's own salePrice (13,000) is not a billed figure here and must not appear.
    expect(text).not.toContain("13,000");
  });

  test("CASH: warranty and GAP rows appear only when billed", () => {
    stubs.sale = sale("CASH");
    stubs.economics = cash({ warranty: 400, gap: 0, totalBilled: 13_550, balanceDue: 13_550 });
    render(<PrintBillOfSalePage />);
    expect(screen.getByText("ExtendedWarranty")).toBeTruthy();
    expect(screen.queryByText("GAPInsurance")).toBeNull();
  });

  test("a currency whose decimal scale is unknown is UNAVAILABLE, never printed at a guessed scale", () => {
    stubs.sale = sale("CASH");
    stubs.economics = cash({ currency: "XXX" });
    render(<PrintBillOfSalePage />);
    expect(screen.getByText("BillOfSaleFiguresUnavailable")).toBeTruthy();
    expect(printButton().disabled).toBe(true);
  });

  test("CASH: states the ledger figures and never the sale row's caller-supplied ones", () => {
    stubs.sale = sale("CASH");
    stubs.economics = cash({ totalBilled: 13_150, tradeInCredit: 2_000, depositsApplied: 500, balanceDue: 10_650 });
    const { container } = render(<PrintBillOfSalePage />);
    const text = textOf(container);
    expect(screen.getByText("BalanceDue")).toBeTruthy();
    // Three decimals: JOD. Every amount is rendered in economics.currency, not the org symbol.
    expect(text).toContain("JOD 13,150.000");
    expect(text).toContain("-JOD 2,000.000");
    expect(text).toContain("-JOD 500.000");
    expect(text).toContain("JOD 10,650.000");
    expect(text).not.toContain("JD");
    for (const lie of ["111,111", "222,222", "333,333", "77"]) expect(text).not.toContain(lie);
    expect(text).not.toMatch(/APR/i);
    expect(printButton().disabled).toBe(false);
  });

  test("CASH: a zero trade-in and zero deposits print no credit rows", () => {
    stubs.sale = sale("CASH");
    stubs.economics = cash({});
    render(<PrintBillOfSalePage />);
    expect(screen.queryByText("TradeInCredit")).toBeNull();
    expect(screen.queryByText("DepositsApplied")).toBeNull();
  });

  test("FINANCED: states the priced snapshot arithmetic and the flat annual profit rate, never APR", () => {
    stubs.sale = sale("FINANCED");
    stubs.economics = {
      kind: "FINANCED", currency: "JOD", vehiclePrice: 12_000, downPayment: 1_000, executionFees: 120,
      capitalisedCommission: 30, amountFinanced: 11_150, termMonths: 48, flatAnnualProfitRatePercent: 5,
    };
    const { container } = render(<PrintBillOfSalePage />);
    const text = textOf(container);
    expect(screen.getByText("AmountFinanced")).toBeTruthy();
    for (const figure of ["JOD 12,000.000", "-JOD 1,000.000", "+JOD 120.000", "+JOD 30.000", "JOD 11,150.000", "48", "5%"]) {
      expect(text).toContain(figure);
    }
    for (const lie of ["111,111", "222,222", "333,333", "99"]) expect(text).not.toContain(lie);
    expect(text).not.toMatch(/APR/i);
    expect(printButton().disabled).toBe(false);
  });

  test("FINANCED: a rate the quote never stated prints 'not stated', never 0%", () => {
    stubs.sale = sale("FINANCED");
    stubs.economics = {
      kind: "FINANCED", currency: "JOD", vehiclePrice: 12_000, downPayment: 0, executionFees: 0,
      capitalisedCommission: 0, amountFinanced: 12_000, termMonths: 48, flatAnnualProfitRatePercent: null,
    };
    const { container } = render(<PrintBillOfSalePage />);
    expect(container.textContent).toContain("RateNotStated");
    expect(container.textContent).not.toContain("0%");
    expect(screen.queryByText("CapitalisedCommission")).toBeNull();
  });

  test("UNAVAILABLE: says so, prints no number from the sale row, and disables printing", () => {
    stubs.sale = sale("FINANCED");
    stubs.economics = { kind: "UNAVAILABLE", reason: "NO_PRICING_SNAPSHOT" };
    const { container } = render(<PrintBillOfSalePage />);
    expect(screen.getByText("BillOfSaleFiguresUnavailable")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    const text = textOf(container);
    for (const lie of ["111,111", "222,222", "333,333"]) expect(text).not.toContain(lie);
    expect(printButton().disabled).toBe(true);
  });

  test("loading: a spinner stands in for the totals and printing is disabled", () => {
    stubs.sale = sale("CASH");
    render(<PrintBillOfSalePage />);
    expect(screen.queryByText("BalanceDue")).toBeNull();
    expect(printButton().disabled).toBe(true);
  });

  test("the economics query throwing shows the unavailable state, not a crash, and disables printing", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.sale = sale("CASH");
    stubs.economicsThrows = true;
    render(<PrintBillOfSalePage />);
    expect(screen.getByText("BillOfSaleFiguresUnavailable")).toBeTruthy();
    expect(screen.getByText("BillOfSaleUnavailable_LOAD_FAILED")).toBeTruthy();
    expect(printButton().disabled).toBe(true);
    consoleError.mockRestore();
  });
});
