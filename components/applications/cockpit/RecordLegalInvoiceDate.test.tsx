/**
 * SCRUM-596 / SCRUM-411 — the legal invoice date is a DOCUMENT date (the one
 * printed on the paper): it is never defaulted, it is never sent as an instant
 * the server will refuse, and it never silently moves to another day.
 *
 * SCRUM-596 found that the dialog defaulted to the operator's LOCAL calendar day
 * and sent it as UTC midnight, which east of UTC is in the FUTURE for the first
 * hours of the local morning (until 03:00 in Amman) and which
 * `recordLegalInvoice` refuses. SCRUM-411 then removed the default altogether:
 * the sale no longer needs this invoice, so nothing on this form may look real
 * before a person enters it. The picker is capped at the earlier of the local
 * and UTC days, and the operator picks the paper's date.
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

function renderDialog(captured: RecordLegalInvoiceValues[], vehicleIsConsigned = false) {
  return render(
    <RecordLegalInvoiceDialog
      open
      submitting={false}
      error={null}
      scale={3}
      currency="JOD"
      vehicleIsConsigned={vehicleIsConsigned}
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

async function submitWith(day: string): Promise<RecordLegalInvoiceValues> {
  const captured: RecordLegalInvoiceValues[] = [];
  renderDialog(captured);
  fillRequired();
  fireEvent.change(dateInput(), { target: { value: day } });
  fireEvent.click(submitButton());
  await vi.waitFor(() => expect(captured).toHaveLength(1));
  return captured[0]!;
}

describe("the date a legal invoice is recorded under", () => {
  test("no date is ever pre-filled: the form cannot be submitted until a day is picked", () => {
    at(NOON_IN_AMMAN);
    renderDialog([]);
    fillRequired();
    expect(dateInput().value).toBe("");
    expect(submitButton().disabled).toBe(true);
    expect(screen.queryByText("LegalInvoiceDateNotOpenYet")).toBeNull();

    fireEvent.change(dateInput(), { target: { value: "2026-08-10" } });
    expect(submitButton().disabled).toBe(false);
  });

  test("before the local day opens on the ledger, the cap is the ledger day and the hint says why", () => {
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

  test("on the 1st of a month before 03:00 the picker is capped at the previous month's last day", () => {
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

  test("behind UTC, the cap is the local day, not the UTC tomorrow", async () => {
    at(EVENING_IN_NEW_YORK, "America/New_York");
    expect(new Date().getDate()).toBe(9);

    renderDialog([]);
    expect(dateInput().value).toBe("");
    expect(dateInput().max).toBe("2026-08-09");
    cleanup();

    const sent = await submitWith("2026-08-09");
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

  test("behind UTC, a dialog left open across local midnight keeps the pick and moves the cap", async () => {
    // 23:59:30 on 31 August in New York; the ledger is already on 1 September (Sol 6 on 8846fc9d4).
    at(new Date("2026-09-01T03:59:30Z"), "America/New_York");
    renderDialog([]);
    fillRequired();
    fireEvent.change(dateInput(), { target: { value: "2026-08-28" } });
    expect(dateInput().max).toBe("2026-08-31");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(dateInput().max).toBe("2026-09-01");
    // The operator's pick is state and survives the refresh.
    expect(dateInput().value).toBe("2026-08-28");
  });

  test("a date is never supplied for the operator when the day turns over", async () => {
    // 23:50 on 30 September in Amman: left open past 00:00 there is still nothing to carry over.
    at(new Date("2026-09-30T20:50:00Z"));
    renderDialog([]);
    fillRequired();
    expect(dateInput().value).toBe("");

    await act(async () => {
      vi.advanceTimersByTime(20 * 60_000);
    });
    expect(new Date().getDate()).toBe(1);
    expect(dateInput().value).toBe("");
    expect(dateInput().max).toBe("2026-09-30");
    expect(submitButton().disabled).toBe(true);
    // Typed fields survive.
    expect((screen.getByLabelText("LegalInvoiceNumber") as HTMLInputElement).value).toBe("INV-0596");
  });

  test("a day picked before midnight is kept and sent after it (Opus L-3)", async () => {
    at(new Date("2026-09-30T20:50:00Z"));
    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured);
    fillRequired();
    fireEvent.change(dateInput(), { target: { value: "2026-09-29" } });

    await act(async () => {
      vi.advanceTimersByTime(20 * 60_000);
    });
    expect(dateInput().value).toBe("2026-09-29");
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.legalInvoiceDate).toBe(Date.UTC(2026, 8, 29));
  });

  test("the stored date is captured at open, like the other stored fields (Opus L-2)", () => {
    at(NOON_IN_AMMAN);
    const props = {
      open: true,
      submitting: false,
      error: null,
      scale: 3,
      currency: "JOD",
      t: (key: string) => key,
      onOpenChange: () => {},
      onSubmit: async () => {},
    };
    const { rerender } = render(
      <RecordLegalInvoiceDialog
        {...props}
        existing={{ amountMinor: 12_500_000, number: "INV-0596", date: Date.UTC(2026, 7, 5) }}
      />
    );
    // Another user saves a different invoice meanwhile.
    rerender(
      <RecordLegalInvoiceDialog
        {...props}
        existing={{ amountMinor: 9_000_000, number: "INV-OTHER", date: Date.UTC(2026, 7, 8) }}
      />
    );
    expect(dateInput().value).toBe("2026-08-05");
    expect((screen.getByLabelText("LegalInvoiceNumber") as HTMLInputElement).value).toBe("INV-0596");
  });

  test("a stored date is not replaced by the day turning over", async () => {
    at(new Date("2026-09-30T20:50:00Z"));
    render(
      <RecordLegalInvoiceDialog
        open
        submitting={false}
        error={null}
        scale={3}
        currency="JOD"
        existing={{ amountMinor: 12_500_000, number: "INV-0596", date: Date.UTC(2026, 8, 28) }}
        t={(key: string) => key}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />
    );
    await act(async () => {
      vi.advanceTimersByTime(20 * 60_000);
    });
    expect(dateInput().value).toBe("2026-09-28");
  });

  test("the refresh lands after the boundary, never before, and re-arms for the next one", async () => {
    // 02:59:30 Amman on 10 August; the ledger day opens at 00:00:00Z.
    at(new Date("2026-08-09T23:59:30Z"));
    // Frozen clock: real time leaking in would make the 200 ms window flaky.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T23:59:30Z"));
    renderDialog([]);
    const advance = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    };

    await advance(30_000 + 900); // 00:00:00.9Z — still before the refresh lands
    expect(dateInput().max).toBe("2026-08-09");
    await advance(200); // 00:00:01.1Z
    expect(dateInput().max).toBe("2026-08-10");
    expect(document.querySelector("#legal-invoice-date-hint")).toBeNull();

    // Local midnight in Amman (21:00Z): the 11th has not opened on the ledger yet.
    await advance(21 * 60 * 60_000);
    expect(document.querySelector("#legal-invoice-date-hint")).not.toBeNull();
    expect(dateInput().max).toBe("2026-08-10");

    // The ledger's next midnight.
    await advance(3 * 60 * 60_000);
    expect(dateInput().max).toBe("2026-08-11");
    expect(document.querySelector("#legal-invoice-date-hint")).toBeNull();
  });

  test("a tab made visible again after the ledger's midnight refreshes the cap", () => {
    at(new Date("2026-08-09T23:59:30Z"));
    renderDialog([]);
    expect(dateInput().max).toBe("2026-08-09");

    vi.useRealTimers();
    at(new Date("2026-08-10T00:05:00Z"));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(dateInput().max).toBe("2026-08-10");
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

describe("who issued the invoice (SCRUM-411)", () => {
  test("a dealer-owned car sends the dealership as issuer and shows no issuer field", async () => {
    at(NOON_IN_AMMAN);
    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured, false);
    fillRequired();
    fireEvent.change(dateInput(), { target: { value: "2026-08-10" } });
    expect(screen.queryByLabelText("LegalInvoiceIssuerName")).toBeNull();
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.issuedBy).toBe("DEALERSHIP");
    expect(captured[0]!.issuerName).toBeUndefined();
  });

  test("a consigned car needs the importer's or supplier's name and sends it as a third party", async () => {
    at(NOON_IN_AMMAN);
    const captured: RecordLegalInvoiceValues[] = [];
    renderDialog(captured, true);
    fillRequired();
    fireEvent.change(dateInput(), { target: { value: "2026-08-10" } });
    // Everything else is valid, yet the importer's document is not the dealership's.
    expect(submitButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("LegalInvoiceIssuerName"), { target: { value: "  Al-Salam Imports  " } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.issuedBy).toBe("THIRD_PARTY");
    expect(captured[0]!.issuerName).toBe("Al-Salam Imports");
  });
});
