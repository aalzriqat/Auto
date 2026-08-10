/**
 * SCRUM-30 — the correction dialog's date must never be sent as an instant the
 * server will refuse.
 *
 * `todayDateInput()` is the operator's LOCAL calendar day, deliberately, so the
 * picker does not offer yesterday to someone ahead of UTC. `dateInputToUtcMs`
 * converts a chosen day to UTC midnight, also deliberately, so a backdated
 * entry lands on the day the operator named. Put together, "today" east of UTC
 * becomes an instant in the FUTURE for the first hours of the morning — until
 * 03:00 in Amman — and `amendSupplierDisbursementAdvice` refuses a future
 * disbursement date. The picker offers a date its own server rejects.
 *
 * The repo has learned this twice already: `DisbursementConfirmationDialog` and
 * `SupplierSettlementDialog` both special-case today to `Date.now()`, with the
 * reasoning written out. This dialog was added without it — and it is the only
 * way out of REQUIRES_RECONCILIATION, so the deal stays stuck until 03:00.
 *
 * TZ is pinned for the same reason `lib/dateInput.test.ts` pins it: at 22:30Z
 * the UTC day is still 9 August, so without a UTC+ timezone the conversion
 * lands in the past, the assertion passes, and the bug goes undetected. A
 * regression test that cannot fail is not coverage.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Identity `t`, as in `DealCockpitView.test.tsx`: a missing translation then
// shows up as its own key rather than silently rendering something plausible.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: true, locale: "ar" }),
}));

import { SettlementAdviceCorrectionDialog } from "./SettlementAdviceCorrectionDialog";

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

/** 01:30 in Amman (UTC+3) on 10 August — inside the window that fails. */
const EARLY_MORNING_IN_AMMAN = new Date("2026-08-09T22:30:00Z");

/** A real recorded advice: not midnight, and carrying milliseconds. */
const RECORDED_AT = Date.UTC(2026, 7, 5, 14, 32, 17, 456);

function renderCorrection(onCorrect: (correction: unknown) => void) {
  return render(
    <SettlementAdviceCorrectionDialog
      open
      submitting={false}
      recordedMajor={17_995}
      recordedReference="WIRE-4471"
      recordedAt={RECORDED_AT}
      approvedLabel="JD 18,000"
      recordedLabel="JD 17,995"
      t={(key: string) => key}
      onOpenChange={() => {}}
      onCorrect={onCorrect as never}
    />
  );
}

function fillReason() {
  fireEvent.change(screen.getByLabelText("SettlementAdviceReasonLabel"), {
    target: { value: "Advice re-read: the amount was transposed on entry." },
  });
}

describe("the date a settlement-advice correction is recorded under", () => {
  test("choosing today sends an instant that is not in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ disbursedAt?: number }> = [];
    renderCorrection((c) => captured.push(c as { disbursedAt?: number }));

    const dateInput = screen.getByLabelText("SettlementAdviceDateLabel") as HTMLInputElement;

    // Guards: if the local and UTC calendar days ever coincide at this instant,
    // the scenario is not being exercised and the assertion below would hold
    // whatever the component does. Fail loudly rather than pass vacuously.
    expect(dateInput.max).toBe("2026-08-10");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-09");

    fireEvent.change(dateInput, { target: { value: dateInput.max } });
    fillReason();
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    expect(captured).toHaveLength(1);
    // The server refuses anything past `Date.now()`, so this is the whole claim.
    expect(captured[0]!.disbursedAt).toBeLessThanOrEqual(Date.now());
  });

  test("a backdated day is still sent as that day, not clamped to now", () => {
    // The control. Rescuing today must not turn every correction into "now" —
    // that would file an advice under a date the operator never entered, on the
    // record whose whole job is to state what somebody else's document said.
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ disbursedAt?: number }> = [];
    renderCorrection((c) => captured.push(c as { disbursedAt?: number }));

    fireEvent.change(screen.getByLabelText("SettlementAdviceDateLabel"), {
      target: { value: "2026-08-06" },
    });
    fillReason();
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    expect(captured[0]!.disbursedAt).toBe(Date.UTC(2026, 7, 6));
  });

  test("and an untouched date still sends nothing at all", () => {
    // The round-4 guarantee, re-asserted here because this fix touches the same
    // expression: the recorded instant carries a time of day that a date-only
    // control cannot represent, so preserving it means not sending it.
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: Array<{ disbursedAt?: number }> = [];
    renderCorrection((c) => captured.push(c as { disbursedAt?: number }));

    fireEvent.change(screen.getByLabelText("SettlementAdviceAmountLabel"), {
      target: { value: "18000" },
    });
    fillReason();
    fireEvent.click(screen.getByRole("button", { name: "SaveCorrection" }));

    expect(captured[0]!.disbursedAt).toBeUndefined();
  });
});
