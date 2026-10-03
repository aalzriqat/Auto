/**
 * SCRUM-596 — the legal invoice date must never be sent as an instant the
 * server will refuse, and must never silently move to another day.
 *
 * The dialog defaulted to `todayDateInput()` — the operator's LOCAL calendar
 * day — and sent it through `dateInputToUtcMs`, i.e. UTC midnight of that day.
 * East of UTC that instant is in the FUTURE for the first hours of the local
 * morning (until 03:00 in Amman), and `recordLegalInvoice` refuses a future
 * invoice date, so the closing checklist could not be cleared overnight.
 * Found by the SCRUM-595 browser matrix at 01:00 Amman (finding F-28).
 *
 * A legal invoice date is a DOCUMENT date (the one printed on the paper), so
 * the fix must not trade the refusal for a silent backdate: pre-filling the
 * ledger's UTC day at 01:30 on 1 October would file an invoice dated
 * 1 October under 30 September — the previous period (Sol 6 review of
 * 8616c7118). The picker is capped at the earlier of the local and UTC days,
 * pre-fills the local day only once the ledger has reached it, and otherwise
 * leaves the date blank with a hint so the operator picks the paper's date.
 *
 * TZ is pinned per test, as in `SettlementAdviceCorrectionDate.test.tsx`:
 * under a UTC runner the local and UTC days coincide and this could not fail.
 */
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Identity `t`, as in `SettlementAdviceCorrectionDate.test.tsx` (DialogContent reads the language).
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: true, locale: "ar" }),
}));

import { RecordLegalInvoiceDialog, type RecordLegalInvoiceValues } from "./RecordLegalInvoiceDialog";

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  // Assigning `undefined` would store the string "undefined" for later tests in this worker.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 01:30 in Amman (UTC+3) on 10 August — inside the window that failed. */
const EARLY_MORNING_IN_AMMAN = new Date("2026-08-09T22:30:00Z");
/** 01:30 in Amman on 1 October — the UTC day is still 30 September, the previous period. */
const MONTH_START_IN_AMMAN = new Date("2026-09-30T22:30:00Z");
/** 12:00 in Amman on 10 August — both calendars agree. */
const NOON_IN_AMMAN = new Date("2026-08-10T09:00:00Z");
/** 22:00 in New York on 9 August — the UTC day is already 10 August. */
const EVENING_IN_NEW_YORK = new Date("2026-08-10T02:00:00Z");

function at(instant: Date, tz = "Asia/Amman") {
  process.env.TZ = tz;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(instant);
}

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

const dateInput = () => screen.getByLabelText("LegalInvoiceDate") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: "SubmitLegalInvoice" }) as HTMLButtonElement;

async function submitWith(day: string | null): Promise<RecordLegalInvoiceValues> {
  const captured: RecordLegalInvoiceValues[] = [];
  renderDialog(captured);
  fillRequired();
  if (day !== null) fireEvent.change(dateInput(), { target: { value: day } });
  fireEvent.click(submitButton());
  await vi.waitFor(() => expect(captured).toHaveLength(1));
  return captured[0]!;
}

