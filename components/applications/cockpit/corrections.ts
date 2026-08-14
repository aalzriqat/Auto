import { isValid } from "date-fns";

import type { CorrectionEntry, CorrectionEvent, CorrectionSubject } from "./CorrectionHistoryCard";

/**
 * Whether a stored moment can be handed to a date formatter at all.
 *
 * `Number.isFinite` is not enough: the renderable range ends around ±8.64e15,
 * and `1e300` and `Number.MAX_VALUE` are all finite yet outside it — date-fns
 * `format` throws `RangeError: Invalid time value` on every one of them. An
 * uncaught throw during render loses the WHOLE screen, not one row, which is the
 * defect class this cockpit has already been repaired for twice.
 *
 * Those values are reachable rather than theoretical: `z.number()` accepts any
 * finite number and Convex's `v.number()` stores it verbatim, so a corrupt row
 * arrives intact. SCRUM-45 tracks the same class in the posting path, where the
 * consequence is an aborted accounting drain rather than a lost screen.
 *
 * `isValid(new Date(v))` subsumes `undefined`, `NaN`, `±Infinity` and the
 * out-of-range case in one test. The `typeof` narrowing is load-bearing, not
 * decorative: neither `isValid` nor `Number.isFinite` is a type predicate, so
 * without it `format(entry.changedAt)` is a compile error on `number | undefined`.
 */
export function isRenderableMoment(value: number | undefined): value is number {
  return typeof value === "number" && isValid(new Date(value));
}

/**
 * One entry of `getEconomics().overrides`, exactly as the server returns it.
 *
 * Stated here so the mapping below can be exercised against real query output
 * rather than against a shape invented for a test. The previous history tests
 * hand-built the rows they rendered, and one of them built a row the server did
 * not emit at all — it asserted that a corrected deal read 150,000 → off the
 * record → 15,000 while the writer recorded no replacement event, so the test
 * passed on a screen that could not exist.
 */
export type ServerCorrection = {
  _id: string;
  subject: CorrectionSubject;
  event: CorrectionEvent;
  previousAmountMinor?: number;
  newAmountMinor?: number;
  reason: string;
  changedByName?: string;
  changedAt: number;
};

/**
 * The server's audit projection, ready for the card.
 *
 * Extracted from the cockpit so the path from a real `getEconomics` response to
 * what an operator reads is one function that a test can drive end to end. It
 * decides nothing: the subject, the event and the figures are all named by the
 * server, and the only judgement here is refusing to format a moment that would
 * throw.
 */
export function toCorrectionEntries(
  rows: ReadonlyArray<ServerCorrection>,
  formatMoment: (value: number) => string
): CorrectionEntry[] {
  return rows.map((row) => ({
    id: row._id,
    subject: row.subject,
    event: row.event,
    previousAmountMinor: row.previousAmountMinor,
    newAmountMinor: row.newAmountMinor,
    reason: row.reason,
    changedByName: row.changedByName,
    changedAtLabel: isRenderableMoment(row.changedAt) ? formatMoment(row.changedAt) : undefined,
  }));
}
