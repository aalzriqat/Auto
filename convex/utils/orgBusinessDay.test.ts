import { describe, expect, test } from "vitest";
import {
  calendarDateInTimeZone,
  calendarDateOfKey,
  calendarKeyOf,
  instantRangeOfCalendarDate,
  isCalendarKey,
  orgDayCalendarKeyRange,
  orgDayInstantRange,
  orgDayPaymentDateRanges,
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

describe("SCRUM-264 payment-date ranges file every payment under exactly one organization day", () => {
  const inRanges = (ranges: Array<{ start: number; end: number }>, value: number) =>
    ranges.some((range) => value >= range.start && value <= range.end);

  test("a calendar key is exactly a UTC midnight", () => {
    expect(isCalendarKey(Date.parse("2026-10-31T00:00:00Z"))).toBe(true);
    expect(isCalendarKey(Date.parse("2026-10-31T00:00:00.001Z"))).toBe(false);
    expect(isCalendarKey(Date.parse("2026-10-30T21:00:00Z"))).toBe(false);
  });

  test("east of UTC the range is the zone's span (it already carries the day's own key)", () => {
    expect(orgDayPaymentDateRanges("Asia/Amman", { year: 2026, month: 10, day: 31 })).toEqual([
      { start: Date.parse("2026-10-30T21:00:00Z"), end: Date.parse("2026-10-31T20:59:59.999Z") },
    ]);
  });

  test("west of UTC the span skips the next date's key and the date's own key is added", () => {
    // 31 Oct in New York is 04:00Z 31 Oct .. 03:59:59.999Z 1 Nov, EDT. 00:00Z 1 Nov is the 1 Nov key.
    expect(orgDayPaymentDateRanges("America/New_York", { year: 2026, month: 10, day: 31 })).toEqual([
      { start: Date.parse("2026-10-31T00:00:00Z"), end: Date.parse("2026-10-31T00:00:00Z") },
      { start: Date.parse("2026-10-31T04:00:00Z"), end: Date.parse("2026-10-31T23:59:59.999Z") },
      { start: Date.parse("2026-11-01T00:00:00.001Z"), end: Date.parse("2026-11-01T03:59:59.999Z") },
    ]);
  });

  const zones = [
    "UTC", "Asia/Amman", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago",
    "Pacific/Chatham", "Australia/Lord_Howe", "America/Sao_Paulo", "America/Santiago", "Europe/London",
  ];
  const dayOffsetsMs = [0, 1, 3_600_000, 43_200_000, 79_199_999, 86_399_999];

  test.each(zones)("%s: across a full year every key and instant has exactly one owner day", (zone) => {
    const first = Date.UTC(2026, 0, 1);
    const days = Array.from({ length: 366 }, (_, i) => first + i * 86_400_000);
    const owners = days.map((key) => ({
      key,
      ranges: orgDayPaymentDateRanges(zone, calendarDateOfKey(key)),
    }));
    // Probes sit in the middle of the year so every day's neighbours are in the table.
    for (const base of days.slice(2, 364)) {
      for (const offset of dayOffsetsMs) {
        const value = base + offset;
        const matching = owners.filter((owner) => inRanges(owner.ranges, value));
        expect(matching, `${zone} ${new Date(value).toISOString()}`).toHaveLength(1);
        const owner = matching[0];
        if (isCalendarKey(value)) {
          // A calendar key belongs to the date it names, in every zone.
          expect(owner.key).toBe(value);
        } else {
          // An instant belongs to the date the zone's wall clock shows.
          expect(owner.key).toBe(
            Date.UTC(
              calendarDateInTimeZone(zone, value).year,
              calendarDateInTimeZone(zone, value).month - 1,
              calendarDateInTimeZone(zone, value).day,
            ),
          );
        }
      }
    }
  });

  test("ranges are sorted, disjoint and never inverted", () => {
    for (const zone of zones) {
      for (let i = 0; i < 366; i += 1) {
        const ranges = orgDayPaymentDateRanges(zone, calendarDateOfKey(Date.UTC(2026, 0, 1 + i)));
        for (let r = 0; r < ranges.length; r += 1) {
          expect(ranges[r].start).toBeLessThanOrEqual(ranges[r].end);
          if (r > 0) expect(ranges[r].start).toBeGreaterThan(ranges[r - 1].end);
        }
      }
    }
  });
});