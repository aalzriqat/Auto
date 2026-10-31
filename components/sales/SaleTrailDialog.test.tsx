import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  trail: undefined as unknown,
}));

vi.mock("convex/react", () => ({ useQuery: () => stubs.trail }));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org-test" }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    locale: stubs.locale,
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ format: (amount: number) => `${amount} JOD` }),
}));

import { SaleTrailDialog } from "./SaleTrailDialog";

type SaleTrail = NonNullable<FunctionReturnType<typeof api.sales.getSaleTrail>>;

afterEach(() => {
  cleanup();
  stubs.trail = undefined;
  stubs.locale = "en";
});

function trailWithCustomerInvoice(originalAmountMinor: number): SaleTrail {
  return {
    sale: { status: "COMPLETED", salePrice: 12_500, saleDate: Date.UTC(2026, 9, 11) },
    vehicle: null,
    customer: null,
    salespersonName: "Owner",
    deposits: [],
    saleJournalEntry: null,
    receivable: {
      documentNumber: "REC-CUSTOMER",
      originalAmountMinor,
      currency: "JOD",
      issueDate: Date.UTC(2026, 9, 11),
    },
    payments: [],
    supplierPayable: null,
    commissionJournalEntry: null,
    lead: null,
  } as unknown as SaleTrail;
}

test.each(["en", "ar"] as const)("zero customer invoice is shown as zero and noncollectible in %s Sale Trail", (locale) => {
  stubs.locale = locale;
  stubs.trail = trailWithCustomerInvoice(0);

  render(<SaleTrailDialog open onOpenChange={() => undefined} saleId={"sale-test" as Id<"sales">} />);
  const invoiceStep = screen.getByText(/REC-CUSTOMER/);
  expect(invoiceStep.textContent).toContain("0");
  expect(invoiceStep.textContent).toContain((dictionaries[locale] as Record<string, string>).StepNoCustomerAmountDue);
  expect(invoiceStep.textContent).not.toContain("12,500");
});

test("a nonzero customer invoice shows its own amount instead of the sale price", () => {
  stubs.trail = trailWithCustomerInvoice(2_500_000);
  render(<SaleTrailDialog open onOpenChange={() => undefined} saleId={"sale-test" as Id<"sales">} />);
  const invoiceStep = screen.getByText(/REC-CUSTOMER/);
  expect(invoiceStep.textContent).toContain("2,500");
  expect(invoiceStep.textContent).not.toContain("12,500");
  expect(invoiceStep.textContent).not.toContain(dictionaries.en.StepNoCustomerAmountDue);
});
