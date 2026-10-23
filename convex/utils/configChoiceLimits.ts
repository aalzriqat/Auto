// Convex supports arrays of at most 8192 entries. Read one extra row so an
// oversized configuration fails explicitly instead of silently losing choices.
// This read budget includes inactive rows; it is not a new settings write quota.
export const CONFIG_CHOICE_MAX_ROWS = 8192;
import { throwAppError } from "./errors";


export function assertConfigChoiceReadBudget(count: number): void {
  if (count > CONFIG_CHOICE_MAX_ROWS) {
    throwAppError("CONFIG_CHOICE_LIMIT", "Too many configured choices. Ask the owner to review these settings.");
  }
}
