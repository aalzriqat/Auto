/**
 * The two confirmations that guard the deal's irreversible steps.
 *
 * Handover is the one-way door — `reopenApproval` refuses once the vehicle has
 * gone out — and closing creates the sale and posts its journals. Both dialogs
 * exist to make an operator stop and read before either happens.
 *
 * An adversarial review found the gap that makes that promise false: while the
 * mutation is in flight, Escape, the overlay and the built-in × all still close
 * the dialog, and Cancel was still enabled. None of them cancels the request —
 * there is no abort path and the write lands regardless. So an operator could
 * back out of a handover, watch the dialog disappear, and be wrong about
 * whether the door had closed. The data was always correct; what the screen said
 * about it was not.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// `components/ui/dialog` reads the locale for its own close affordance, so the
// dialog primitive cannot render outside a provider.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { ConfirmHandoverDialog } from "./ConfirmHandoverDialog";
import { ConfirmFinalizeDialog } from "./ConfirmFinalizeDialog";

afterEach(cleanup);

const t = (key: string) => key;

function renderHandover(submitting: boolean, onOpenChange = vi.fn()) {
  render(
    <ConfirmHandoverDialog
      open
      submitting={submitting}
      error={null}
      approvedAmountMinor={150_000_000}
      financeCompanyFundedPortionMinor={135_000_000}
      dealerContributionMinor={15_000_000}
      approvedAmountIsFarFromEvidence={false}
      economicsStamp="v1|150000000|135000000|15000000"
      money={(minor) => `JD ${minor / 1000}`}
      t={t}
      onOpenChange={onOpenChange}
      onSubmit={vi.fn()}
    />
  );
  return onOpenChange;
}

describe("the handover confirmation is about the figures the operator read", () => {
  /**
   * The props are a live Convex subscription. A second approver committing a
   * new amount re-renders this dialog underneath the operator, and the version
   * this replaces rendered and submitted the live values — so display and
   * payload moved together, the server's comparison passed, and the deal sealed
   * against economics nobody had looked at. The machine race was closed; the
   * human one was not.
   */
  test("a refetch while it is open changes neither the figures nor the stamp", () => {
    const onSubmit = vi.fn();
    const props = {
      open: true as const,
      submitting: false,
      error: null,
      approvedAmountMinor: 11_500_000,
      financeCompanyFundedPortionMinor: 10_000_000,
      dealerContributionMinor: 1_500_000,
      approvedAmountIsFarFromEvidence: false,
      economicsStamp: "v1|11500000|10000000|1500000",
      money: (minor: number) => `JD ${minor / 1000}`,
      t,
      onOpenChange: vi.fn(),
      onSubmit,
    };
    const { rerender } = render(<ConfirmHandoverDialog {...props} />);
    expect(screen.getByText("JD 11500")).toBeTruthy();

    // The deal moves while the operator is still reading it.
    rerender(
      <ConfirmHandoverDialog
        {...props}
        approvedAmountMinor={12_750_000}
        financeCompanyFundedPortionMinor={11_000_000}
        economicsStamp="v1|12750000|11000000|1500000"
      />
    );

    // What they were asked to confirm is still on the screen — the dialog does
    // not quietly restate itself around a number they never saw.
    expect(screen.getByText("JD 11500")).toBeTruthy();
    expect(screen.queryByText("JD 12750")).toBeNull();

    fireEvent.click(screen.getByText("ConfirmHandoverAction"));
    // And the stamp is the one it opened against, so the server refuses rather
    // than sealing the deal that moved.
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ economicsStamp: "v1|11500000|10000000|1500000" })
    );
  });

  test("re-opening takes a fresh snapshot", () => {
    const onSubmit = vi.fn();
    const props = {
      submitting: false,
      error: null,
      approvedAmountMinor: 11_500_000,
      financeCompanyFundedPortionMinor: 10_000_000,
      dealerContributionMinor: 1_500_000,
      approvedAmountIsFarFromEvidence: false,
      economicsStamp: "v1|11500000|10000000|1500000",
      money: (minor: number) => `JD ${minor / 1000}`,
      t,
      onOpenChange: vi.fn(),
      onSubmit,
    };
    const { rerender } = render(<ConfirmHandoverDialog {...props} open />);
    // Closed, the deal moves, and the operator opens it again to look properly.
    rerender(<ConfirmHandoverDialog {...props} open={false} />);
    rerender(
      <ConfirmHandoverDialog
        {...props}
        open
        approvedAmountMinor={12_750_000}
        financeCompanyFundedPortionMinor={11_000_000}
        economicsStamp="v1|12750000|11000000|1500000"
      />
    );

    // Otherwise the snapshot would be a trap: the figures on file would be
    // permanently unconfirmable and handover could never complete.
    expect(screen.getByText("JD 12750")).toBeTruthy();
    fireEvent.click(screen.getByText("ConfirmHandoverAction"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ economicsStamp: "v1|12750000|11000000|1500000" })
    );
  });
});

function renderFinalize(submitting: boolean, onOpenChange = vi.fn()) {
  render(
    <ConfirmFinalizeDialog
      open
      submitting={submitting}
      error={null}
      t={t}
      onOpenChange={onOpenChange}
      onSubmit={vi.fn()}
    />
  );
  return onOpenChange;
}

describe.each([
  ["the handover confirmation", renderHandover],
  ["the closing confirmation", renderFinalize],
])("%s", (_name, renderDialog) => {
  test("can be abandoned before the action is taken", () => {
    const onOpenChange = renderDialog(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // The ordinary case, asserted so the fix below cannot be implemented by
    // simply making the dialog undismissable.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("cannot be abandoned once the action is in flight", () => {
    const onOpenChange = renderDialog(true);

    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);

    // Escape is the one an operator reaches for without thinking, and it is
    // wired to the same close as the ×. It must not report a cancellation that
    // did not happen.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
