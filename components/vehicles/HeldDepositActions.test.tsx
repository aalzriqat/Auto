/**
 * SCRUM-469. Refunding a held deposit from the vehicle dialog: the picker starts
 * empty, Refund is refused until a method is chosen, and only the chosen method
 * is handed on. Forfeit moves no cash and stays as it was.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";

vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({
    value,
    onValueChange,
    ariaLabel,
  }: {
    value: string | undefined;
    onValueChange: (method: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid="method-select"
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      <option value="CASH">CASH</option>
      <option value="BANK_TRANSFER">BANK_TRANSFER</option>
    </select>
  ),
}));

import { HeldDepositActions } from "./HeldDepositActions";

afterEach(cleanup);

function Harness({ onRefund, onForfeit }: { onRefund: (m: PaymentMethod) => void; onForfeit: () => void }) {
  const [method, setMethod] = useState<PaymentMethod | undefined>(undefined);
  return (
    <HeldDepositActions
      method={method}
      onMethodChange={setMethod}
      busy={false}
      onRefund={onRefund}
      onForfeit={onForfeit}
      t={(key) => key}
    />
  );
}

describe("HeldDepositActions (SCRUM-469)", () => {
  test("starts with no method: Refund is refused, with the reason on screen", () => {
    const onRefund = vi.fn();
    render(<Harness onRefund={onRefund} onForfeit={vi.fn()} />);

    expect((screen.getByTestId("method-select") as HTMLSelectElement).value).toBe("");
    const refund = screen.getByRole("button", { name: "Refund" }) as HTMLButtonElement;
    expect(refund.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("RefundMethodRequired");
    fireEvent.click(refund);
    expect(onRefund).not.toHaveBeenCalled();
  });

  test("hands on exactly the chosen method", () => {
    const onRefund = vi.fn();
    render(<Harness onRefund={onRefund} onForfeit={vi.fn()} />);
    fireEvent.change(screen.getByTestId("method-select"), { target: { value: "BANK_TRANSFER" } });

    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    expect(onRefund).toHaveBeenCalledExactlyOnceWith("BANK_TRANSFER");
  });

  test("forfeit needs no method", () => {
    const onForfeit = vi.fn();
    render(<Harness onRefund={vi.fn()} onForfeit={onForfeit} />);
    const forfeit = screen.getByRole("button", { name: "Forfeit" }) as HTMLButtonElement;
    expect(forfeit.disabled).toBe(false);
    fireEvent.click(forfeit);
    expect(onForfeit).toHaveBeenCalledTimes(1);
  });
});
