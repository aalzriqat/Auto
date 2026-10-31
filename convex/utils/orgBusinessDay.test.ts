import { describe, expect, test } from "vitest";
import {
  calendarDateInTimeZone,
  calendarDateOfKey,
  calendarKeyOf,
  instantRangeOfCalendarDate,
  instantSpanOfCalendarDate,
  isUtcMidnight,
  orgDayCalendarKeyRange,
  orgDayInstantRange,
  orgDayPaymentDateRanges,
  orgDayWindow,
  paymentDateProvenance,
  paymentOnOrgDay,
  resolveOrgTimeZone,
  type PaymentDateFacts,
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

  test("Apia skipped 2011-12-30: the day before it ends where the next existing date starts", () => {
    // Pacific/Apia moved from UTC-10 to UTC+14 at the end of 2011-12-29; 2011-12-30 never existed.
    const dec29 = instantRangeOfCalendarDate("Pacific/Apia", { year: 2011, month: 12, day: 29 });
    expect(dec29.start).toBe(Date.parse("2011-12-29T10:00:00Z")); // 00:00 on 29 Dec, UTC-10
    expect(dec29.end).toBe(Date.parse("2011-12-30T09:59:59.999Z")); // 23:59:59.999 on 29 Dec
    const dec31 = instantRangeOfCalendarDate("Pacific/Apia", { year: 2011, month: 12, day: 31 });
    expect(dec31.start).toBe(Date.parse("2011-12-30T10:00:00Z")); // 00:00 on 31 Dec, UTC+14
    expect(dec31.start).toBe(dec29.end + 1);
  });

  test("a skipped date has no span and cannot be asked for as an instant range", () => {
    expect(instantSpanOfCalendarDate("Pacific/Apia", { year: 2011, month: 12, day: 30 })).toBeNull();
    expect(() => instantRangeOfCalendarDate("Pacific/Apia", { year: 2011, month: 12, day: 30 })).toThrow(
      /Cannot resolve the start of 2011-12-30/,
    );
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

  test("a UTC midnight is the only shape a calendar key can have", () => {
    expect(isUtcMidnight(Date.parse("2026-10-31T00:00:00Z"))).toBe(true);
    expect(isUtcMidnight(Date.parse("2026-10-31T00:00:00.001Z"))).toBe(false);
    expect(isUtcMidnight(Date.parse("2026-10-30T21:00:00Z"))).toBe(false);
  });

  test("east of UTC the range is the zone's span (it already carries the day's own key)", () => {
    expect(orgDayPaymentDateRanges("Asia/Amman", { year: 2026, month: 10, day: 31 })).toEqual([
      { start: Date.parse("2026-10-30T21:00:00Z"), end: Date.parse("2026-10-31T20:59:59.999Z") },
    ]);
  });

  test("west of UTC the date's own key is added beside the zone's span, and the span is not split", () => {
    // 31 Oct in New York is 04:00Z 31 Oct .. 03:59:59.999Z 1 Nov, EDT. 00:00Z 31 Oct is the 31 Oct key.
    // 00:00Z 1 Nov lies INSIDE that span: as an instant it is 20:00 on 31 Oct, so the span keeps it.
    expect(orgDayPaymentDateRanges("America/New_York", { year: 2026, month: 10, day: 31 })).toEqual([
      { start: Date.parse("2026-10-31T00:00:00Z"), end: Date.parse("2026-10-31T00:00:00Z") },
      { start: Date.parse("2026-10-31T04:00:00Z"), end: Date.parse("2026-11-01T03:59:59.999Z") },
    ]);
  });

  test("a skipped date keeps only its own key (nothing happened on it)", () => {
    const window = orgDayWindow("Pacific/Apia", { year: 2011, month: 12, day: 30 });
    expect(window.span).toBeNull();
    expect(window.ranges).toEqual([{ start: Date.UTC(2011, 11, 30), end: Date.UTC(2011, 11, 30) }]);
  });

  const zones = [
    "UTC", "Asia/Amman", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago",
    "Pacific/Chatham", "Australia/Lord_Howe", "America/Sao_Paulo", "America/Santiago", "Europe/London",
  ];
  const dayOffsetsMs = [0, 1, 3_600_000, 43_200_000, 79_199_999, 86_399_999];

  const wallDateKey = (zone: string, value: number) => {
    const d = calendarDateInTimeZone(zone, value);
    return Date.UTC(d.year, d.month - 1, d.day);
  };
  const facts = (over: Partial<PaymentDateFacts> & { paymentDate: number }): PaymentDateFacts => ({
    createdAt: over.paymentDate + 5,
    direction: "IN",
    method: "CASH",
    ...over,
  });

  // The ownership property, by the stored footprint of each writer (never by shape alone):
  //  - an event instant (cheque clearing, a non-midnight value) belongs to the date the zone's clock shows;
  //  - a calendar key (record-payment form) belongs to the date it names;
  //  - a refund whose key/instant reading is ambiguous is filed on its one date when both readings agree
  //    and is UNPLACEABLE on exactly the two dates they name when they differ.
  test.each(zones)("%s: across a full year every row has exactly one owner day, or two flags", (zone) => {
    const first = Date.UTC(2026, 0, 1);
    const days = Array.from({ length: 366 }, (_, i) => first + i * 86_400_000);
    const windows = days.map((key) => orgDayWindow(zone, calendarDateOfKey(key)));
    // Probes sit in the middle of the year so every day's neighbours are in the table.
    for (const base of days.slice(2, 364)) {
      for (const offset of dayOffsetsMs) {
        const value = base + offset;
        const label = `${zone} ${new Date(value).toISOString()}`;
        const verdictsOf = (row: PaymentDateFacts) =>
          windows.map((w) => {
            const verdict = paymentOnOrgDay(w, row);
            // The index read must reach every row the verdict can name, or the row is silently lost.
            if (verdict !== "NOT_IN_DAY") expect(inRanges(w.ranges, row.paymentDate), `read reach ${label}`).toBe(true);
            return { w, verdict };
          });

        const instant = verdictsOf(facts({ paymentDate: value, chequeId: "cheque" }));
        const instantHome = instant.filter((v) => v.verdict === "IN_DAY");
        expect(instantHome, `instant ${label}`).toHaveLength(1);
        expect(instantHome[0].w.ownKey, `instant ${label}`).toBe(wallDateKey(zone, value));
        expect(instant.filter((v) => v.verdict === "UNPLACEABLE")).toHaveLength(0);

        if (!isUtcMidnight(value)) continue;

        const key = verdictsOf(facts({ paymentDate: value }));
        const keyHome = key.filter((v) => v.verdict === "IN_DAY");
        expect(keyHome, `key ${label}`).toHaveLength(1);
        expect(keyHome[0].w.ownKey, `key ${label}`).toBe(value);
        expect(key.filter((v) => v.verdict === "UNPLACEABLE")).toHaveLength(0);

        const ambiguous = verdictsOf(facts({ paymentDate: value, createdAt: value, direction: "OUT", method: "REFUND" }));
        const home = ambiguous.filter((v) => v.verdict === "IN_DAY");
        const unplaceable = ambiguous.filter((v) => v.verdict === "UNPLACEABLE");
        if (wallDateKey(zone, value) === value) {
          expect(home.map((v) => v.w.ownKey), `ambiguous ${label}`).toEqual([value]);
          expect(unplaceable, `ambiguous ${label}`).toHaveLength(0);
        } else {
          expect(home, `ambiguous ${label}`).toHaveLength(0);
          expect(unplaceable.map((v) => v.w.ownKey).sort((a, b) => a - b), `ambiguous ${label}`).toEqual(
            [value, wallDateKey(zone, value)].sort((a, b) => a - b),
          );
        }
      }
    }
  });

  test("provenance comes from the writer's stored footprint, not from the number's shape", () => {
    const midnight = Date.parse("2026-11-01T00:00:00.000Z");
    // clearCheque is the only writer that sets chequeId: an instant even at exactly 00:00:00.000Z.
    expect(paymentDateProvenance(facts({ paymentDate: midnight, chequeId: "c1" }))).toBe("EVENT_INSTANT");
    // A value that is not a UTC midnight can never be a calendar key.
    expect(paymentDateProvenance(facts({ paymentDate: midnight + 1 }))).toBe("EVENT_INSTANT");
    // The form stamps createdAt with the write time, which is not the picked date's midnight.
    expect(paymentDateProvenance(facts({ paymentDate: midnight, createdAt: midnight - 3_600_000 }))).toBe("CALENDAR_KEY");
    // System writers store one clock reading in both fields.
    expect(paymentDateProvenance(facts({ paymentDate: midnight, createdAt: midnight }))).toBe("EVENT_INSTANT");
    expect(paymentDateProvenance(facts({ paymentDate: midnight, createdAt: midnight, direction: "OUT" }))).toBe("EVENT_INSTANT");
    // ...except an OUT/REFUND row, which the sale-close deposit refund also writes with the sale's date key.
    expect(
      paymentDateProvenance(facts({ paymentDate: midnight, createdAt: midnight, direction: "OUT", method: "REFUND" })),
    ).toBe("KEY_OR_INSTANT");
  });

  test("New York: an instant at 00:00:00.000Z on 1 Nov is 20:00 on 31 Oct, not a 1 Nov key", () => {
    const midnight = Date.parse("2026-11-01T00:00:00.000Z");
    const oct31 = orgDayWindow("America/New_York", { year: 2026, month: 10, day: 31 });
    const nov1 = orgDayWindow("America/New_York", { year: 2026, month: 11, day: 1 });
    const cleared = facts({ paymentDate: midnight, chequeId: "c1" });
    expect(paymentOnOrgDay(oct31, cleared)).toBe("IN_DAY");
    expect(paymentOnOrgDay(nov1, cleared)).toBe("NOT_IN_DAY");
    const formKey = facts({ paymentDate: midnight, createdAt: midnight - 3_600_000 });
    expect(paymentOnOrgDay(nov1, formKey)).toBe("IN_DAY");
    expect(paymentOnOrgDay(oct31, formKey)).toBe("NOT_IN_DAY");
  });

  test("an ambiguous refund is UNPLACEABLE west of UTC and placed east of it", () => {
    const midnight = Date.parse("2026-11-01T00:00:00.000Z");
    const refund = facts({ paymentDate: midnight, createdAt: midnight, direction: "OUT", method: "REFUND" });
    expect(paymentOnOrgDay(orgDayWindow("America/New_York", { year: 2026, month: 10, day: 31 }), refund)).toBe("UNPLACEABLE");
    expect(paymentOnOrgDay(orgDayWindow("America/New_York", { year: 2026, month: 11, day: 1 }), refund)).toBe("UNPLACEABLE");
    expect(paymentOnOrgDay(orgDayWindow("America/New_York", { year: 2026, month: 11, day: 2 }), refund)).toBe("NOT_IN_DAY");
    expect(paymentOnOrgDay(orgDayWindow("Asia/Amman", { year: 2026, month: 11, day: 1 }), refund)).toBe("IN_DAY");
    expect(paymentOnOrgDay(orgDayWindow("Asia/Amman", { year: 2026, month: 10, day: 31 }), refund)).toBe("NOT_IN_DAY");
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