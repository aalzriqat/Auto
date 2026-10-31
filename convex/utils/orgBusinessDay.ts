/**
 * SCRUM-264 - the organization's business day.
 *
 * Convex runs in UTC, so `Date#setHours` and friends describe the UTC day, not the day a dealership
 * lives in. Every Collections "today" and "business date" range is built here from the organization's
 * configured IANA time zone (`orgSettings.timezone`, default Asia/Amman).
 *
 * Two different things are called a "day" and must not be mixed:
 *  - an INSTANT range ([start, end] in epoch ms): the real 24-hour (or 23/25-hour on a daylight-saving
 *    change) span of a calendar date in the zone. Use it for event timestamps such as `paymentDate`.
 *  - a CALENDAR KEY: the UTC midnight of a calendar date. This repository stores due dates, cheque
 *    dates and business dates this way (`dateInputToUtcMs` in lib/dateInput.ts), so a calendar date
 *    compares against them with no zone arithmetic at all.
 *
 * The zone arithmetic uses `Intl.DateTimeFormat` (ECMA-402), which reads the IANA tz database for each
 * instant, so it is correct across daylight-saving changes and does not assume a fixed offset.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
 * https://www.iana.org/time-zones
 */
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;

// Asia/Amman - this platform's primary/founding market - is the business time zone when an
// organization has not configured `orgSettings.timezone`.
export const DEFAULT_ORG_TIMEZONE = "Asia/Amman";

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface InstantRange {
  start: number;
  end: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when the runtime's tz database knows `timeZone`. */
function isKnownTimeZone(timeZone: string): boolean {
  try {
    wallClockFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone to use for an organization. A missing or unreadable saved value falls back to the default
 * rather than failing every Collections report for that organization.
 */
export function resolveOrgTimeZone(saved: string | undefined | null): string {
  const trimmed = saved?.trim();
  if (trimmed && isKnownTimeZone(trimmed)) return trimmed;
  return DEFAULT_ORG_TIMEZONE;
}

/** Reads `orgSettings.timezone` for the organization, resolved through `resolveOrgTimeZone`. */
export async function getOrgTimeZone(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return resolveOrgTimeZone(settings?.timezone);
}

interface WallClock extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

function wallClockOf(timeZone: string, at: number): WallClock {
  const lookup: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(new Date(at))) {
    if (part.type !== "literal") lookup[part.type] = Number(part.value);
  }
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
  };
}

/** The wall-clock calendar date of an instant in `timeZone`. */
export function calendarDateInTimeZone(timeZone: string, at: number): CalendarDate {
  const { year, month, day } = wallClockOf(timeZone, at);
  return { year, month, day };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetAt(timeZone: string, at: number): number {
  const w = wallClockOf(timeZone, at);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(at / 1000) * 1000;
}

function sameDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * The first instant of a calendar date in `timeZone`.
 *
 * The offset can differ before and after a daylight-saving change, so both candidates are tried and
 * the earliest one whose local clock reads that date's midnight wins. When a zone skips midnight
 * (the clock jumps from 23:xx to 01:00) no candidate reads 00:00, so the earliest instant that
 * already belongs to the date is the start.
 */
export function startOfCalendarDateInZone(timeZone: string, date: CalendarDate): number {
  const wallMidnight = Date.UTC(date.year, date.month - 1, date.day);
  const offsets = new Set([
    offsetAt(timeZone, wallMidnight - DAY_MS),
    offsetAt(timeZone, wallMidnight + DAY_MS),
  ]);
  const candidates = [...offsets].map((offset) => wallMidnight - offset).sort((a, b) => a - b);
  const exact = candidates.find((candidate) => {
    const w = wallClockOf(timeZone, candidate);
    return sameDate(w, date) && w.hour === 0 && w.minute === 0 && w.second === 0;
  });
  if (exact !== undefined) return exact;
  const onDate = candidates.find((candidate) => sameDate(wallClockOf(timeZone, candidate), date));
  // Unreachable for real tz data; fail loudly rather than return a day that is off by an offset.
  if (onDate === undefined) throw new Error(`Cannot resolve the start of ${date.year}-${date.month}-${date.day} in ${timeZone}.`);
  return onDate;
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** [first instant, last millisecond] of a calendar date in `timeZone` - for event timestamps. */
export function instantRangeOfCalendarDate(timeZone: string, date: CalendarDate): InstantRange {
  const start = startOfCalendarDateInZone(timeZone, date);
  const nextStart = startOfCalendarDateInZone(timeZone, nextCalendarDate(date));
  return { start, end: nextStart - 1 };
}

/** The org's business day that contains `at`, as an instant range. */
export function orgDayInstantRange(timeZone: string, at: number): InstantRange {
  return instantRangeOfCalendarDate(timeZone, calendarDateInTimeZone(timeZone, at));
}

/** The calendar key (UTC midnight) range of the org's business date that contains `at` - for due dates. */
export function orgDayCalendarKeyRange(timeZone: string, at: number): InstantRange {
  const { year, month, day } = calendarDateInTimeZone(timeZone, at);
  const start = Date.UTC(year, month - 1, day);
  return { start, end: start + DAY_MS - 1 };
}

/**
 * True when a stored date has the shape of a calendar key (an exact UTC midnight).
 *
 * `collectionPayments.paymentDate` is written in both forms: the Record Payment form stores the picked
 * date as a calendar key, while refunds, cheque clearing and payment links store the instant they
 * happened. The two cannot be told apart by a marker (the row has none), so the shape decides: a value
 * that is an exact UTC midnight is read as the calendar date it names. An instant that lands on
 * 00:00:00.000Z to the millisecond (about 1 in 86 million) is therefore filed under that UTC date.
 */
export function isCalendarKey(value: number): boolean {
  return Number.isInteger(value) && value % DAY_MS === 0;
}

/**
 * The inclusive `paymentDate` index ranges whose union is exactly the rows of one organization day:
 *  - every INSTANT inside the zone's real span of the date, except those shaped like another date's
 *    calendar key, and
 *  - the date's own CALENDAR KEY, wherever it falls relative to that span.
 * East of UTC the key sits inside the span; west of UTC it sits before it, and the span contains the
 * NEXT date's key instead, which is why the span is split around foreign keys. The ranges are sorted
 * and disjoint, and across consecutive dates every `paymentDate` falls in exactly one day.
 * https://tc39.es/proposal-temporal/docs/plaindate.html (a calendar date is independent of any zone)
 */
export function orgDayPaymentDateRanges(timeZone: string, date: CalendarDate): InstantRange[] {
  const ownKey = Date.UTC(date.year, date.month - 1, date.day);
  const span = instantRangeOfCalendarDate(timeZone, date);
  const ranges: InstantRange[] = [];
  let cursor = span.start;
  for (let midnight = Math.ceil(span.start / DAY_MS) * DAY_MS; midnight <= span.end; midnight += DAY_MS) {
    if (midnight === ownKey) continue;
    if (cursor <= midnight - 1) ranges.push({ start: cursor, end: midnight - 1 });
    cursor = midnight + 1;
  }
  if (cursor <= span.end) ranges.push({ start: cursor, end: span.end });
  if (ownKey < span.start || ownKey > span.end) ranges.push({ start: ownKey, end: ownKey });
  return ranges.sort((a, b) => a.start - b.start);
}

/** The calendar date a client-sent business-date key (a UTC midnight) names. */
export function calendarDateOfKey(key: number): CalendarDate {
  const d = new Date(key);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Normalises a client-sent business date to its calendar key (UTC midnight of that calendar date). */
export function calendarKeyOf(key: number): number {
  const { year, month, day } = calendarDateOfKey(key);
  return Date.UTC(year, month - 1, day);
}
