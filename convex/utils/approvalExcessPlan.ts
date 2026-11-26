/**
 * SCRUM-613: the pure plan-side parts of the approval excess E (F + P above the approved value A), kept out of
 * the oversized plan builder. `approvalExcessLeg.ts` decides when a deal may carry one.
 */

/** What the excess is used for. One owner-ruled treatment (SCRUM-613 comment 25987); no option list. */
export const APPROVAL_EXCESS_TREATMENT = "DEALER_PROFIT" as const;

/** E fits the deal: whole, not negative, taken out of the held deposit H, and never beside a contribution D. */
export function approvalExcessFits(e: number, h: number, d: number): boolean {
  return Number.isSafeInteger(e) && e >= 0 && e <= h && (e === 0 || d === 0);
}

/** The plan fields that exist only when E is above zero (so every other plan is unchanged). */
export function approvalExcessFields(e: number) {
  return e > 0
    ? { approvalExcessMinor: e, excessTreatment: APPROVAL_EXCESS_TREATMENT }
    : {};
}
