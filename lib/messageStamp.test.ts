import { describe, it, expect } from "vitest";
import { formatMessageStamp } from "./messageStamp";

const YESTERDAY = "Yesterday";

/** Local-time constructor, so these assertions hold in any CI timezone. */
function at(y: number, m: number, d: number, h = 12, min = 0) {
  return new Date(y, m, d, h, min).getTime();
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

describe("formatMessageStamp", () => {
  const now = at(2026, 7, 8, 14, 30); // 8 Aug 2026, 14:30 local

  it("shows time only for a message sent today", () => {
    const ts = at(2026, 7, 8, 9, 5);
    expect(formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now })).toBe(timeOf(ts));
  });

  it("still shows time only for a message sent moments ago", () => {
    expect(formatMessageStamp(now, { yesterdayLabel: YESTERDAY, now })).toBe(timeOf(now));
  });

  it("includes the very first instant of today as today", () => {
    const midnight = at(2026, 7, 8, 0, 0);
    expect(formatMessageStamp(midnight, { yesterdayLabel: YESTERDAY, now })).toBe(
      timeOf(midnight)
    );
  });

  it("labels yesterday rather than showing a bare time", () => {
    const ts = at(2026, 7, 7, 23, 59);
    const out = formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now });
    expect(out).toBe(`${YESTERDAY} ${timeOf(ts)}`);
    // The regression this guards: a 23:59 message from yesterday must not be
    // indistinguishable from a 23:59 message from today.
    expect(out).not.toBe(timeOf(ts));
  });

  it("uses the localised yesterday label", () => {
    const ts = at(2026, 7, 7, 10, 0);
    expect(formatMessageStamp(ts, { yesterdayLabel: "أمس", now })).toContain("أمس");
  });

  it("shows a date for anything older than yesterday", () => {
    const ts = at(2026, 7, 6, 10, 0);
    const out = formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now });
    expect(out).not.toBe(timeOf(ts));
    expect(out).not.toContain(YESTERDAY);
    expect(out).toContain(timeOf(ts));
  });

  it("omits the year for an older message from the current year", () => {
    const ts = at(2026, 2, 12, 10, 0);
    expect(formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now })).not.toContain("2026");
  });

  it("includes the year for a message from a previous year", () => {
    const ts = at(2025, 2, 12, 10, 0);
    expect(formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now })).toContain("2025");
  });

  it("treats a same-clock-time message from last year as not today", () => {
    // Guards against a naive "same hour/minute" or modulo-24h comparison.
    const ts = at(2025, 7, 8, 14, 30);
    expect(formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now })).not.toBe(timeOf(ts));
  });

  it("does not label a message from two days ago as yesterday", () => {
    // Guards a `now - 48h` style boundary that would over-extend "yesterday".
    const ts = at(2026, 7, 6, 23, 59);
    expect(formatMessageStamp(ts, { yesterdayLabel: YESTERDAY, now })).not.toContain(YESTERDAY);
  });

  it("crosses a month boundary correctly", () => {
    const monthStart = at(2026, 7, 1, 10, 0); // 1 Aug
    const lastDayOfJuly = at(2026, 6, 31, 10, 0); // 31 Jul
    const out = formatMessageStamp(lastDayOfJuly, {
      yesterdayLabel: YESTERDAY,
      now: monthStart,
    });
    expect(out).toBe(`${YESTERDAY} ${timeOf(lastDayOfJuly)}`);
  });

  it("crosses a year boundary correctly", () => {
    const newYear = at(2026, 0, 1, 10, 0);
    const newYearsEve = at(2025, 11, 31, 10, 0);
    const out = formatMessageStamp(newYearsEve, { yesterdayLabel: YESTERDAY, now: newYear });
    expect(out).toBe(`${YESTERDAY} ${timeOf(newYearsEve)}`);
  });
});
