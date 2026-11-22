import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CreditDecisionDialog } from "./CreditDecisionDialog";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: "en", isRtl: false }),
}));

afterEach(cleanup);

const props = {
  open: true,
  submitting: false,
  error: null,
  canApprove: true,
  canReject: true,
  isOwnDeal: false,
  t: (key: string) => key,
  onOpenChange: () => {},
};

test("keyboard selection moves focus and keeps one available tab stop", () => {
  const onSubmit = vi.fn();
  render(<CreditDecisionDialog {...props} onSubmit={onSubmit} />);
  const approve = screen.getByRole("radio", { name: /^CreditDecisionApproved/ });
  const reject = screen.getByRole("radio", { name: /^CreditDecisionRejected/ });

  expect(approve.tabIndex).toBe(0);
  expect(reject.tabIndex).toBe(-1);
  approve.focus();
  fireEvent.keyDown(approve, { key: "ArrowDown" });
  expect(document.activeElement).toBe(reject);
  expect(reject.getAttribute("aria-checked")).toBe("true");
  expect(approve.tabIndex).toBe(-1);

  fireEvent.click(screen.getByRole("button", { name: "RecordCreditDecisionConfirm" }));
  expect(onSubmit).toHaveBeenCalledWith("REJECTED");
});

test("a choice that becomes unavailable cannot be submitted", () => {
  const onSubmit = vi.fn();
  const { rerender } = render(<CreditDecisionDialog {...props} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole("radio", { name: /^CreditDecisionApproved/ }));
  rerender(<CreditDecisionDialog {...props} documentsIncomplete onSubmit={onSubmit} />);

  const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "RecordCreditDecisionConfirm" });
  const reject = screen.getByRole("radio", { name: /^CreditDecisionRejected/ });
  expect(confirm.disabled).toBe(true);
  expect(reject.tabIndex).toBe(0);
  fireEvent.click(confirm);
  expect(onSubmit).not.toHaveBeenCalled();
});

