/**
 * SCRUM-571 D-48 (F4): the cockpit names what the customer still owes on the deal's invoice, as its
 * own tile and not on the CUSTOMER party row (which states the held deposit). Rendered through the
 * REAL cash container with the REAL dictionaries, once per locale, so a missing or wrong translation
 * shows up as a key or as the wrong words rather than as a plausible default.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  queryResults: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[stubs.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
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

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    permissions: [],
    isLoading: false,
    isOwner: true,
    hasPermission: () => true,
    role: "OWNER",
    membership: { roleName: "OWNER", permissions: [] },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))])
      ),
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: () => vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { SaleDealCockpit } from "./DealCockpit";

type CashDealCockpitData = NonNullable<(typeof api.sales.dealCockpit)["_returnType"]>;
type Invoice = NonNullable<CashDealCockpitData["money"]>["customerInvoice"];

const ORG = "org1" as Id<"organizations">;
const SALE = "sale_7731" as Id<"sales">;
const SCALE = 1_000;

function ownedCashDeal(invoice: Invoice, withMoney = true): CashDealCockpitData {
  return {
    dealKind: "CASH",
    financingApplicationId: null,
    dealRef: "sale_7731",
    saleId: SALE,
    applicationId: null,
    status: "COMPLETED",
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: undefined,
    customer: { id: "c1" as Id<"customers">, name: "Samer", phone: "0790112233" },
    vehicle: {
      id: "v1" as Id<"vehicles">,
      label: "Kia Rio 2023",
      vin: "KNADN512XM6000001",
      consigned: false,
      supplierName: undefined,
      profile: null,
    },
    salespersonName: "Laith",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    customerInvoiceState: invoice.state,
    stages: [
      { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
      { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
      { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
    ],
    documents: [],
    timeline: [],
    money: withMoney
      ? {
          currency: "JOD",
          settlesDirectToSupplier: false,
          routeKnown: true,
          profit: {
            available: true,
            basis: "ACCOUNTING_RESULT",
            amountMinor: 2_000 * SCALE,
            currency: "JOD",
            reconcilesToLedger: true,
            lines: [{ key: "SALE_PRICE", sign: 1, amountMinor: 8_000 * SCALE }],
          },
          expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
          parties: [],
          customerInvoice: invoice,
          supplierReceipt: { actionable: false, reason: "NOT_DIRECT_ROUTE" },
          appraisalGapMinor: undefined,
          shortfall: undefined,
        }
      : null,
  } satisfies CashDealCockpitData;
}

function mount(deal: CashDealCockpitData) {
  stubs.queryResults.set("sales:dealCockpit", deal);
  render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.locale = "en";
});

const COPY = {
  en: { label: "Customer invoice balance", owed: "Still to collect", settled: "Settled", unproven: "Not confirmed yet", open: "The customer's invoice is still open" },
  ar: { label: "المتبقي على فاتورة العميل", owed: "متبقٍ تحصيله", settled: "مسوَّاة", unproven: "لم يُتحقَّق منه بعد", open: "فاتورة العميل لا تزال مفتوحة" },
} as const;

describe.each(["en", "ar"] as const)("the customer's invoice tile (%s)", (locale) => {
  const copy = COPY[locale];

  test("an open invoice names the balance still to collect, beside nothing but its own label", () => {
    stubs.locale = locale;
    mount(ownedCashDeal({ state: "OPEN", outstandingMinor: 8_000 * SCALE, currency: "JOD" }));
    const tile = screen.getByTestId("deal-customer-invoice");
    expect(within(tile).getByText(copy.label)).toBeTruthy();
    expect(within(tile).getByText(copy.owed)).toBeTruthy();
    expect(within(tile).getByText(/8[,.]?000/)).toBeTruthy();
  });

  test("a paid invoice reads settled with nothing outstanding", () => {
    stubs.locale = locale;
    mount(ownedCashDeal({ state: "CLOSED", outstandingMinor: 0, currency: "JOD" }));
    const tile = screen.getByTestId("deal-customer-invoice");
    expect(within(tile).getByText(copy.settled)).toBeTruthy();
  });

  test("an unproven invoice states no amount and says so, never a zero", () => {
    stubs.locale = locale;
    mount(ownedCashDeal({ state: "UNKNOWN", outstandingMinor: null, currency: "JOD" }));
    const tile = screen.getByTestId("deal-customer-invoice");
    expect(within(tile).getByText(copy.unproven)).toBeTruthy();
    expect(within(tile).queryByText(copy.settled)).toBeNull();
  });

  test("before an invoice exists no tile is shown", () => {
    stubs.locale = locale;
    mount(ownedCashDeal({ state: "NONE", outstandingMinor: null, currency: "JOD" }));
    expect(screen.queryByTestId("deal-customer-invoice")).toBeNull();
  });

  test("a caller without finance sees only the qualitative state, with no amount", () => {
    stubs.locale = locale;
    mount(ownedCashDeal({ state: "OPEN", outstandingMinor: null, currency: "JOD" }, false));
    expect(screen.getByTestId("deal-customer-invoice-state").textContent).toContain(copy.open);
    expect(screen.queryByTestId("deal-customer-invoice")).toBeNull();
  });
});

describe("the new copy has verified Arabic", () => {
  test.each(["CustomerInvoiceBalance", "CustomerInvoiceUnproven", "CustomerInvoiceStateOpen"])("%s exists in both dictionaries", (key) => {
    expect((dictionaries.en as Record<string, string>)[key]).toBeTruthy();
    expect((dictionaries.ar as Record<string, string>)[key]).toBeTruthy();
    expect((dictionaries.ar as Record<string, string>)[key]).not.toBe((dictionaries.en as Record<string, string>)[key]);
  });
});
