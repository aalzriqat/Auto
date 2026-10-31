import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { SupplierSettlementPilotMethod } from "@/convex/utils/supplierSettlementContainment";

let locale: "en" | "ar" = "en";
vi.mock("@/components/providers/LanguageProvider", () => ({ useLanguage: () => ({ locale }) }));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) =>
    <select aria-label="method" value={value} onChange={(event) => onValueChange(event.target.value)}>
      <option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option>
    </select>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value?: string; onValueChange: (value: string) => void; children: React.ReactNode }) =>
    <select aria-label="bank" value={value ?? ""} onChange={(event) => onValueChange(event.target.value)}><option value="" />{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));

import { SupplierPaymentDialog } from "./SupplierPaymentDialog";

afterEach(cleanup);

test.each(["en", "ar"] as const)("%s supplier payment requires a selected bank", (language) => {
  locale = language;
  const confirm = vi.fn();
  function Harness() {
    const [paymentMethod, setPaymentMethod] = useState<SupplierSettlementPilotMethod>("CASH");
    const [bankAccountId, setBankAccountId] = useState<Id<"bankAccounts"> | null>(null);
    return <SupplierPaymentDialog
      payable={{ vehicleDesc: "Camry", sourcedFromName: "Supplier", amountDue: 100, currency: "JOD" }}
      open isPaying={false} notes="" paymentMethod={paymentMethod} bankAccountId={bankAccountId}
      bankOptions={{ banks: [{ _id: "bank_1" as Id<"bankAccounts">, name: "Operating", currency: "JOD" }], truncated: false }}
      taxAmount="" vatAllowed t={(key) => key} onOpenChange={() => undefined} onNotesChange={() => undefined}
      onPaymentMethodChange={setPaymentMethod} onBankAccountChange={setBankAccountId}
      onTaxAmountChange={() => undefined} onConfirm={confirm}
    />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("method"), { target: { value: "BANK_TRANSFER" } });
  expect(screen.getByText(language === "ar" ? "الحساب المصرفي المدفوع منه" : "Bank account paid from")).toBeTruthy();
  expect(screen.getByRole("button", { name: "ConfirmPayment" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("bank"), { target: { value: "bank_1" } });
  expect(screen.getByRole("button", { name: "ConfirmPayment" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "ConfirmPayment" }));
  expect(confirm).toHaveBeenCalledOnce();
});
