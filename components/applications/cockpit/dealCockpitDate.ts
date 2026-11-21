import { isValid } from "date-fns";
import { formatLocalized } from "@/lib/dateLocale";

/**
 * Whether a stored moment can actually be formatted.
 *
 * `Number.isFinite` is NOT sufficient, which cost two review rounds to learn.
 * JavaScript's `Date` domain is ±8,640,000,000,000,000 ms, so `8640000000000001`,
 * `1e300` and `Number.MAX_VALUE` are all finite yet outside it — and date-fns
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
 * A stored moment as display text, or a calm dash when it cannot be one.
 *
 * The header's "last updated" and the essentials' "opened on" went straight to
 * `format()`, so the same `NaN` / `Infinity` / out-of-range row that the
 * timeline was already guarded against would still have lost the whole screen
 * through either of them. One helper for both, so neither can drift back.
 * The dash is language-neutral on purpose: it is the absence of a date, not a
 * status the operator has to act on, and the row it sits in is still readable.
 */
const MOMENT_UNAVAILABLE = "—";

export function renderMoment(value: number | undefined, pattern: string, locale?: string): string {
  return isRenderableMoment(value) ? formatLocalized(value, pattern, locale) : MOMENT_UNAVAILABLE;
}
