/**
 * SCRUM-264 - the organization's business day.
 *
 * Convex runs in UTC, so `Date#setHours` and friends describe the UTC day, not the day a dealership
 * lives in. Every Collections "today" and "business date" range is built here from the organization's
 * configured IANA time zone (`orgSettings.timezone`, default Asia/Amman).
 *
 * Two different things are called a "day" and must not be mixed:
 *  - an INSTANT range ([start, end] in epoch ms): the real 24-hour (or 23/25-hour on a daylight-saving
 *    change) span of a calendar date in the zone. Use it for event timestamps such as the clearing
 *    time of a cheque.
 *  - a CALENDAR KEY: the UTC midnight of a calendar date. This repository stores due dates, cheque
 *    dates and business dates this way (`dateInputToUtcMs` in lib/dateInput.ts), so a calendar date
 *    compares against them with no zone arithmetic at all. This is the TC39 Temporal `PlainDate`
 *    idea: a date that belongs to no zone, carried here as the UTC midnight of that date.
 *    https://tc39.es/proposal-temporal/docs/plaindate.html
 *
 * WHICH KIND A STORED VALUE IS comes from the field and the writer that stored it (for payments,
 * `paymentDateKind`), never from the shape of the number alone. `collectionPayments.paymentDate` is
 * the one field that holds both kinds; see `paymentDateProvenance` for the writer table and the rule.
 *
 * The zone arithmetic uses `Intl.DateTimeFormat` (ECMA-402), which reads the IANA tz database for each
 * instant, so it is correct across daylight-saving changes and does not assume a fixed offset. A zone
 * can also skip a whole calendar date (Pacific/Apia skipped 2011-12-30), which no instant belongs to.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
 * https://www.iana.org/time-zones
 */
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;
// The tz database has never skipped more than one calendar date in a row; the bound only keeps a
// corrupt zone from looping.
const MAX_SKIPPED_DATES_IN_A_ROW = 7;

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

function describeDate(date: CalendarDate): string {
  return `${date.year}-${date.month}-${date.day}`;
}

/**
 * The first instant of a calendar date in `timeZone`, or `undefined` when no instant of the zone
 * reads that date (the zone skipped it).
 *
 * The offset can differ before and after a daylight-saving change, so both candidates are tried and
 * the earliest one whose local clock reads that date's midnight wins. When a zone skips midnight
 * (the clock jumps from 23:xx to 01:00) no candidate reads 00:00, so the earliest instant that
 * already belongs to the date is the start. When a zone skips the whole date no candidate belongs to
 * it at all.
 */
function firstInstantOfCalendarDate(timeZone: string, date: CalendarDate): number | undefined {
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
  return candidates.find((candidate) => sameDate(wallClockOf(timeZone, candidate), date));
}

/**
 * The first instant of a calendar date that exists in `timeZone`. Throws for a date the zone skipped
 * (use `instantSpanOfCalendarDate` when the date comes from a caller).
 */
