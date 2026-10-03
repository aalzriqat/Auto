/**
 * SCRUM-596 — the legal invoice date must never be sent as an instant the
 * server will refuse.
 *
 * The dialog defaulted to `todayDateInput()` — the operator's LOCAL calendar
 * day — and sent it through `dateInputToUtcMs`, i.e. UTC midnight of that day.
 * East of UTC that instant is in the FUTURE for the first hours of the local
 * morning (until 03:00 in Amman), and `recordLegalInvoice` refuses a future
 * invoice date, so the closing checklist could not be cleared overnight.
 * Found by the SCRUM-595 browser matrix at 01:00 Amman (finding F-28).
 *
 * The fix is the ledger's own rule from `lib/dateInput.ts`: an ECONOMIC date
 * defaults to and is capped at `economicTodayDateInput` (the UTC day) and is
 * sent with `economicDateInputToMs`.
 *
 * TZ is pinned as in `SettlementAdviceCorrectionDate.test.tsx`: under a UTC
 * runner the local and UTC days coincide and this test could not fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Identity `t`, as in `SettlementAdviceCorrectionDate.test.tsx` (DialogContent reads the language).
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: true, locale: "ar" }),
}));

import { RecordLegalInvoiceDialog, type RecordLegalInvoiceValues } from "./RecordLegalInvoiceDialog";

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

/** 01:30 in Amman (UTC+3) on 10 August — inside the window that failed. */
const EARLY_MORNING_IN_AMMAN = new Date("2026-08-09T22:30:00Z");

function renderDialog(captured: RecordLegalInvoiceValues[]) {
  return render(
    <RecordLegalInvoiceDialog
      open
      submitting={false}
      error={null}
      scale={3}
      currency="JOD"
      t={(key: string) => key}
      onOpenChange={() => {}}
      onSubmit={async (values) => {
        captured.push(values);
      }}
    />
  );
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/LegalInvoiceAmount/), { target: { value: "12500" } });
  fireEvent.change(screen.getByLabelText("LegalInvoiceNumber"), { target: { value: "INV-0596" } });
}

describe("the date a legal invoice is recorded under", () => {
  test("the default date sends an instant that is not in the future", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    // Guard: the scenario only exists while the local day is ahead of the UTC day.
    expect(new Date().getDate()).toBe(10);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-09");

    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "SubmitLegalInvoice" }));
    await vi.waitFor(() => expect(captured).toHaveLength(1));

    // The server refuses anything past `Date.now()`, so this is the whole claim.
    expect(captured[0]!.legalInvoiceDate).toBeLessThanOrEqual(Date.now());
    // And it is the UTC day's midnight — the calendar the ledger files under.
    expect(captured[0]!.legalInvoiceDate).toBe(Date.UTC(2026, 7, 9));
  });

  test("the picker cannot offer a day the server has not reached", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    renderDialog([]);
    const dateInput = screen.getByLabelText("LegalInvoiceDate") as HTMLInputElement;
    expect(dateInput.max).toBe("2026-08-09");
    expect(dateInput.value).toBe("2026-08-09");
  });

  test("a backdated day is still sent as that day, not clamped to now", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(EARLY_MORNING_IN_AMMAN);

    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured);
    fillRequired();
    fireEvent.change(screen.getByLabelText("LegalInvoiceDate"), { target: { value: "2026-08-06" } });
    fireEvent.click(screen.getByRole("button", { name: "SubmitLegalInvoice" }));
    await vi.waitFor(() => expect(captured).toHaveLength(1));

    expect(captured[0]!.legalInvoiceDate).toBe(Date.UTC(2026, 7, 6));
  });
});
