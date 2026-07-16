/**
 * These run under Asia/Amman (UTC+3) on purpose. Under the CI default of UTC a
 * local-time parse and a UTC parse coincide, so a regression back to
 * `new Date(\`${value}T00:00:00\`)` would pass unnoticed. At +3 the two diverge
 * at every day boundary, which is exactly where the bug bit.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  dateInputToUtcMs,
  dateInputEndToUtcMs,
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
