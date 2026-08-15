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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// `components/ui/dialog` reads the locale for its own close affordance, so the
// dialog primitive cannot render outside a provider.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { ConfirmHandoverDialog } from "./ConfirmHandoverDialog";
import { ConfirmFinalizeDialog } from "./ConfirmFinalizeDialog";

afterEach(cleanup);

const t = (key: string) => key;

const JOD = { code: "JOD", scale: 3 };

function evidence(over: Record<string, unknown> = {}) {
  return {
    approvedPurchaseAmountMinor: 150_000_000,
    financeCompanyFundedPortionMinor: 127_500_000,
    dealerContributionMinor: 22_500_000,
    approvedAmountIsFarFromEvidence: false,
    currency: JOD,
    ...over,
  } as never;
}

function renderHandover(submitting: boolean, onOpenChange = vi.fn()) {
  render(
    <ConfirmHandoverDialog
      open
      submitting={submitting}
      evidence={evidence()}
      economicsStamp="v2|7"
      t={t}
      onOpenChange={onOpenChange}
      onSubmit={vi.fn(async () => {})}
    />
  );
  return onOpenChange;
}

/**
 * The whole class, not each symptom.
 *
 * Five defects reached this component from one mistake — part of what the
 * operator saw belonged to the attempt and part was live. Testing the five
 * symptoms would leave the sixth. So every money-bearing or rendered fact is
 * moved underneath an OPEN dialog here, and the assertion is the same each
 * time: what the operator was asked to confirm does not change while they are
 * being asked, and a new open is a new attempt.
 */
describe("every rendered fact belongs to one confirmation attempt", () => {
  const OPEN = {
    open: true as const,
    submitting: false,
    economicsStamp: "v2|7",
    t,
    onOpenChange: vi.fn(),
  };

  const MOVED: Array<[string, Record<string, unknown>, string]> = [
    ["the approved amount", { approvedPurchaseAmountMinor: 12_750_000 }, "150,000 JOD"],
    ["the funding split", { financeCompanyFundedPortionMinor: 99_000_000 }, "127,500 JOD"],
    ["the dealer contribution", { dealerContributionMinor: 1_000_000 }, "22,500 JOD"],
    ["the denomination", { currency: { code: "USD", scale: 2 } }, "150,000 JOD"],
  ];

  for (const [what, change, mustStillRead] of MOVED) {
    test(`${what} moving underneath an open dialog changes nothing on screen`, () => {
      const { rerender } = render(
        <ConfirmHandoverDialog {...OPEN} evidence={evidence()} onSubmit={vi.fn(async () => {})} />
      );
      expect(screen.getByText(mustStillRead)).toBeTruthy();
      rerender(
        <ConfirmHandoverDialog
          {...OPEN}
          evidence={evidence(change)}
          onSubmit={vi.fn(async () => {})}
        />
      );
      expect(screen.getByText(mustStillRead)).toBeTruthy();
    });
  }

  test("the anomaly verdict moving does not change the warning", () => {
    const flagged = { ...OPEN };
    const { rerender } = render(
      <ConfirmHandoverDialog
        {...flagged}
        evidence={evidence({ approvedAmountIsFarFromEvidence: true })}
        onSubmit={vi.fn(async () => {})}
      />
    );
    expect(screen.getByText("HandoverAmountLooksUnusual")).toBeTruthy();
    rerender(
      <ConfirmHandoverDialog {...flagged} evidence={evidence()} onSubmit={vi.fn(async () => {})} />
    );
    expect(screen.getByText("HandoverAmountLooksUnusual")).toBeTruthy();
  });

  test("the revision moving does not change the stamp that gets submitted", async () => {
    const onSubmit = vi.fn(async () => {});
    const { rerender } = render(
      <ConfirmHandoverDialog {...OPEN} evidence={evidence()} onSubmit={onSubmit} />
    );
    rerender(
      <ConfirmHandoverDialog
        {...OPEN}
        economicsStamp="v2|8"
        evidence={evidence()}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByText("ConfirmHandoverAction"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ economicsStamp: "v2|7" }))
    );
  });

  test("a refusal does not survive into the next attempt", async () => {
    // The fifth defect, and the one the previous fix missed: the error lived in
    // the parent and was cleared on submit rather than on open, so reopening
    // after a stale-stamp refusal showed revision 7's message beside revision
    // 8's figures.
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("The deal's approved figures changed"))
      .mockResolvedValue(undefined);
    const props = { ...OPEN, evidence: evidence(), onSubmit };
    const { rerender } = render(<ConfirmHandoverDialog {...props} />);

    fireEvent.click(screen.getByText("ConfirmHandoverAction"));
    // Queried by its TEXT, not by role: the permanence warning is also an
    // alert, and a role query matches both.
    await waitFor(() => expect(screen.getByText(/approved figures changed/i)).toBeTruthy());

    // Close, the deal moves on, reopen.
    rerender(<ConfirmHandoverDialog {...props} open={false} />);
    rerender(
      <ConfirmHandoverDialog {...props} economicsStamp="v2|8" evidence={evidence()} />
    );
    expect(screen.queryByText(/approved figures changed/i)).toBeNull();
  });

  test("an unverifiable denomination refuses the confirmation instead of guessing", () => {
    // `economicsCurrency` absent on a legacy row, and the org's current
    // currency is not a fallback — orgSettings does not lock currency for
    // financeApplications, so the org may have switched since. Guessing put a
    // USD amount on screen labelled JOD, ten times wrong, on the screen that
    // seals the deal permanently.
    render(
      <ConfirmHandoverDialog
        {...OPEN}
        evidence={evidence({ currency: null })}
        onSubmit={vi.fn(async () => {})}
      />
    );
    expect(screen.getByText("HandoverCurrencyUnverified")).toBeTruthy();
    expect((screen.getByText("ConfirmHandoverAction").closest("button") as HTMLButtonElement).disabled).toBe(true);
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
