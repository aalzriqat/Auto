/**
 * SCRUM-1034 -- CancelCashDealDialog's own behaviour for keyboard and assistive-technology users,
 * apart from the hook that feeds it (SaleDealCockpitCancel.test.tsx covers the two together).
 *
 * Sources: WAI-ARIA APG alertdialog pattern; MDN aria-disabled and ARIA live regions;
 * Radix Dialog 1.1.x (onEscapeKeyDown / onPointerDownOutside / onInteractOutside).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { dictionaries } from "@/lib/i18n/dictionaries";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { CancelCashDealDialog } from "./CancelCashDealDialog";

const en = dictionaries.en as Record<string, string>;
const busy = (element: HTMLElement) => element.getAttribute("aria-disabled") === "true";
const overlay = () => document.querySelector("[data-state='open'].fixed.inset-0") as HTMLElement;
// Radix registers its outside-pointer listener on the next macrotask after the layer mounts.
const settleOutsideListeners = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function dialog(props: { submitting: boolean; error?: string | null; onSubmit?: () => void; onOpenChange?: (open: boolean) => void }): ReactElement {
  return (
    <CancelCashDealDialog
      open
      submitting={props.submitting}
      error={props.error ?? null}
      isCompleted
      t={(key: string) => en[key] ?? key}
      onOpenChange={props.onOpenChange ?? (() => undefined)}
      onSubmit={props.onSubmit ?? (() => undefined)}
    />
  );
}

afterEach(cleanup);

describe("while the request is in flight", () => {
  test("both buttons keep keyboard focus and say they are unavailable", async () => {
    const view = render(dialog({ submitting: false }));
    const keep = screen.getByTestId("cancel-deal-keep");
    const confirm = screen.getByTestId("cancel-deal-confirm");
    for (const focused of [confirm, keep]) {
      focused.focus();
      view.rerender(dialog({ submitting: true }));
      expect(document.activeElement).toBe(focused);
      expect(busy(keep)).toBe(true);
      expect(busy(confirm)).toBe(true);
      expect(confirm.getAttribute("aria-busy")).toBe("true");
      view.rerender(dialog({ submitting: false }));
      expect(document.activeElement).toBe(focused);
      expect(busy(confirm)).toBe(false);
    }
  });

  test("a click on Confirm does not submit again", () => {
    const onSubmit = vi.fn();
    render(dialog({ submitting: true, onSubmit }));
    const confirm = screen.getByTestId("cancel-deal-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Keep deal, Escape, the Close control and a click outside ask for no close", async () => {
    const onOpenChange = vi.fn();
    render(dialog({ submitting: true, onOpenChange }));
    await settleOutsideListeners();
    fireEvent.click(screen.getByTestId("cancel-deal-keep"));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape", code: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(overlay());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});

describe("when nothing is in flight", () => {
  test("Keep deal, Escape and a click outside do ask for a close, and Confirm submits", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    render(dialog({ submitting: false, onOpenChange, onSubmit }));
    await settleOutsideListeners();
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("cancel-deal-keep"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    onOpenChange.mockClear();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    onOpenChange.mockClear();
    fireEvent.pointerDown(overlay());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("the refusal", () => {
  test("is announced from a live region that was already mounted, and empty", () => {
    const view = render(dialog({ submitting: false }));
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    view.rerender(dialog({ submitting: false, error: "Commission already paid" }));
    expect(screen.getByRole("alert")).toBe(region);
    expect(region.textContent).toContain(en.CancelDealRefusedLead);
    expect(region.textContent).toContain("Commission already paid");
    view.rerender(dialog({ submitting: true }));
    expect(screen.getByRole("alert")).toBe(region);
    expect(region.textContent).toBe("");
  });
});
describe("focus returns to the control that opened the dialog (WAI-ARIA APG dialog pattern)", () => {
  // The header opens this dialog from state, with a plain button, not a Radix Trigger, so the
  // primitive has no trigger to hand focus back to and leaves it on <body> unless told where.
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Cancel deal</button>
        <CancelCashDealDialog
          open={open}
          submitting={false}
          error={null}
          isCompleted
          t={(key: string) => en[key] ?? key}
          onOpenChange={setOpen}
          onSubmit={() => setOpen(false)}
        />
      </>
    );
  }
  const openFromButton = async () => {
    render(<Opener />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("cancel-deal-keep")));
    return opener;
  };

  test("Escape returns focus to the button that opened it", async () => {
    const opener = await openFromButton();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("Keep deal returns focus to the button that opened it", async () => {
    const opener = await openFromButton();
    fireEvent.click(screen.getByTestId("cancel-deal-keep"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});