import { describe, it, expect } from "vitest";
import { formatMessageStampParts, formatMessageStampTitle } from "./messageStamp";

const YESTERDAY = "Yesterday";
// Pinned so assertions about digits, month names and the year do not depend on
// the CI machine's default locale or calendar.
const LOCALE = "en-US";

/** Local-time constructor, so these assertions hold in any CI timezone. */
function at(y: number, m: number, d: number, h = 12, min = 0) {
  return new Date(y, m, d, h, min).getTime();
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

/** The stamp as the bubble renders it: prefix, a space, then the date/time run. */
function format(ts: number, now: number, yesterdayLabel = YESTERDAY) {
  const { prefix, body } = formatMessageStampParts(ts, {
    yesterdayLabel,
    now,
    locale: LOCALE,
  });
  return prefix ? `${prefix} ${body}` : body;
}

describe("formatMessageStamp", () => {
  const now = at(2026, 7, 8, 14, 30); // 8 Aug 2026, 14:30 local

  it("shows time only for a message sent today", () => {
    const ts = at(2026, 7, 8, 9, 5);
    expect(format(ts, now)).toBe(timeOf(ts));
  });

  it("still shows time only for a message sent moments ago", () => {
    expect(format(now, now)).toBe(timeOf(now));
  });

  it("includes the very first instant of today as today", () => {
    const midnight = at(2026, 7, 8, 0, 0);
    expect(format(midnight, now)).toBe(
      timeOf(midnight)
    );
  });

  it("labels yesterday rather than showing a bare time", () => {
    const ts = at(2026, 7, 7, 23, 59);
    const out = format(ts, now);
    expect(out).toBe(`${YESTERDAY} ${timeOf(ts)}`);
    // The regression this guards: a 23:59 message from yesterday must not be
    // indistinguishable from a 23:59 message from today.
    expect(out).not.toBe(timeOf(ts));
  });

  it("uses the localised yesterday label", () => {
    const ts = at(2026, 7, 7, 10, 0);
    expect(format(ts, now, "أمس")).toContain("أمس");
  });

  it("shows a date for anything older than yesterday", () => {
    const ts = at(2026, 7, 6, 10, 0);
    const out = format(ts, now);
    expect(out).not.toBe(timeOf(ts));
    expect(out).not.toContain(YESTERDAY);
    expect(out).toContain(timeOf(ts));
    // Assert the date is really there — "X 10:00 AM" would otherwise pass.
    expect(out).toContain("Aug");
    expect(out).toContain("6");
  });

  it("omits the year for an older message from the current year", () => {
    const ts = at(2026, 2, 12, 10, 0);
    expect(format(ts, now)).not.toContain("2026");
  });

  it("includes the year for a message from a previous year", () => {
    const ts = at(2025, 2, 12, 10, 0);
    expect(format(ts, now)).toContain("2025");
  });

  it("treats a same-clock-time message from last year as not today", () => {
    // Guards against a naive "same hour/minute" or modulo-24h comparison.
    const ts = at(2025, 7, 8, 14, 30);
    expect(format(ts, now)).not.toBe(timeOf(ts));
  });

  it("does not label a message from two days ago as yesterday", () => {
    // Guards a `now - 48h` style boundary that would over-extend "yesterday".
    const ts = at(2026, 7, 6, 23, 59);
    expect(format(ts, now)).not.toContain(YESTERDAY);
  });

  it("crosses a month boundary correctly", () => {
    const monthStart = at(2026, 7, 1, 10, 0); // 1 Aug
    const lastDayOfJuly = at(2026, 6, 31, 10, 0); // 31 Jul
    const out = format(lastDayOfJuly, monthStart);
    expect(out).toBe(`${YESTERDAY} ${timeOf(lastDayOfJuly)}`);
  });

  it("crosses a year boundary correctly", () => {
    const newYear = at(2026, 0, 1, 10, 0);
    const newYearsEve = at(2025, 11, 31, 10, 0);
    const out = format(newYearsEve, newYear);
    expect(out).toBe(`${YESTERDAY} ${timeOf(newYearsEve)}`);
  });

  it("does not show a future timestamp past midnight as a bare time", () => {
    // Server/client clock skew can push _creationTime beyond tonight's midnight.
    // Without an upper bound on the today window it would render as a bare
    // time, reading as "sent today" for a message dated tomorrow.
    const tomorrow = at(2026, 7, 9, 9, 0);
    const out = format(tomorrow, now);
    expect(out).not.toBe(timeOf(tomorrow));
    expect(out).not.toContain(YESTERDAY);
    expect(out).toContain(timeOf(tomorrow));
  });

  it("still shows a bare time at the last instant before midnight", () => {
    const lastMinute = at(2026, 7, 8, 23, 59);
    expect(format(lastMinute, now)).toBe(timeOf(lastMinute));
  });

  it("defaults `now` to the current clock — the only path production uses", () => {
    // MessageBubble omits `now`, so this default must work unaided.
    const justNow = Date.now();
    const { prefix, body } = formatMessageStampParts(justNow, {
      yesterdayLabel: YESTERDAY,
      locale: LOCALE,
    });
    expect(prefix).toBeNull();
    expect(body).toBe(
      new Date(justNow).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })
    );
  });
});

describe("formatMessageStampTitle", () => {
  it("carries information the abbreviated stamp does not", () => {
    const ts = at(2026, 7, 8, 14, 32);
    const title = formatMessageStampTitle(ts, { locale: LOCALE });
    const visible = format(ts, ts);

    // A tooltip repeating the visible text tells the reader nothing — the whole
    // point is resolving which day a bare "02:32 PM" belongs to.
    expect(title).not.toBe(visible);
    expect(title).toContain("2026");
    expect(title).toContain("August");
  });

  it("resolves the day for a yesterday stamp without a dictionary label", () => {
    const ts = at(2026, 7, 7, 16, 53);
    const title = formatMessageStampTitle(ts, { locale: LOCALE });
    // Single-locale by construction, so it needs no bidi isolation — a native
    // tooltip could not provide any.
    expect(title).not.toContain(YESTERDAY);
    expect(title).toContain("August");
  });

  it("defaults the locale, the only path production uses", () => {
    const ts = at(2026, 7, 8, 14, 32);
    expect(formatMessageStampTitle(ts)).toBe(
      new Date(ts).toLocaleString([], { dateStyle: "full", timeStyle: "short" })
    );
  });
});

describe("formatMessageStampParts", () => {
  const now = at(2026, 7, 8, 14, 30);

  function parts(ts: number, yesterdayLabel = YESTERDAY) {
    return formatMessageStampParts(ts, { yesterdayLabel, now, locale: LOCALE });
  }

  it("keeps the localised prefix out of the date/time run", () => {
    // Callers isolate `body` for bidi. If the prefix leaked into it, an Arabic
    // label plus a Latin time would render as `04:53 أمس PM`.
    const p = parts(at(2026, 7, 7, 16, 53), "أمس");
    expect(p.prefix).toBe("أمس");
    expect(p.body).not.toContain("أمس");
    expect(p.body).toBe(timeOf(at(2026, 7, 7, 16, 53)));
  });

  it("has no prefix for a message from today", () => {
    expect(parts(at(2026, 7, 8, 9, 0)).prefix).toBeNull();
  });

  it("carries the date inside the body, not the prefix, for older messages", () => {
    const p = parts(at(2026, 7, 3, 9, 0));
    expect(p.prefix).toBeNull();
    expect(p.body).toContain("Aug");
  });
});
