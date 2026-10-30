import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-858 S2 (owner ruling SCRUM-858 c23884): a consigned (SOURCED) vehicle belongs to its supplier until it
 * sells, so it is never recognised as owned opening inventory and never carries an opening cost. The opening
 * inventory control is the sum of cost over OWNED vehicles only, one allocation per VIN.
 *
 * This is a server-side refusal on the opening allocation row, not a UI affordance: a hand-built row naming a
 * SOURCED vehicle is refused before anything is written, in both the draft and the direct-post doors.
 *
 * LEAF MODULE (SCRUM-302): imports only `./errors`, so any convex module may import it without a cycle.
 */

// English text equals `ServerError_OPENING_INVENTORY_SOURCED_REFUSED` in lib/i18n/domains/common.ts.
export const OPENING_INVENTORY_SOURCED_REFUSED_MESSAGE =
  "This vehicle is held on consignment, so it cannot be opened as owned inventory. Open only cars the dealership owns. Nothing has been changed.";

export function refuseSourcedOpeningInventory(): never {
  return throwAppError(AppErrorCode.OPENING_INVENTORY_SOURCED_REFUSED, OPENING_INVENTORY_SOURCED_REFUSED_MESSAGE);
}
