import { AppErrorCode, throwAppError } from "./errors";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "./pilotSwitches";

/**
 * SCRUM-795 (SCRUM-50): manual journals are OFF for the pilot (owner ruling
 * SCRUM-760 c22474). LEAF MODULE: imports only `./errors` and the switch.
 *
 * English text equals `ServerError_MANUAL_JOURNALS_DISABLED` in
 * lib/i18n/domains/common.ts.
 */
export const MANUAL_JOURNALS_DISABLED_MESSAGE =
  "Manual journal entries are turned off during the pilot. Nothing has been changed.";

/**
 * Refuses while the pilot switch is on. Call it after authentication and before
 * any read or write so the refusal leaves no trace.
 */
export function assertManualJournalsEnabled(): void {
  if (MANUAL_JOURNALS_PILOT_DISABLED) {
    throwAppError(AppErrorCode.MANUAL_JOURNALS_DISABLED, MANUAL_JOURNALS_DISABLED_MESSAGE);
  }
}
