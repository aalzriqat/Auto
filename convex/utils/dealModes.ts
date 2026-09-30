import { ConvexError } from "convex/values";

/**
 * SCRUM-495 (owner rulings OR-6 / OR-7).
 *
 * The dealership never self-finances, so INTERNAL_INSTALLMENT is not a business
 * it operates, and LEASE was removed. The schema unions and every reader keep
 * both values, so a historical row still renders and settles exactly as it did;
 * what is refused is a NEW quote, application or sale entering either mode.
 *
 * ONE set and ONE message, shared by every write door, so the doors cannot
 * drift into refusing different populations or describing the refusal
 * differently. The sentence is written for a person: the mobile clients show a
 * generic message for a refused save, and the web toast shows this one.
 */
export const RETIRED_DEAL_MODES = ["LEASE", "INTERNAL_INSTALLMENT"] as const;

export type RetiredDealMode = (typeof RETIRED_DEAL_MODES)[number];

export const RETIRED_DEAL_MODE_MESSAGE =
  "Lease and in-house instalment deals are no longer offered. Choose cash or a finance company.";

/** True when `mode` names a deal mode the dealership no longer operates. Absent modes are not retired. */
export function isRetiredDealMode(mode: string | null | undefined): mode is RetiredDealMode {
  return mode != null && (RETIRED_DEAL_MODES as readonly string[]).includes(mode);
}

/**
 * Refuses a retired mode with the shared message. Call it BEFORE the door's
 * first write. Never call it on a path that exits a legacy row (cancel, reject):
 * a legacy deal must always be able to leave.
 */
export function assertOperatedDealMode(mode: string | null | undefined): void {
  if (isRetiredDealMode(mode)) throw new ConvexError(RETIRED_DEAL_MODE_MESSAGE);
}
