import { ConvexError } from "convex/values";
import { AppErrorCode, throwAppError } from "./errors";

export const OPENING_MAINTENANCE_MESSAGES = {
  OPENING_CHANGE_STATE: "This opening is no longer in the required state. Refresh and try again.",
  OPENING_CHANGE_PREPARER: "Only the preparer can edit this pending opening balance.",
  OPENING_CHANGE_SECOND_PERSON: "The opening void approver must be different from the requester.",
  OPENING_VOID_REASON: "Enter a reason of up to 500 characters for the opening void.",
  OPENING_VOID_ACTIVITY: "Operations have started. This opening needs a reviewed correction and cannot be voided.",
  OPENING_VOID_CONFLICT: "This opening has changed or has dependent records. Ask finance to review a correction.",
  OPENING_VOID_PERIOD: "The original opening period must still be open before the opening can be voided.",
  OPENING_CHANGE_UNAVAILABLE: "The opening change could not be completed. Please try again later.",
} as const;

export function refuseOpeningChange(code: keyof typeof OPENING_MAINTENANCE_MESSAGES): never {
  throwAppError(AppErrorCode[code], OPENING_MAINTENANCE_MESSAGES[code]);
}

/** Never return a caught write failure: rethrow so Convex rolls back the entire
 * mutation. Technical details remain on the server. Domain refusals stay coded. */
export async function openingChangeBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error("Opening balance change failed", error);
    refuseOpeningChange("OPENING_CHANGE_UNAVAILABLE");
  }
}
