import { describe, expect, test } from "vitest";
import {
  calendarDateOfKey,
  calendarKeyOf,
  instantRangeOfCalendarDate,
  orgDayCalendarKeyRange,
  orgDayInstantRange,
  resolveOrgTimeZone,
} from "./orgBusinessDay";

// Expected instants are written out from the tz database (offsets in comments), not derived from the code.
describe("SCRUM-264 org business day helper", () => {
  test("Amman is UTC+3 since October 2022 and UTC+2 in the winter before", () => {
    expect(instantRangeOfCalendarDate("Asia/Amman", { year: 2026, month: 10, day: 31 })).toEqual({
      start: Date.parse("2026-10-30T21:00:00Z"),
      end: Date.parse("2026-10-31T20:59:59.999Z"),
    });
    expect(instantRangeOfCalendarDate("Asia/Amman", { year: 2022, month: 1, day: 15 })).toEqual({
      start: Date.parse("2022-01-14T22:00:00Z"),
      end: Date.parse("2022-01-15T21:59:59.999Z"),
    });
  });

  test("a fall-back day is 25 hours and a spring-forward day is 23 hours", () => {
    const fall = instantRangeOfCalendarDate("America/New_York", { year: 2026, month: 11, day: 1 });
    expect(fall.start).toBe(Date.parse("2026-11-01T04:00:00Z")); // 00:00 EDT
    expect(fall.end).toBe(Date.parse("2026-11-02T04:59:59.999Z")); // 23:59:59.999 EST
    const spring = instantRangeOfCalendarDate("America/New_York", { year: 2026, month: 3, day: 8 });
    expect(spring.start).toBe(Date.parse("2026-03-08T05:00:00Z")); // 00:00 EST
    expect(spring.end).toBe(Date.parse("2026-03-09T03:59:59.999Z")); // 23:59:59.999 EDT
  });

  test("a zone that skips midnight starts the day at the first instant that exists", () => {
    // America/Sao_Paulo on 2018-11-04: the clock jumped from 23:59:59 on 3 Nov straight to 01:00 on 4 Nov.
    const day = instantRangeOfCalendarDate("America/Sao_Paulo", { year: 2018, month: 11, day: 4 });
    expect(day.start).toBe(Date.parse("2018-11-04T03:00:00Z"));
    const previous = instantRangeOfCalendarDate("America/Sao_Paulo", { year: 2018, month: 11, day: 3 });
    expect(previous.end).toBe(day.start - 1);
  });

  test("the org day containing an instant, as an instant range and as a calendar-key range", () => {
    const at = Date.parse("2026-10-30T22:30:00Z"); // 01:30 on 31 Oct in Amman
    expect(orgDayInstantRange("Asia/Amman", at)).toEqual({
      start: Date.parse("2026-10-30T21:00:00Z"),
      end: Date.parse("2026-10-31T20:59:59.999Z"),
    });
    expect(orgDayCalendarKeyRange("Asia/Amman", at)).toEqual({
      start: Date.parse("2026-10-31T00:00:00Z"),
      end: Date.parse("2026-10-31T23:59:59.999Z"),
    });
  });

  test("a business-date key names its calendar date by its UTC fields", () => {
    expect(calendarDateOfKey(Date.parse("2026-10-31T00:00:00Z"))).toEqual({ year: 2026, month: 10, day: 31 });
    expect(calendarKeyOf(Date.parse("2026-10-31T17:45:00Z"))).toBe(Date.parse("2026-10-31T00:00:00Z"));
  });

  test("a missing or unknown zone resolves to the default", () => {
    expect(resolveOrgTimeZone(undefined)).toBe("Asia/Amman");
    expect(resolveOrgTimeZone("  ")).toBe("Asia/Amman");
    expect(resolveOrgTimeZone("Not/AZone")).toBe("Asia/Amman");
    expect(resolveOrgTimeZone("America/New_York")).toBe("America/New_York");
  });
});
