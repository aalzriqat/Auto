/**
 * SCRUM-469. A refund records the instrument the money actually left by, so the
 * picker starts EMPTY and the confirm is refused until one is chosen. Forfeit
 * moves no cash and must stay exactly as it was: no method asked, none sent.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({
    value,
    onValueChange,
    ariaLabel,
    placeholder,
  }: {
    value: string | undefined;
    onValueChange: (method: string) => void;
    ariaLabel?: string;
    placeholder?: string;
  }) => (
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
    </select>
  ),
}));

import { StoppedDealDepositsPanel } from "./StoppedDealDepositsPanel";

afterEach(cleanup);

function renderPanel(onResolve = vi.fn().mockResolvedValue(undefined)) {
  render(
    <StoppedDealDepositsPanel
      deposits={[{ _id: "dep1", amount: 500, status: "HELD", method: "CASH", releaseCount: 2 }]}
      canResolve
      faceValueIsReleasable
      resolvingId={null}
      formatAmount={(n) => String(n)}
      t={(key) => key}
      onResolve={onResolve}
    />
  );
  return onResolve;
}

describe("StoppedDealDepositsPanel refund method (SCRUM-469)", () => {
  test("refund: the picker starts empty and confirm is refused until a method is chosen", () => {
    const onResolve = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));

    const select = screen.getByTestId("method-select") as HTMLSelectElement;
    expect(select.value).toBe("");
    const confirm = screen.getByRole("button", { name: "ConfirmRefund" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("RefundMethodRequired");

    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
  });

  test("refund: exactly the chosen method is sent, with the observed generation", () => {
    const onResolve = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    fireEvent.change(screen.getByTestId("method-select"), { target: { value: "BANK_TRANSFER" } });

    const confirm = screen.getByRole("button", { name: "ConfirmRefund" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(confirm);
    expect(onResolve).toHaveBeenCalledWith("dep1", "REFUNDED", "BANK_TRANSFER", 2);
  });

  test("the choice does not leak into the next refund: reopening starts empty again", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    fireEvent.change(screen.getByTestId("method-select"), { target: { value: "CASH" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    expect((screen.getByTestId("method-select") as HTMLSelectElement).value).toBe("");
  });

  test("forfeit is untouched: no method is asked and none is sent", () => {
    const onResolve = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Forfeit" }));

    expect(screen.queryByTestId("method-select")).toBeNull();
    const confirm = screen.getByRole("button", { name: "ConfirmForfeit" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onResolve).toHaveBeenCalledWith("dep1", "FORFEITED", undefined, 2);
  });
});
