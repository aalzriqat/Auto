/**
 * CodeRabbit, PR #349: the correction must be confirmed against the figures
 * the operator opened it on. If the deal's economics move while the dialog is
 * open, the stamp submitted must still be the one from opening, so the server
 * refuses it as stale instead of accepting a confirmation nobody gave.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { ApplyQuoteFirstPaymentDialog } from "./ApplyQuoteFirstPaymentDialog";

afterEach(cleanup);

function props(
  economicsStamp: string,
  onSubmit: (values: { reason: string; economicsStamp: string }) => void,
  quoteDownPaymentMinor = 500_000
) {
  return {
    open: true,
    submitting: false,
    error: null,
    quoteDownPaymentMinor,
    economicsStamp,
    money: (minor: number) => `JD ${minor / 1000}`,
    t: (key: string) => key,
    onOpenChange: () => {},
    onSubmit,
  };
}

describe("ApplyQuoteFirstPaymentDialog", () => {
  test("shows and submits what it was opened with, not a later figure or stamp", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ApplyQuoteFirstPaymentDialog {...props("rev-1", onSubmit)} />);

    // The economics move while the dialog stays open.
    rerender(<ApplyQuoteFirstPaymentDialog {...props("rev-2", onSubmit, 700_000)} />);
    expect(screen.getByText("JD 500")).toBeTruthy();
    expect(screen.queryByText("JD 700")).toBeNull();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Dealer ruling" } });
    fireEvent.click(screen.getByRole("button", { name: "ApplyQuoteFirstPaymentAction" }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: "Dealer ruling", economicsStamp: "rev-1" });
  });

  test("a reopen takes the current stamp", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ApplyQuoteFirstPaymentDialog {...props("rev-1", onSubmit)} />);
    rerender(<ApplyQuoteFirstPaymentDialog {...props("rev-1", onSubmit)} open={false} />);
    rerender(<ApplyQuoteFirstPaymentDialog {...props("rev-2", onSubmit)} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Dealer ruling" } });
    fireEvent.click(screen.getByRole("button", { name: "ApplyQuoteFirstPaymentAction" }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: "Dealer ruling", economicsStamp: "rev-2" });
  });
});
