import { describe, expect, test } from "vitest";
import {
  calendarDateInTimeZone,
  orgDayWindow,
  paymentOnOrgDay,
  type CalendarDate,
  type OrgDayWindow,
  type PaymentDateFacts,
} from "./orgBusinessDay";

/**
 * SCRUM-264 property probe (PR #741, Seat 2 round 2): every calendar date from 2009 to 2030 in zones
 * that cover the shapes the tz database has produced - fixed offsets east and west of UTC, a half and
 * a quarter hour offset, daylight-saving in both hemispheres, a midnight that does not exist
 * (Sao Paulo, Santiago), a skipped whole date (Apia 2011-12-30), a repeated date (Kiritimati 1994 is
 * out of range; Pago Pago and Apia cross the date line).
 *
 * It checks the helper against `Intl` read independently, not against its own arithmetic:
 *  1. the spans tile the timeline (no gap, no overlap), skipping over a date no instant belongs to;
 *  2. the first and last millisecond of each span read as that date on the zone's own clock;
 *  3. each payment shape has exactly one owner day (or two flags for the ambiguous refund), and the
 *     index ranges reach every row a verdict names.
 */
const ZONES = [
  "UTC", "Asia/Amman", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago",
  "Pacific/Chatham", "Australia/Lord_Howe", "America/Sao_Paulo", "America/Santiago", "Europe/London",
  "Pacific/Tongatapu", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns",
  "Africa/Casablanca", "America/Caracas", "Europe/Istanbul", "Pacific/Auckland",
  "Pacific/Apia",
];

const dateOf = (key: number): CalendarDate => {
  const d = new Date(key);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const keyOfDate = (d: CalendarDate) => Date.UTC(d.year, d.month - 1, d.day);
const inRanges = (window: OrgDayWindow, value: number) =>
  window.ranges.some((range) => value >= range.start && value <= range.end);
const facts = (over: Partial<PaymentDateFacts> & { paymentDate: number }): PaymentDateFacts => ({
  createdAt: over.paymentDate + 5,
  direction: "IN",
  method: "CASH",
  ...over,
});

describe("SCRUM-264 org-day property probe, 2009-2030", () => {
  test.each(ZONES)("%s", { timeout: 120_000 }, (zone) => {
    const first = Date.UTC(2009, 0, 1);
    const last = Date.UTC(2030, 11, 31);
    const days: number[] = [];
    for (let key = first; key <= last; key += 86_400_000) days.push(key);
    const windows = days.map((key) => orgDayWindow(zone, dateOf(key)));

    let skipped = 0;
    for (let i = 1; i < windows.length - 2; i += 1) {
      const w = windows[i];
      const label = `${zone} ${new Date(days[i]).toISOString().slice(0, 10)}`;
      const neighbours = [windows[i - 1], w, windows[i + 1], windows[i + 2]];

      if (w.span === null) {
        // A skipped date: no instant reads it, and the day before runs to the start of the day after.
        skipped += 1;
        expect(windows[i - 1].span, label).not.toBeNull();
        expect(windows[i + 1].span, label).not.toBeNull();
        expect(windows[i - 1].span!.end + 1, label).toBe(windows[i + 1].span!.start);
        expect(w.ranges, label).toEqual([{ start: w.ownKey, end: w.ownKey }]);
      } else {
        // Tiling: the next existing date starts one millisecond after this one ends.
        const next = windows[i + 1].span ?? windows[i + 2].span;
        expect(next, label).not.toBeNull();
        expect(w.span.end + 1, label).toBe(next!.start);
        // Each span edge reads as this date on the zone's own clock, and the millisecond outside does not.
        expect(keyOfDate(calendarDateInTimeZone(zone, w.span.start)), `${label} start`).toBe(w.ownKey);
        expect(keyOfDate(calendarDateInTimeZone(zone, w.span.end)), `${label} end`).toBe(w.ownKey);
        expect(keyOfDate(calendarDateInTimeZone(zone, w.span.end + 1)), `${label} after`).not.toBe(w.ownKey);
      }

      // Ownership by shape. An event instant belongs to the date its clock shows; a calendar key to the
      // date it names; both are checked against the neighbouring days, the only ones that could claim them.
      const probes = w.span === null ? [] : [w.span.start, w.span.end, Math.floor((w.span.start + w.span.end) / 2)];
      for (const value of probes) {
        const owners = neighbours.filter((n) => paymentOnOrgDay(n, facts({ paymentDate: value, chequeId: "c" })) === "IN_DAY");
        expect(owners.map((n) => n.ownKey), `instant ${label} ${value}`).toEqual([w.ownKey]);
        expect(inRanges(w, value), `reach ${label} ${value}`).toBe(true);
      }

      const keyRow = facts({ paymentDate: w.ownKey, createdAt: w.ownKey - 3_600_000 });
      const keyOwners = neighbours.filter((n) => paymentOnOrgDay(n, keyRow) === "IN_DAY");
      expect(keyOwners.map((n) => n.ownKey), `key ${label}`).toEqual([w.ownKey]);
      expect(inRanges(w, w.ownKey), `key reach ${label}`).toBe(true);

      // The ambiguous refund at this date's UTC midnight: placed when both readings agree, otherwise
      // flagged on exactly the two dates they name and IN_DAY nowhere.
      const refund = facts({ paymentDate: w.ownKey, createdAt: w.ownKey, direction: "OUT", method: "REFUND" });
      const wallKey = keyOfDate(calendarDateInTimeZone(zone, w.ownKey));
      const wide = windows.slice(Math.max(0, i - 2), i + 3);
      const home = wide.filter((n) => paymentOnOrgDay(n, refund) === "IN_DAY").map((n) => n.ownKey);
      const flagged = wide.filter((n) => paymentOnOrgDay(n, refund) === "UNPLACEABLE").map((n) => n.ownKey);
      if (wallKey === w.ownKey) {
        expect(home, `refund ${label}`).toEqual([w.ownKey]);
        expect(flagged, `refund ${label}`).toEqual([]);
      } else {
        expect(home, `refund ${label}`).toEqual([]);
        expect([...flagged].sort((a, b) => a - b), `refund ${label}`).toEqual([w.ownKey, wallKey].sort((a, b) => a - b));
        for (const n of wide) {
          if (paymentOnOrgDay(n, refund) !== "NOT_IN_DAY") expect(inRanges(n, w.ownKey), `refund reach ${label}`).toBe(true);
        }
      }
    }
    if (zone === "Pacific/Apia") expect(skipped).toBe(1);
  });
});
