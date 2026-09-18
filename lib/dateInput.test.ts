/**
 * These run under Asia/Amman (UTC+3) on purpose. Under the CI default of UTC a
 * local-time parse and a UTC parse coincide, so a regression back to
 * `new Date(\`${value}T00:00:00\`)` would pass unnoticed. At +3 the two diverge
 * at every day boundary, which is exactly where the bug bit.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  dateInputToUtcMs,
  dateInputEndToUtcMs,
  economicDateInputToMs,
  economicTodayDateInput,
  todayDateInput,
  daysFromTodayDateInput,
  msToDateInput,
} from "./dateInput";

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Amman";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("dateInput UTC parsing", () => {
  it("proves the test timezone is actually ahead of UTC", () => {
    // Guards the guard: if this fails, TZ didn't take effect and the assertions
    // below would no longer distinguish a UTC parse from a local one.
    expect(new Date("2026-08-01T00:00:00").getTime()).not.toBe(Date.UTC(2026, 7, 1));
  });

  it("parses the first of a month to UTC midnight, not the previous UTC day", () => {
    // The exact Jordan bug: a local parse of 2026-08-01 lands on 2026-07-31 21:00Z.
    expect(dateInputToUtcMs("2026-08-01")).toBe(Date.UTC(2026, 7, 1));
    expect(new Date(dateInputToUtcMs("2026-08-01")).getUTCMonth()).toBe(7); // August, not July
  });

  it("puts the end of a range at the last millisecond of the picked UTC day", () => {
    expect(dateInputEndToUtcMs("2026-08-31")).toBe(Date.UTC(2026, 7, 31, 23, 59, 59, 999));
    // The final hours of the 31st aren't clipped into the 30th.
    expect(new Date(dateInputEndToUtcMs("2026-08-31")).getUTCDate()).toBe(31);
  });

  it("round-trips a stored ms back to the same calendar date it was entered as", () => {
    const stored = dateInputToUtcMs("2026-01-01");
    expect(msToDateInput(stored)).toBe("2026-01-01");
  });

  it("returns NaN for an empty or malformed value, as the old parser did", () => {
    expect(Number.isNaN(dateInputToUtcMs(""))).toBe(true);
    expect(Number.isNaN(dateInputEndToUtcMs("not-a-date"))).toBe(true);
  });

  it("defaults the picker to the LOCAL calendar today, not the UTC date", () => {
    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(todayDateInput()).toBe(localToday);
    // A week ahead is seven local days on.
    const week = new Date();
    week.setDate(week.getDate() + 7);
    const localWeek = `${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, "0")}-${String(week.getDate()).padStart(2, "0")}`;
    expect(daysFromTodayDateInput(7)).toBe(localWeek);
  });
});

describe("economic dates — the picked calendar date, exactly, on the ledger's UTC calendar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends TODAY as the picked day's UTC midnight — never `Date.now()`, which crosses the UTC month in the first hours of a local day", () => {
    // 01:30 local in Amman on 1 October is 22:30Z on 30 SEPTEMBER. The old
    // contract sent today as `Date.now()`, so a movement the operator dated
    // "2026-10-01" was filed on 30 September — the previous UTC month (and,
    // at a year end, the previous fiscal year).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 22, 30)));
    expect(todayDateInput()).toBe("2026-10-01");
    expect(economicDateInputToMs("2026-10-01")).toBe(Date.UTC(2026, 9, 1));
    expect(economicDateInputToMs("2026-10-01")).not.toBe(Date.now());
    expect(new Date(economicDateInputToMs("2026-10-01")).getUTCMonth()).toBe(9);
    // And for a user BEHIND UTC in their evening (20:00 in Los Angeles on the
    // 30th is 03:00Z on 1 October): the picked 30th stays the 30th.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 3, 0)));
    expect(economicDateInputToMs("2026-09-30")).toBe(Date.UTC(2026, 8, 30));
    expect(new Date(economicDateInputToMs("2026-09-30")).getUTCMonth()).toBe(8);
  });

  it("defaults and caps an economic picker at the UTC today, which the server always accepts", () => {
    // In the hours where the local day is ahead of the UTC day, the UTC
    // today is what the server's clock has reached: its midnight is in the
    // past and passes the no-tolerance future refusal; the local today's
    // midnight would be refused.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 22, 30)));
    expect(economicTodayDateInput()).toBe("2026-09-30");
    expect(economicTodayDateInput()).not.toBe(todayDateInput());
    expect(economicDateInputToMs(economicTodayDateInput())).toBeLessThanOrEqual(Date.now());
    expect(economicDateInputToMs(todayDateInput())).toBeGreaterThan(Date.now());
    // Once the UTC day has caught up, the two agree.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 5, 0)));
    expect(economicTodayDateInput()).toBe("2026-10-01");
    expect(economicTodayDateInput()).toBe(todayDateInput());
    expect(economicDateInputToMs(economicTodayDateInput())).toBeLessThanOrEqual(Date.now());
  });

  it("sends a backdated day as its UTC midnight, which is always in the past", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 15, 22, 30)));
    expect(economicDateInputToMs("2026-09-15")).toBe(Date.UTC(2026, 8, 15));
    expect(economicDateInputToMs("2026-09-15")).toBeLessThan(Date.now());
  });

  it("returns NaN for an empty or malformed value, as `dateInputToUtcMs` does", () => {
    expect(Number.isNaN(economicDateInputToMs(""))).toBe(true);
    expect(Number.isNaN(economicDateInputToMs("not-a-date"))).toBe(true);
  });
});
