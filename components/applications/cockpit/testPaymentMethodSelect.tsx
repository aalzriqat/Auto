/**
 * Test double for `PaymentMethodSelect` (SCRUM-469). The real control is a Radix
 * Select, which needs pointer-capture stubs to open in jsdom; a native select
 * lets a test choose a method the way an operator now must, because no money
 * dialog pre-selects one. Used via
 * `vi.mock("@/components/payments/PaymentMethodSelect", () => import("./testPaymentMethodSelect"))`.
 */
import { fireEvent, within } from "@testing-library/react";

export function PaymentMethodSelect({
  value,
  onValueChange,
  ariaLabel,
  placeholder,
}: Readonly<{
  value: string | undefined;
  onValueChange: (method: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}>) {
  return (
    <select
      aria-label={ariaLabel ?? "method"}
      data-testid="method-select"
      data-placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      <option value="CASH">CASH</option>
      <option value="BANK_TRANSFER">BANK_TRANSFER</option>
      <option value="CHEQUE">CHEQUE</option>
      <option value="CARD">CARD</option>
    </select>
  );
}

/** Choose a method inside a dialog, as an operator must before any money command. */
export function pickMethod(scope: HTMLElement, method = "CASH") {
  fireEvent.change(within(scope).getByTestId("method-select"), { target: { value: method } });
}
