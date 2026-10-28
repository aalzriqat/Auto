import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-760 (owner ruling 11, c23812): the legacy COLLECTION REFUND door is not one
 * of the pilot's required routes, so it is blocked SERVER-SIDE.
 *
 * Required pilot routes: completed-sale cancel, closed-deal cancel, deal unwind,
 * `vehicles.correctAcquisitionCost`, restoring an unwound deposit to HELD, and the
 * held-deposit refund and forfeit. A refund recorded against a collection
 * receivable (`collections.requestApproval` / `respondToApproval` with request type
 * REFUND) is none of them, and it is uncertified money movement: on approval it
 * pays out, reverses receipt allocations, reopens the receivable and posts a
 * COLLECTION_REFUND journal. Hiding the button is not a block; the doors below are.
 *
 * Gated doors, both before any write:
 *   - `collections.requestApproval` with requestType REFUND: no new request.
 *   - `collections.respondToApproval` APPROVED on a REFUND request, including a
 *     request created before the switch and a stored idempotent replay: not payable.
 * NOT gated: REJECTING a REFUND request (a cleanup exit that spends nothing), and
 * the RESCHEDULE and CANCEL_RECEIVABLE request types.
 *
 * This is separate from `customerCreditPayoutContainment.ts` (the new 2110
 * retained-credit payout and the sale-invoice receipt doors) and from
 * `postDeliveryDoorContainment.ts` (the cleared-cheque return). Its comment there
 * ("keep the existing collection refund-recording paths", SCRUM-795 c22479)
 * predates ruling 11, which narrows the pilot to the routes listed above.
 *
 * To re-enable (post-pilot; needs the lifecycle certification and a separate owner
 * approval, a reviewed code change plus a manual Convex deploy, never an env var):
 * set the switch to `false`, then convert the expected-refusal cells in
 * `convex/legacyCollectionRefundContainment.test.ts` into full-behaviour cells and
 * remove the opt-out mocks of this module from the suites that carry them (the
 * census in that test file lists them) in the same change.
 *
 * LEAF MODULE: imports only `./errors`.
 */
export const LEGACY_COLLECTION_REFUND_PILOT_DISABLED = true as const;

/** Static text, no amounts or ids. Arabic lives under `ServerError_<code>` in `lib/i18n/domains/common.ts`. */
export const LEGACY_COLLECTION_REFUND_REFUSALS = {
  LEGACY_COLLECTION_REFUND_PILOT_DISABLED:
    "Recording a refund against a collection receivable is not available during the pilot. You can still reject a pending refund request. Nothing has been changed.",
} as const satisfies Record<string, string>;

export type LegacyCollectionRefundRefusalCode = keyof typeof LEGACY_COLLECTION_REFUND_REFUSALS;

export function refuseLegacyCollectionRefund(code: LegacyCollectionRefundRefusalCode): never {
  return throwAppError(AppErrorCode[code], LEGACY_COLLECTION_REFUND_REFUSALS[code]);
}

/** Refuses a collection REFUND request or approval. Call BEFORE any write. `disabled` is for tests of the pure guard only. */
export function assertLegacyCollectionRefundAllowed(
  disabled: boolean = LEGACY_COLLECTION_REFUND_PILOT_DISABLED
): void {
  if (disabled) refuseLegacyCollectionRefund("LEGACY_COLLECTION_REFUND_PILOT_DISABLED");
}

/**
 * Read-only form of the switch, for the screen that disables a blocked action. The server refusal
 * stays the guarantee; hiding is only so a user is not offered a button that always fails.
 */
export function isLegacyCollectionRefundDisabled(
  disabled: boolean = LEGACY_COLLECTION_REFUND_PILOT_DISABLED
): boolean {
  return disabled;
}
