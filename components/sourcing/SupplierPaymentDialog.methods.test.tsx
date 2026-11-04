/**
 * SCRUM-869 supplier payable payment: the dialog offers only the methods the
 * server accepts. A cheque or card payment has no issued-cheque / settlement
 * lifecycle and `markPaid` / `recordPartialPayment` refuse both, so offering
 * them would invite a payment that can only fail.
 */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SUPPLIER_SETTLEMENT_PILOT_METHODS } from "@/convex/utils/supplierSettlementContainment";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { SupplierPaymentDialog } from "./SupplierPaymentDialog";

beforeAll(() => {
  // Radix Select needs these in jsdom, as in MoneyMethodVisualFixture.test.tsx.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function renderDialog() {
  return render(
    <SupplierPaymentDialog
      payable={{ vehicleDesc: "Camry", sourcedFromName: "Supplier", amountDue: 100, settlementAmountMinor: 100000, currency: "JOD" }}
      open isPaying={false} notes="" paymentMethod="CASH" bankAccountId={null}
      bankOptions={undefined} taxAmount="" vatAllowed t={(key) => key}
      onOpenChange={() => undefined} onNotesChange={() => undefined}
      onPaymentMethodChange={() => undefined} onBankAccountChange={() => undefined}
      onTaxAmountChange={() => undefined} onConfirm={() => undefined}
    />
  );
}

test("the supplier payment picker offers only cash and bank transfer, the server's own list", () => {
  renderDialog();
  fireEvent.keyDown(screen.getAllByRole("combobox")[0]!, { key: "Enter", code: "Enter" });
  const offered = screen.getAllByRole("option").map((option) => option.textContent);
  expect(offered).toEqual(["PaymentMethod_CASH", "PaymentMethod_BANK_TRANSFER"]);
  expect(offered).toEqual(SUPPLIER_SETTLEMENT_PILOT_METHODS.map((method) => `PaymentMethod_${method}`));
  expect(offered.join(" ")).not.toMatch(/CHEQUE|CARD/);
});
