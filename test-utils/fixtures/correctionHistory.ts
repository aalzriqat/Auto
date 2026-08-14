/**
 * The correction sequence the server actually produces, shared by the test that
 * proves it and the test that renders it.
 *
 * It exists because a history test can otherwise prove nothing. The first
 * version of the cockpit's history tests hand-built the rows they rendered, and
 * one of them asserted that a corrected deal reads 150,000 → off the record →
 * 15,000 while the writer recorded no replacement event at all. The row was
 * invented, the assertion passed, and the screen it described could not exist.
 *
 * So this array is written ONCE and used twice:
 *
 *   • `convex/financingEconomics.test.ts` drives the real mutations through the
 *     real `getEconomics` and asserts the projection equals it — if the writers
 *     or the projection change, this file is wrong and that test says so;
 *   • the cockpit history tests render it through `toCorrectionEntries`, the
 *     same adapter the screen uses.
 *
 * Neither side can drift without the other failing. `_id` and `changedAt` are
 * the only invented values — one is a database id and the other a wall clock,
 * and the pinning comparison drops both.
 */

/** Kept structural rather than imported: this file is compiled by the Convex
 * tsconfig too, which cannot resolve the app's `@/` component paths. The
 * component test asserts assignability to `ServerCorrection` at the call site,
 * so a divergence is still a compile error where it matters. */
export type PinnedCorrection = {
  _id: string;
  subject: "APPROVED_PURCHASE_AMOUNT" | "SUBMITTED_QUOTATION" | "RECONCILIATION_FLAG";
  event: "CORRECTED" | "WITHDRAWN" | "SUPERSEDED" | "RESOLVED";
  previousAmountMinor?: number;
  newAmountMinor?: number;
  reason: string;
  changedByName?: string;
  changedAt: number;
};

/** JOD is a three-decimal currency: 15,000 JOD is 15,000,000 minor units. */
const JOD = 1_000;

/**
 * 150,000 recorded by mistake against a ~12,500 deal, taken off the record, and
 * 15,000 put back. Newest first, exactly as the query orders them.
 *
 * The replacement carries NO previous figure: by the time it is recorded the
 * withdrawal has already said what left, and the deal held nothing to move from.
 */
export const CORRECTED_APPROVAL_SEQUENCE: PinnedCorrection[] = [
  {
    _id: "ov_replacement",
    subject: "APPROVED_PURCHASE_AMOUNT",
    event: "CORRECTED",
    newAmountMinor: 15_000 * JOD,
    reason: "Recorded the amount the company actually approved.",
    changedByName: "Econ Approver",
    changedAt: 1_755_000_060_000,
  },
  {
    _id: "ov_withdrawal",
    subject: "APPROVED_PURCHASE_AMOUNT",
    event: "WITHDRAWN",
    previousAmountMinor: 150_000 * JOD,
    reason: "The amount entered was wrong.",
    changedByName: "Econ Approver",
    changedAt: 1_755_000_000_000,
  },
];

/**
 * A correction to the DEALER-BORNE EXPENSES behind a quotation.
 *
 * The quotation writer serializes the quotation amount together with every other
 * input that moved, so this row stores the SAME leading integer on both sides.
 * The projection this pins reports it as the quotation, with no movement at all
 * — rather than as an unlabelled 12,500 → 12,500, which is what reading that
 * integer produced: a figure that did not change, shown beside approved purchase
 * amounts that had.
 */
export const EXPENSE_ONLY_QUOTATION_CORRECTION: PinnedCorrection[] = [
  {
    _id: "ov_quotation",
    subject: "SUBMITTED_QUOTATION",
    event: "CORRECTED",
    reason: "Registration came in higher than estimated.",
    changedByName: "Econ User",
    changedAt: 1_755_000_120_000,
  },
];

/** The fields a database assigns, dropped before comparing environments. */
export function withoutRuntimeIdentity(
  row: PinnedCorrection | (Omit<PinnedCorrection, "_id"> & { _id: unknown })
): Omit<PinnedCorrection, "_id" | "changedAt"> {
  const { _id: _ignoredId, changedAt: _ignoredAt, ...rest } = row;
  return rest;
}
