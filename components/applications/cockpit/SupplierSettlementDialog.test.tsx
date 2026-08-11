/**
 * Recording money the SUPPLIER pays BACK on a direct-settled consigned deal.
 *
 * This is the collection path that had no caller until now, which is why
 * enabling DIRECT_TO_SUPPLIER was held back: the deal could open a margin claim
 * against the supplier that the product had no way to collect. Money arrives in
 * the dealership's account here and a journal posts, so the failure modes are
 * recording more than is owed, recording a settlement in full that never
 * happened, and filing a receipt under a date nobody entered.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { SupplierSettlementDialog } from "./SupplierSettlementDialog";

// The timezone is the point of the date assertions, so it is pinned rather than
// inherited — under CI's UTC the "today" case passes with or without the fix.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Amman";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 01:30 in Amman (UTC+3) on 10 August — UTC is still on the 9th. */
const EARLY_MORNING_IN_AMMAN = new Date("2026-08-09T22:30:00Z");

function renderDialog(
  onConfirm: (receipt: unknown) => void = () => {},
  overrides: { outstandingMajor?: number } = {}
) {
  return render(
    <SupplierSettlementDialog
      open
      submitting={false}
      supplierName="Amman Importer Co"
      outstandingMajor={overrides.outstandingMajor ?? 5_000}
      outstandingLabel="JD 5,000"
      t={(key: string) => key}
      onOpenChange={() => {}}
      onConfirm={onConfirm as never}
    />
  );
}

const amountField = () => document.querySelector("#supplier-receipt-amount") as HTMLInputElement;
const dateField = () => document.querySelector("#supplier-receipt-date") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /RecordReceipt/i });

describe("what the operator is asked to type", () => {
  test("the amount is not prefilled with what the supplier owes", () => {
    // A supplier paying in instalments is the normal case, and a prefilled full
    // balance is the number an operator is most likely to accept without
    // reading — recording a settlement in full that never happened.
    renderDialog();
    expect(amountField().value).toBe("");
  });

  test("nothing can be submitted until an amount is entered", () => {
    renderDialog();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("refusing more than the supplier owes", () => {
  test("an overpayment is refused before the round trip, and says why", () => {
    renderDialog(() => {}, { outstandingMajor: 5_000 });

    fireEvent.change(amountField(), { target: { value: "5001" } });

    expect(screen.getByText(/ReceiptExceedsClaim/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  test("paying the balance exactly is allowed", () => {
    renderDialog(() => {}, { outstandingMajor: 5_000 });

    fireEvent.change(amountField(), { target: { value: "5000" } });

    expect(screen.queryByText(/ReceiptExceedsClaim/)).toBeNull();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  test("a non-numeric entry keeps the button disabled rather than submitting NaN", () => {
    // `!(x > 0)`, not `x <= 0` — they differ on NaN, and `NaN <= 0` is false,
    // which would enable the button and post a NaN amount.
    renderDialog();

    fireEvent.change(amountField(), { target: { value: "abc" } });

    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the date a receipt is filed under", () => {
  test("today is sent as an instant that is not in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ receivedAt?: number }> = [];
    renderDialog((receipt) => captured.push(receipt as { receivedAt?: number }));

    // Guard: if local and UTC days ever coincide here, the scenario is not
    // being exercised and the assertion below would hold regardless.
    expect(dateField().max).toBe("2026-08-10");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-09");

    fireEvent.change(amountField(), { target: { value: "1200" } });
    fireEvent.change(dateField(), { target: { value: dateField().max } });
    fireEvent.click(submit());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.receivedAt).toBeLessThanOrEqual(Date.now());
  });

  test("a backdated day is sent exactly as entered, not rewritten to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ receivedAt?: number }> = [];
    renderDialog((receipt) => captured.push(receipt as { receivedAt?: number }));

    fireEvent.change(amountField(), { target: { value: "1200" } });
    fireEvent.change(dateField(), { target: { value: "2026-08-01" } });
    fireEvent.click(submit());

    expect(captured[0]!.receivedAt).toBe(Date.UTC(2026, 7, 1));
  });
});

describe("what happens when the outstanding balance changes while the dialog is open", () => {
  test("typed receipt data survives", () => {
    // The balance comes from a live query. Resetting whenever it moved would
    // wipe what the operator had just read off a cheque.
    const props = {
      open: true,
      submitting: false,
      supplierName: "Amman Importer Co",
      t: (key: string) => key,
      onOpenChange: () => {},
      onConfirm: () => {},
    };
    const { rerender } = render(
      <SupplierSettlementDialog {...props} outstandingMajor={5_000} outstandingLabel="JD 5,000" />
    );

    fireEvent.change(amountField(), { target: { value: "1200" } });
    const reference = document.querySelector("#supplier-receipt-reference") as HTMLInputElement;
    fireEvent.change(reference, { target: { value: "CHQ-4417" } });

    rerender(
      <SupplierSettlementDialog {...props} outstandingMajor={3_800} outstandingLabel="JD 3,800" />
    );

    expect(amountField().value).toBe("1200");
    expect((document.querySelector("#supplier-receipt-reference") as HTMLInputElement).value).toBe(
      "CHQ-4417"
    );
  });
});
