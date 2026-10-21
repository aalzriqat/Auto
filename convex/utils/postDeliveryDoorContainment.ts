import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-760 decision B (owner ruling, 2026-10-19), door-census gap 3: the narrow
 * pilot covers CASH and FINANCED deals THROUGH DELIVERY. The one post-delivery
 * door that stays blocked is `collections.returnClearedCheque` (a cheque that
 * bounced AFTER it cleared reverses a posted clearing entry; no certified path
 * covers it) -> CLEARED_CHEQUE_RETURN.
 *
 * Deal unwind, the acquisition-cost correction and cancellation of a completed
 * sale or a closed deal are NOT blocked: the owner ruled them part of the pilot.
 *
 * This file is deliberately separate from `customerCreditPayoutContainment.ts`,
 * whose two switches (customer-credit payout, sale-invoice receipt doors) are
 * unchanged.
 *
 * To re-enable the door (a reviewed code change plus a manual Convex deploy,
 * never an env var; needs the post-pilot certification and a separate owner
 * approval): set the switch to `false`, then convert the expected-refusal cell
 * in `convex/postDeliveryDoorContainment.test.ts` and rehearsal case RV1 into
 * full-behaviour cells in the same change.
 *
 * The door calls `assertClearedChequeReturnAllowed` immediately after tenant
 * authorization, before any write and before the idempotency wrapper, so a
 * stored replay is refused too.
 *
 * LEAF MODULE: imports only `./errors`.
 */
export const CLEARED_CHEQUE_RETURN_PILOT_DISABLED = true as const;

/** Static text, no amounts or ids. Arabic lives under `ServerError_<code>` in `lib/i18n/domains/common.ts`. */
export const POST_DELIVERY_DOOR_REFUSALS = {
  CLEARED_CHEQUE_RETURN_PILOT_DISABLED:
    "Returning a cheque that has already cleared is not available during the pilot. Nothing has been changed.",
} as const satisfies Record<string, string>;

export type PostDeliveryDoorRefusalCode = keyof typeof POST_DELIVERY_DOOR_REFUSALS;

export function refusePostDeliveryDoor(code: PostDeliveryDoorRefusalCode): never {
  return throwAppError(AppErrorCode[code], POST_DELIVERY_DOOR_REFUSALS[code]);
}

/** Refuses the bounced-after-clearing cheque return. `disabled` is for tests of the pure guard only. */
export function assertClearedChequeReturnAllowed(
  disabled: boolean = CLEARED_CHEQUE_RETURN_PILOT_DISABLED
): void {
  if (disabled) refusePostDeliveryDoor("CLEARED_CHEQUE_RETURN_PILOT_DISABLED");
}

/**
 * Read-only form of the switch, for the screen that disables a blocked action. The server refusal
 * stays the guarantee; hiding is only so a user is not offered a button that always fails.
 */
export function isClearedChequeReturnDisabled(disabled: boolean = CLEARED_CHEQUE_RETURN_PILOT_DISABLED): boolean {
  return disabled;
}
