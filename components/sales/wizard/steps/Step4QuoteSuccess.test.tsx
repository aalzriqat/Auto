/**
 * SCRUM-417 — once the finance application exists, the wizard's single primary
 * action opens THAT deal (the screen that names its next step), not the Deals
 * list where the operator had to find it again. Nothing navigates on its own.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const ORG = "org_1" as Id<"organizations">;
const QUOTE = "quote_1" as Id<"quotes">;
const APP = "app_2048" as Id<"financeApplications">;

const stubs = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  toastError: vi.fn(),
  /** When set, `t` resolves keys from it (the real dictionary); otherwise `t` is the identity. */
  dictionary: null as Record<string, string> | null,
  /** When set, `sales.completeFromQuote` rejects with it. */
  completeError: null as unknown,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => stubs.dictionary?.[key] ?? key,
    isRtl: stubs.dictionary !== null,
    locale: stubs.dictionary !== null ? "ar" : "en",
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: ORG }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: stubs.push, replace: stubs.replace }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "financingEconomics:previewCreationQuotation") {
        return { available: false, reason: "NOT_CONFIGURED_COMPANY" };
      }
      if (name === "quotes:get") return { _id: QUOTE, items: [] };
      if (name === "users:getMe") return { _id: "user_1" };
      return null;
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async () => {
        if (name === "sales:completeFromQuote" && stubs.completeError) throw stubs.completeError;
        return name === "applications:createFromQuote" ? APP : null;
      };
    },
  };
});
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => null }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatterInCurrency: () => (n: number) => String(n),
}));
vi.mock("@/lib/htmlToPdf", () => ({ downloadElementAsPdf: vi.fn(async () => true) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: stubs.toastError } }));
vi.mock("@/components/deposits/QuoteDepositManager", () => ({ QuoteDepositManager: () => null }));
vi.mock("../../ConsignedSettlementSection", () => ({ ConsignedSettlementSection: () => null }));
vi.mock("../components/RecordDepositDialog", () => ({ RecordDepositDialog: () => null }));
vi.mock("../../QuotePrintTemplate", () => ({ QuotePrintTemplate: () => null }));
vi.mock("../../ReceiptVoucherPrintTemplate", () => ({ ReceiptVoucherPrintTemplate: () => null }));

import { Step4QuoteSuccess } from "./Step4QuoteSuccess";

afterEach(() => {
  cleanup();
  stubs.push.mockClear();
  stubs.replace.mockClear();
  stubs.toastError.mockClear();
  stubs.dictionary = null;
  stubs.completeError = null;
});

describe("Step4QuoteSuccess — the started application opens its own deal", () => {
  test("after starting the application, the primary link targets that application's deal", async () => {
    render(
      <Step4QuoteSuccess
        paymentType="INSTALLMENT"
        wizardData={{} as never}
        selectedCustomer={{ firstName: "سامي", lastName: "خليل" } as Doc<"customers">}
        quoteId={QUOTE}
        selectedResult={null}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /StartFinanceApplication/ }));
    const link = await waitFor(() => screen.getByRole("link", { name: /ViewApplication/ }));
    expect(link.getAttribute("href")).toBe(`/${ORG}/applications/${APP}/deal`);
    // No auto-navigation: the operator chooses when to leave the wizard.
    expect(stubs.push).not.toHaveBeenCalled();
    expect(stubs.replace).not.toHaveBeenCalled();
  });
});

describe("Step4QuoteSuccess — SCRUM-69 refusal is shown in the user's language", () => {
  test("ar locale: the finance-held-car refusal renders the Arabic string, not the English server text", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    stubs.dictionary = dictionaries.ar as Record<string, string>;
    const { ConvexError } = await import("convex/values");
    stubs.completeError = new ConvexError({
      code: "SALE_COMPLETES_THROUGH_FINANCE_APPLICATION",
      message: "This car has a finance application in progress. Complete the sale from the deal page.",
    });

    render(
      <Step4QuoteSuccess
        paymentType="CASH"
        wizardData={{} as never}
        selectedCustomer={{ firstName: "سامي", lastName: "خليل" } as Doc<"customers">}
        quoteId={QUOTE}
        selectedResult={null}
        onClose={() => {}}
      />
    );

    // The Submit button's label is a key `t` resolves; the only enabled outline
    // button that is not a deposit control is the submit one.
    const submit = screen.getByRole("button", { name: stubs.dictionary.SubmitSale });
    fireEvent.click(submit);

    await waitFor(() => expect(stubs.toastError).toHaveBeenCalledTimes(1));
    expect(stubs.toastError).toHaveBeenCalledWith(
      "هذه السيارة عليها طلب تمويل قيد المعالجة. أكمل البيع من صفحة الصفقة."
    );
  });
});
