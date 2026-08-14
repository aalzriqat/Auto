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
      money={(minor) => `JD ${minor / 1000}`}
      t={t}
      onOpenChange={onOpenChange}
      onSubmit={vi.fn()}
    />
  );
  return onOpenChange;
}

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
