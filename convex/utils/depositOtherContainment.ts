import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-801 (owner ruling, SCRUM-795 c22485): the reservation-deposit
 * treatment OTHER is refused during the narrowed pilot.
 *
 * OTHER posts nothing and leaves the customer-deposit liability on the books
 * for a manual journal (`recordUnpostedDepositTreatment`), and manual journals
 * are off for the pilot (SCRUM-795). Refund and forfeit stay available.
 *
 * LEAF MODULE (SCRUM-302): imports only `./errors`, so any convex module may
 * import it without creating a cycle.
 */

/**
 * The single switch. Callers read it AT THE CALL SITE
 * (`if (DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED) refuseDepositOtherTreatment()`),
 * never inside a helper here, so a test that mocks this export off reaches
 * every door. Flipping it to `false` is a code change reviewed on its own,
 * never an env var.
 */
export const DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED = true as const;

// English text equals `ServerError_DEPOSIT_OTHER_TREATMENT_DISABLED` in lib/i18n/domains/common.ts.
export const DEPOSIT_OTHER_TREATMENT_DISABLED_MESSAGE =
  "The 'other' deposit treatment is not available yet. Refund or forfeit the deposit instead. Nothing has been changed.";

export function refuseDepositOtherTreatment(): never {
  return throwAppError(
    AppErrorCode.DEPOSIT_OTHER_TREATMENT_DISABLED,
    DEPOSIT_OTHER_TREATMENT_DISABLED_MESSAGE
  );
}