describe("the date a legal invoice is recorded under", () => {
  test("before the local day opens on the ledger, nothing is pre-filled and the hint says why", () => {
    at(EARLY_MORNING_IN_AMMAN);
    // Guard: the scenario only exists while the local day is ahead of the UTC day.
    expect(new Date().getDate()).toBe(10);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-09");

    renderDialog([]);
    fillRequired();
    expect(dateInput().value).toBe("");
    expect(dateInput().max).toBe("2026-08-09");
    expect(screen.getByText("LegalInvoiceDateNotOpenYet")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  test.each([
    ["Asia/Amman", "03:00"],
    ["Asia/Tokyo", "09:00"],
  ])("the hint names the %s clock time the ledger's day begins", (tz, expected) => {
    at(EARLY_MORNING_IN_AMMAN, tz);
    render(
      <RecordLegalInvoiceDialog
        open
        submitting={false}
        error={null}
        scale={3}
        currency="JOD"
        t={(key: string) => (key === "LegalInvoiceDateNotOpenYet" ? "opens at {time}" : key)}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />
    );
    const hint = document.querySelector("#legal-invoice-date-hint");
    expect(hint?.textContent).toMatch(/^opens at /);
    expect(hint?.textContent).toContain(expected);
    // Isolated left-to-right, or Arabic text reorders it to "AM 03:00".
    const time = document.querySelector('#legal-invoice-date-hint bdi[dir="ltr"]');
    expect(time?.textContent).toContain(expected);
  });

  test("on the 1st of a month before 03:00 the previous month is never pre-filled", () => {
    at(MONTH_START_IN_AMMAN);
    expect(new Date().getDate()).toBe(1);

    renderDialog([]);
    expect(dateInput().value).toBe("");
    expect(dateInput().max).toBe("2026-09-30");
  });

  test("an explicitly picked day is sent as that day's UTC midnight, never in the future", async () => {
    at(EARLY_MORNING_IN_AMMAN);
    const sent = await submitWith("2026-08-09");
    expect(sent.legalInvoiceDate).toBe(Date.UTC(2026, 7, 9));
    // The server refuses anything past `Date.now()`.
    expect(sent.legalInvoiceDate).toBeLessThanOrEqual(Date.now());
  });

  test("once the ledger has reached the local day, the local day is the default", async () => {
    at(NOON_IN_AMMAN);
    renderDialog([]);
    expect(dateInput().value).toBe("2026-08-10");
    expect(screen.queryByText("LegalInvoiceDateNotOpenYet")).toBeNull();
    cleanup();

    const sent = await submitWith(null);
    expect(sent.legalInvoiceDate).toBe(Date.UTC(2026, 7, 10));
    expect(sent.legalInvoiceDate).toBeLessThanOrEqual(Date.now());
  });

  test("behind UTC, the default and cap are the local day, not the UTC tomorrow", async () => {
    at(EVENING_IN_NEW_YORK, "America/New_York");
    expect(new Date().getDate()).toBe(9);

    renderDialog([]);
    expect(dateInput().value).toBe("2026-08-09");
    expect(dateInput().max).toBe("2026-08-09");
    cleanup();

    const sent = await submitWith(null);
    expect(sent.legalInvoiceDate).toBe(Date.UTC(2026, 7, 9));
  });

  test("an editor behind UTC can re-save a stored date past their local day unchanged", async () => {
    // Recorded in Amman as 10 August; edited in New York at 22:00 on 9 August.
    at(EVENING_IN_NEW_YORK, "America/New_York");
    const captured: RecordLegalInvoiceValues[] = [];
    render(
      <RecordLegalInvoiceDialog
        open
        submitting={false}
        error={null}
        scale={3}
        currency="JOD"
        existing={{ amountMinor: 12_500_000, number: "INV-0596", date: Date.UTC(2026, 7, 10) }}
        t={(key: string) => key}
        onOpenChange={() => {}}
        onSubmit={async (values) => {
          captured.push(values);
        }}
      />
    );
    expect(dateInput().value).toBe("2026-08-10");
    expect(dateInput().validity.rangeOverflow).toBe(false);
    fireEvent.change(screen.getByLabelText("LegalInvoiceNumber"), { target: { value: "INV-0596-A" } });
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.legalInvoiceDate).toBe(Date.UTC(2026, 7, 10));
  });

  test("a dialog left open across the ledger's midnight lets the operator pick the new day", async () => {
    // 02:59:30 in Amman — opened, filled, then left untouched past 03:00 (Sol 6 on 1f8a5d419).
    at(new Date("2026-08-09T23:59:30Z"));
    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured);
    fillRequired();
    expect(dateInput().max).toBe("2026-08-09");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(dateInput().max).toBe("2026-08-10");
    expect(document.querySelector("#legal-invoice-date-hint")).toBeNull();

    fireEvent.change(dateInput(), { target: { value: "2026-08-10" } });
    expect(dateInput().validity.rangeOverflow).toBe(false);
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.legalInvoiceDate).toBe(Date.UTC(2026, 7, 10));
    expect(captured[0]!.legalInvoiceDate).toBeLessThanOrEqual(Date.now());
  });

  test("returning to the tab after the ledger's midnight refreshes the cap", () => {
    // A suspended tab's timer may not fire; focus must still bring the day in.
    at(new Date("2026-08-09T23:59:30Z"));
    renderDialog([]);
    expect(dateInput().max).toBe("2026-08-09");

    vi.useRealTimers();
    at(new Date("2026-08-10T00:05:00Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(dateInput().max).toBe("2026-08-10");
  });

  test("a backdated day is still sent as that day, not clamped to now", async () => {
    at(EARLY_MORNING_IN_AMMAN);
    const sent = await submitWith("2026-08-06");
    expect(sent.legalInvoiceDate).toBe(Date.UTC(2026, 7, 6));
  });
});
