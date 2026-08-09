/**
 * What date a settlement advice is filed under.
 *
 * Two failures pull in opposite directions here, and the dialog has to serve
 * both. A BACKDATED day must arrive exactly as entered — this record's whole
 * job is to state what the advice said, and quietly rewriting it to "now" is a
 * falsified record. But TODAY must not be sent as UTC midnight either: east of
 * UTC that instant is still in the future for the first hours of the morning
 * (until 03:00 in Amman), so the server refused the very date this dialog's own
 * picker offers as its maximum.
 *
 * Only this side knows the operator's local calendar day, so only this side can
 * tell those two cases apart.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// `DialogContent` reads the language context for its close-button label.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { DisbursementConfirmationDialog } from "./DisbursementConfirmationDialog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 01:30 in Amman (UTC+3) on 10 August — inside the window that used to fail. */
const EARLY_MORNING_IN_AMMAN = new Date("2026-08-09T22:30:00Z");

function renderSupplierDialog(onConfirmSupplier: (advice: unknown) => void) {
  return render(
    <DisbursementConfirmationDialog
      mode="SUPPLIER"
      supplierName="Amman Importer Co"
      open
      disabled={false}
      submitting={false}
      amountLabel="JD 28,000"
      defaultAmountMajor={28_000}
      t={(key: string) => key}
      onOpenChange={() => {}}
      onConfirm={() => {}}
      onConfirmSupplier={onConfirmSupplier as never}
    />
  );
}

describe("the date a supplier advice is recorded under", () => {
  test("today is sent as an instant that is not in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ disbursedAt?: number }> = [];
    renderSupplierDialog((advice) => captured.push(advice as { disbursedAt?: number }));

    // The picker's own maximum is the operator's LOCAL today. Sending UTC
    // midnight of it would be 1.5 hours ahead of now, and the server refuses a
    // future date.
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: dateInput.max } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.disbursedAt).toBeLessThanOrEqual(Date.now());
  });

  test("a backdated day is sent exactly as entered, not rewritten to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ disbursedAt?: number }> = [];
    renderSupplierDialog((advice) => captured.push(advice as { disbursedAt?: number }));

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.disbursedAt).toBe(Date.UTC(2026, 7, 1));
  });
});

/**
 * `defaultAmountMajor` comes from a live Convex query — the application's
 * approved purchase amount. While it sat in the reset effect's dependency
 * array, anything that changed that figure mid-entry silently wiped the amount,
 * reference and date the operator had just read off a settlement advice.
 */
describe("what happens when the prefill changes while the dialog is open", () => {
  test("typed advice data survives", () => {
    const { rerender } = render(
      <DisbursementConfirmationDialog
        mode="SUPPLIER"
        supplierName="Amman Importer Co"
        open
        disabled={false}
        submitting={false}
        amountLabel="JD 28,000"
        defaultAmountMajor={28_000}
        t={(key: string) => key}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        onConfirmSupplier={() => {}}
      />
    );

    const reference = screen.getByLabelText(/reference/i) as HTMLInputElement;
    fireEvent.change(reference, { target: { value: "CHQ-99182" } });

    // The approved purchase amount changes underneath — an edit elsewhere, or
    // simply the query resolving again.
    rerender(
      <DisbursementConfirmationDialog
        mode="SUPPLIER"
        supplierName="Amman Importer Co"
        open
        disabled={false}
        submitting={false}
        amountLabel="JD 29,000"
        defaultAmountMajor={29_000}
        t={(key: string) => key}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        onConfirmSupplier={() => {}}
      />
    );

    expect((screen.getByLabelText(/reference/i) as HTMLInputElement).value).toBe("CHQ-99182");
  });
});
