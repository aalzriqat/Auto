import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { SupplierPaymentDialog } from "./SupplierPaymentDialog";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("lang");
  vi.unstubAllGlobals();
});

function expectSupplierAmount({ locale, currency, expected, taxAmount, settlementAmountMinor }: {
  locale: "en" | "ar";
  currency: "JOD" | "USD";
  expected: string;
  taxAmount: string;
  settlementAmountMinor?: number | null;
}) {
  localStorage.setItem("autoflow-locale", locale);
  const dictionary = dictionaries[locale];
  render(
    <LanguageProvider>
      <SupplierPaymentDialog
        payable={{ vehicleDesc: "Camry", sourcedFromName: "Supplier", amountDue: 9999,
          settlementAmountMinor: settlementAmountMinor === undefined ? (currency === "JOD" ? 9250500 : 925050) : settlementAmountMinor, currency }}
        open isPaying={false} notes="" paymentMethod="CASH" bankAccountId={null}
        bankOptions={{ banks: [], truncated: false }} taxAmount={taxAmount} vatAllowed
        t={(key: keyof typeof dictionary) => dictionary[key]}
        onOpenChange={() => undefined} onNotesChange={() => undefined}
        onPaymentMethodChange={() => undefined} onBankAccountChange={() => undefined}
        onTaxAmountChange={() => undefined} onConfirm={() => undefined}
      />
    </LanguageProvider>,
  );

  const amount = screen.getByTestId("supplier-payment-amount");
  expect(amount?.textContent).toBe(expected);
  expect(amount?.dir).toBe("ltr");
  expect(screen.getByRole("dialog").getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(screen.getByRole("spinbutton")).toHaveProperty("value", taxAmount);
  if (settlementAmountMinor === null) {
    expect(screen.getByRole("alert").textContent).toBe(dictionary.ServerError_SUPPLIER_AMOUNT_PRECISION);
    expect(screen.getByRole("button", { name: dictionary.ConfirmPayment })).toHaveProperty("disabled", true);
  }
}

// SCRUM-761 requires non-parameterized titles to bind each permanent scenario.
test("SCRUM-880: EN supplier amount shows JOD scale and Latin digits", () => {
  expectSupplierAmount({ locale: "en", currency: "JOD", expected: "9,250.500 JOD", taxAmount: "12.345" });
});

test("SCRUM-880: AR supplier amount shows JOD scale and Latin digits", () => {
  expectSupplierAmount({ locale: "ar", currency: "JOD", expected: "9,250.500 JOD", taxAmount: "12.345" });
});

test("SCRUM-880: EN supplier amount shows USD scale and Latin digits", () => {
  expectSupplierAmount({ locale: "en", currency: "USD", expected: "9,250.50 USD", taxAmount: "12.34" });
});

test("SCRUM-880: AR supplier amount shows USD scale and Latin digits", () => {
  expectSupplierAmount({ locale: "ar", currency: "USD", expected: "9,250.50 USD", taxAmount: "12.34" });
});

test("SCRUM-880: EN invalid settlement shows a localized refusal and disables payment", () => {
  expectSupplierAmount({ locale: "en", currency: "JOD", expected: "— JOD", taxAmount: "", settlementAmountMinor: null });
});

test("SCRUM-880: AR invalid settlement shows a localized refusal and disables payment", () => {
  expectSupplierAmount({ locale: "ar", currency: "JOD", expected: "— JOD", taxAmount: "", settlementAmountMinor: null });
});

test("SCRUM-880: large settlement preserves every minor unit in the dialog", () => {
  expectSupplierAmount({ locale: "en", currency: "JOD", expected: "9,007,199,254,740.989 JOD",
    taxAmount: "", settlementAmountMinor: 9007199254740989 });
});