export function startOfCalendarDateInZone(timeZone: string, date: CalendarDate): number {
  const start = firstInstantOfCalendarDate(timeZone, date);
  if (start === undefined) throw new Error(`Cannot resolve the start of ${describeDate(date)} in ${timeZone}.`);
  return start;
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * The first instant of the first calendar date AFTER `date` that exists in the zone. A skipped date
 * (Pacific/Apia, 2011-12-30) has no instants, so the day before it runs up to the start of the date
 * after it.
 */
function startOfNextExistingDate(timeZone: string, date: CalendarDate): number {
  let candidate = date;
  for (let skipped = 0; skipped <= MAX_SKIPPED_DATES_IN_A_ROW; skipped += 1) {
    candidate = nextCalendarDate(candidate);
    const start = firstInstantOfCalendarDate(timeZone, candidate);
    if (start !== undefined) return start;
  }
  throw new Error(`Cannot resolve the date after ${describeDate(date)} in ${timeZone}.`);
}

/**
 * [first instant, last millisecond] of a calendar date in `timeZone`, or `null` when the zone skipped
 * that date and no instant belongs to it. Consecutive existing dates tile the timeline: the end of one
 * is one millisecond before the start of the next existing one.
 */
export function instantSpanOfCalendarDate(timeZone: string, date: CalendarDate): InstantRange | null {
  const start = firstInstantOfCalendarDate(timeZone, date);
  if (start === undefined) return null;
  return { start, end: startOfNextExistingDate(timeZone, date) - 1 };
}

/** [first instant, last millisecond] of a calendar date in `timeZone` - for event timestamps. Throws for a skipped date. */
export function instantRangeOfCalendarDate(timeZone: string, date: CalendarDate): InstantRange {
  const span = instantSpanOfCalendarDate(timeZone, date);
  if (span === null) throw new Error(`Cannot resolve the start of ${describeDate(date)} in ${timeZone}.`);
  return span;
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

/** True when `value` is exactly 00:00:00.000 UTC. A calendar key always is; nothing else can be one. */
export function isUtcMidnight(value: number): boolean {
  return Number.isInteger(value) && value % DAY_MS === 0;
}

/**
 * WHICH KIND OF DATE `collectionPayments.paymentDate` HOLDS.
 *
 * A calendar date and an instant are different concepts (TC39 Temporal `PlainDate` vs `Instant`,
 * https://tc39.es/proposal-temporal/docs/plaindate.html), and a stored number does not say which one it
 * is. Timestamp equality in particular proves nothing: the Record Payment form stores the picked date's
 * key in `paymentDate` and `Date.now()` in `createdAt`, and the two are equal whenever the write clock
 * is exactly that UTC midnight (Seat 2, PR #741 round 3). So the WRITER records the answer in
 * `paymentDateKind`, and this function trusts it over every heuristic.
 *
 * Writers (every `insert("collectionPayments"` outside tests, checked 2026-11-01), each setting
 * `paymentDateKind` explicitly; `convex/paymentDateKindWriters.scrum264.test.ts` fails if one does not:
 *
 *  | writer                                     | paymentDate               | paymentDateKind |
 *  | collections.ts recordPayment               | args.paymentDate          | "calendarKey" when it is a UTC midnight (both UIs send `dateInputToUtcMs`), "instant" for any other integer an API caller sends |
 *  | collections.ts clearCheque                 | clearedAt ?? Date.now()   | "instant" (and the only writer that sets `chequeId`) |
 *  | collections.ts refund approval             | Date.now()                | "instant" |
 *  | paymentIntents.ts settlement               | occurredAt (Date.now())   | "instant" |
 *  | utils/depositRecording.ts                  | Date.now()                | "instant" |
 *  | utils/depositHelpers.ts payOutDepositSlice | occurredAt (deposits.ts passes Date.now()) | "instant" |
 *  | utils/depositHelpers.ts releaseHeldDeposit | occurredAt ?? Date.now()  | "instant" from deposits.ts (no occurredAt); "saleDate" from utils/saleCompletion.ts (`occurredAt: saleDate`), a UTC midnight key from SaleDialog and an instant from sales.ts completeFromQuote |
 *
 * ROWS WITHOUT THE FIELD (written before it existed; no backfill, see below) fall back to the row's own
 * footprint, and the footprint cannot always decide:
 *  1. `chequeId` set               -> EVENT_INSTANT (clearCheque).
 *  2. not a UTC midnight           -> EVENT_INSTANT (a calendar key is always a UTC midnight, so a
 *                                     value that is not one cannot be a key).
 *  3. UTC midnight, createdAt differs -> CALENDAR_KEY. The form stamps createdAt with the write time,
 *                                     which is not the picked date's midnight.
 *  4. UTC midnight, createdAt equal   -> KEY_OR_INSTANT, for every direction and method. A system writer
 *                                     stores one clock reading in both fields, but so does the form when
 *                                     its write lands on that midnight. Nothing stored tells them apart.
 *
 * KEY_OR_INSTANT has no truthful single answer when the key's date and the instant's date differ (a
 * zone west of UTC); `paymentOnOrgDay` reports it UNPLACEABLE then, so a report says it is incomplete
 * and a reconciliation refuses (`DATE_UNCERTAIN`) instead of filing the payment under a day it may not
 * belong to. East of UTC both readings name the same date and it is filed there (Bloom, Asia/Amman).
 *
 * Schema evolution: `paymentDateKind` is optional, which Convex accepts for existing documents without
 * a migration (https://docs.convex.dev/database/schemas). It needs no backfill for the pilot: a
 * historical row that rule 4 cannot place is the rare collision case (about 1 write in 86.4 million),
 * and it is reported, never guessed.
 */
export type PaymentDateProvenance = "CALENDAR_KEY" | "EVENT_INSTANT" | "KEY_OR_INSTANT";

/** What the writer recorded `paymentDate` to be (`collectionPayments.paymentDateKind`). */
export type PaymentDateKind = "calendarKey" | "instant" | "saleDate";

export interface PaymentDateFacts {
  paymentDate: number;
  createdAt: number;
  direction: "IN" | "OUT";
  method: string;
  chequeId?: unknown;
  /** Absent on rows written before the field existed. */
  paymentDateKind?: PaymentDateKind;
}

/**
 * The `paymentDateKind` a writer should store for a value it was given as a calendar date: a key only
 * when it is a UTC midnight, otherwise the instant it can only be.
 */
export function paymentDateKindOfCalendarInput(paymentDate: number): PaymentDateKind {
  return isUtcMidnight(paymentDate) ? "calendarKey" : "instant";
}

export function paymentDateProvenance(row: PaymentDateFacts): PaymentDateProvenance {
  switch (row.paymentDateKind) {
    case "calendarKey":
      // A key is always a UTC midnight; one that is not cannot be a key, so it is read as the instant it is.
      return isUtcMidnight(row.paymentDate) ? "CALENDAR_KEY" : "EVENT_INSTANT";
    case "instant":
      return "EVENT_INSTANT";
    case "saleDate":
      return isUtcMidnight(row.paymentDate) ? "KEY_OR_INSTANT" : "EVENT_INSTANT";
    case undefined:
      break;
  }
  if (row.chequeId !== undefined) return "EVENT_INSTANT";
  if (!isUtcMidnight(row.paymentDate)) return "EVENT_INSTANT";
  if (row.createdAt !== row.paymentDate) return "CALENDAR_KEY";
  return "KEY_OR_INSTANT";
}
/**
 * Everything needed to decide, for one organization date, which `collectionPayments` rows are on it.
 *  - `ranges` are the inclusive `paymentDate` index ranges to read: the zone's real span of the date
 *    (instants) and the date's own calendar key (a key is a date label, wherever its UTC midnight falls
 *    relative to the span; for a date the zone skipped there is only the key). Sorted and disjoint.
 *  - `span` is that real span, `null` for a skipped date.
 */
export interface OrgDayWindow {
  date: CalendarDate;
  ownKey: number;
  span: InstantRange | null;
  ranges: InstantRange[];
}

export function orgDayWindow(timeZone: string, date: CalendarDate): OrgDayWindow {
  const ownKey = Date.UTC(date.year, date.month - 1, date.day);
  const span = instantSpanOfCalendarDate(timeZone, date);
  const key: InstantRange = { start: ownKey, end: ownKey };
  let ranges: InstantRange[];
  if (span === null) ranges = [key];
  else if (ownKey >= span.start && ownKey <= span.end) ranges = [span];
  else if (ownKey < span.start) ranges = ownKey + 1 === span.start ? [{ start: ownKey, end: span.end }] : [key, span];
  else ranges = ownKey - 1 === span.end ? [{ start: span.start, end: ownKey }] : [span, key];
  return { date, ownKey, span, ranges };
}

/** The `paymentDate` index ranges of one organization day (see `OrgDayWindow`). */
export function orgDayPaymentDateRanges(timeZone: string, date: CalendarDate): InstantRange[] {
  return orgDayWindow(timeZone, date).ranges;
}

/**
 * IN_DAY       the payment is on this organization date
 * NOT_IN_DAY   it is on another date
 * UNPLACEABLE  stored facts cannot say whether it is on this date or another one (KEY_OR_INSTANT whose
 *              two readings differ); the caller leaves it out and reports the figure as incomplete
 *
 * Defined by membership - an instant belongs to the span that contains it, a key to the date it names -
 * so across consecutive dates every row has exactly one owner, or is UNPLACEABLE on exactly the two
 * dates its readings name.
 */
export type PaymentDayVerdict = "IN_DAY" | "NOT_IN_DAY" | "UNPLACEABLE";

export function paymentOnOrgDay(window: OrgDayWindow, row: PaymentDateFacts): PaymentDayVerdict {
  const inSpan = window.span !== null && row.paymentDate >= window.span.start && row.paymentDate <= window.span.end;
  const isOwnKey = row.paymentDate === window.ownKey;
  switch (paymentDateProvenance(row)) {
    case "EVENT_INSTANT":
      return inSpan ? "IN_DAY" : "NOT_IN_DAY";
    case "CALENDAR_KEY":
      return isOwnKey ? "IN_DAY" : "NOT_IN_DAY";
    case "KEY_OR_INSTANT":
      if (inSpan && isOwnKey) return "IN_DAY";
      return inSpan || isOwnKey ? "UNPLACEABLE" : "NOT_IN_DAY";
  }
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
