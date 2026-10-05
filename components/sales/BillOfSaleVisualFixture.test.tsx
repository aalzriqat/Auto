/**
 * SCRUM-258 Gate B bridge: renders the REAL Bill of Sale print page
 * (`app/(dashboard)/[orgId]/sales/[saleId]/print/page.tsx`) with the REAL
 * dictionaries, once per economics state and locale, for
 * `playwright/visual/bill-of-sale.visual.spec.ts`.
 *
 * Only data hooks are mocked (Convex useQuery by function name, router, org,
 * org settings, language). The page's own EconomicsBoundary is exercised: for
 * `load-failed` the economics query throws and the markup captured is what the
 * boundary fallback paints, i.e. what the user actually sees.
 *
 * Gated on `BILL_OF_SALE_VISUAL_FIXTURE=1`; writes only into the fresh per-run
 * directory named by `BILL_OF_SALE_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stub = vi.hoisted(() => ({
  locale: "en" as "ar" | "en",
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
      if (name === "sales:get") return stub.sale;
      if (name === "sales:getBillOfSaleEconomics") {
        if (stub.economicsThrows) throw new Error("Could not find public function");
        return stub.economics;
      }
      if (name === "orgSettings:getLogoUrl") return null;
      return undefined;
    },
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ saleId: "sale1" }),
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[stub.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: stub.locale === "ar",
    locale: stub.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useOrgSettings", () => {
  const settings = {
    dealershipName: "Amman Premier Motors",
    legalCompanyName: "Amman Premier Motors Trading Co.",
    primaryColor: "#0f172a",
    currencySymbol: "JOD",
  };
  return { useOrgSettings: () => settings };
});

import PrintBillOfSalePage from "@/app/(dashboard)/[orgId]/sales/[saleId]/print/page";

const GENERATE = process.env.BILL_OF_SALE_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.BILL_OF_SALE_VISUAL_FIXTURE_DIR;

afterEach(cleanup);

const sale = (locale: "en" | "ar", financingType: "CASH" | "FINANCED") => ({
  _id: "sale1",
  financingType,
  saleDate: Date.UTC(2026, 8, 24, 9, 0, 0),
  vehicle: {
    make: "Toyota", model: "Land Cruiser", year: 2023, trim: "VXR", vin: "JTMHV05J904123456",
    color: locale === "ar" ? "أبيض" : "White", mileage: 24_500, fuelType: locale === "ar" ? "بنزين" : "Petrol",
  },
  customer: locale === "ar"
    ? { firstName: "خالد", lastName: "المصري", address: "عمّان، الشميساني، شارع عبد الحميد شرف", phone: "+962 79 555 0142", email: "khaled.masri@example.com", nationalId: "9871012345" }
    : { firstName: "Omar", lastName: "Haddad", address: "Abdoun, Amman", phone: "+962 79 555 0142", email: "omar.haddad@example.com", nationalId: "9871012345" },
  salesperson: { name: locale === "ar" ? "ليث العمري" : "Layth Omari" },
});

type State = {
  name: string;
  financingType: "CASH" | "FINANCED";
  economics?: unknown;
  throws?: boolean;
};

const cashFull = {
  kind: "CASH", currency: "JOD", vehicle: 18_500, taxes: 2_960, dealerFees: 250, warranty: 600, gap: 300,
  vehicleSettledWithSupplier: false, totalBilled: 22_610, tradeInCredit: 6_000, depositsApplied: 1_000, balanceDue: 15_610,
};
const financed = {
  kind: "FINANCED", currency: "JOD", vehiclePrice: 20_000, downPayment: 5_000, executionFees: 150,
  capitalisedCommission: 400, amountFinanced: 15_550, termMonths: 48, flatAnnualProfitRatePercent: 6.5,
};

const STATES: State[] = [
  { name: "cash-full", financingType: "CASH", economics: cashFull },
  {
    name: "cash-consigned-direct", financingType: "CASH",
    economics: {
      kind: "CASH", currency: "JOD", vehicle: 0, taxes: 0, dealerFees: 350, warranty: 0, gap: 0,
      vehicleSettledWithSupplier: true, totalBilled: 350, tradeInCredit: 0, depositsApplied: 0, balanceDue: 350,
    },
  },
  { name: "financed", financingType: "FINANCED", economics: financed },
  {
    name: "financed-no-rate", financingType: "FINANCED",
    economics: { ...financed, flatAnnualProfitRatePercent: null, capitalisedCommission: 0, amountFinanced: 15_150 },
  },
  { name: "unavailable-default", financingType: "CASH", economics: { kind: "UNAVAILABLE", reason: "DOES_NOT_FOOT" } },
  { name: "unavailable-not-completed", financingType: "CASH", economics: { kind: "UNAVAILABLE", reason: "NOT_COMPLETED" } },
  { name: "load-failed", financingType: "CASH", throws: true },
  { name: "loading", financingType: "CASH", economics: undefined },
];

describe.skipIf(!GENERATE)("SCRUM-258 Bill of Sale visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup for every state", (locale) => {
    expect(OUT_DIR, "BILL_OF_SALE_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    const table = dictionaries[locale] as Record<string, string>;
    for (const key of [
      "PrintDocumentBtn", "BillOfSaleFiguresUnavailable", "BillOfSaleUnavailable_DEFAULT",
      "BillOfSaleUnavailable_NOT_COMPLETED", "BillOfSaleUnavailable_LOAD_FAILED", "TotalBilled", "BalanceDue",
      "AmountFinanced", "CapitalisedCommission", "RateNotStated", "FlatAnnualProfitRate", "VehiclePaidToSupplier",
    ]) {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
    }
    // The spec finds the print button by the dictionary's own label.
    writeFileSync(
      resolve(OUT_DIR!, `labels-${locale}.json`),
      JSON.stringify({ print: table.PrintDocumentBtn, back: table.Back }),
    );
    // The boundary logs the thrown query on purpose; keep the run output readable.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const state of STATES) {
        stub.locale = locale;
        stub.sale = sale(locale, state.financingType);
        stub.economics = state.economics;
        stub.economicsThrows = state.throws === true;
        const { container } = render(<PrintBillOfSalePage />);
        const html = container.innerHTML;
        expect(html, `${state.name}/${locale} painted nothing`).toContain("printable-area");
        if (state.name === "load-failed") expect(html).toContain(table.BillOfSaleUnavailable_LOAD_FAILED);
        if (state.name === "cash-full" && locale === "en") expect(html).toContain("22,610.000");
        if (state.name === "loading") expect(html).toContain("animate-spin");
        writeFileSync(resolve(OUT_DIR!, `${state.name}-${locale}.html`), html);
        cleanup();
      }
    } finally {
      consoleError.mockRestore();
      stub.economicsThrows = false;
    }
  });
});
