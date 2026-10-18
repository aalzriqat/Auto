import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { CommissionPaymentDialog } from "./CommissionPaymentDialog";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

afterEach(cleanup);

const base = {
  commission: { salespersonName: "Seller", vehicleSummary: "Car", amountLabel: "10.000 JOD" },
  open: true,
  isPaying: false,
  paymentMethod: "BANK_TRANSFER" as const,
  bankAccountId: "",
  bankOptions: {
    banks: [{ _id: "bank_a" as Id<"bankAccounts">, name: "Bank A", currency: "JOD" }],
    truncated: false,
  },
  uncertain: false,
  retryBankName: null,
  onOpenChange: vi.fn(),
  onPaymentMethodChange: vi.fn(),
  onBankChange: vi.fn(),
  onConfirm: vi.fn(),
};

describe("commission payment bank choice", () => {
  test("a bank transfer requires an explicit bank selection", () => {
    render(<CommissionPaymentDialog {...base} t={(key) => ({
      DirectPaymentBankLabel: "Bank account paid from",
      DirectPaymentBankChoose: "Select the paying bank",
    } as Record<string, string>)[key] ?? key} />);
    expect(screen.getByRole("combobox", { name: "Bank account paid from" }).textContent)
      .toContain("Select the paying bank");
  });

  test("an uncertain Arabic retry keeps the original bank visible when options disappear", () => {
    render(<CommissionPaymentDialog
      {...base}
      bankAccountId="bank_a"
      bankOptions={{ banks: [], truncated: false }}
      uncertain
      retryBankName="بنك ألف"
      t={(key) => ({
        DirectPaymentBankLabel: "الحساب المصرفي المدفوع منه",
        CommissionRetryOriginalBank: "إعادة المحاولة بالحساب المصرفي الأصلي:",
        CommissionRetrySameDetails: "أعد المحاولة بنفس التفاصيل.",
      } as Record<string, string>)[key] ?? key}
    />);
    expect(screen.getByText("بنك ألف")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "الحساب المصرفي المدفوع منه" })).toBeNull();
  });
});
