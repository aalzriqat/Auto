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

const stubs = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
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
      return async () => (name === "applications:createFromQuote" ? APP : null);
    },
  };
});
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => null }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatterInCurrency: () => (n: number) => String(n),
}));
vi.mock("@/lib/htmlToPdf", () => ({ downloadElementAsPdf: vi.fn(async () => true) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
