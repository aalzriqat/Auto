/**
 * Mobile sales wizard quote and draft helpers.
 */

/**
 * Converts a stored manual execution fee value into the text input string.
 * Preserves absence (undefined -> "") so an unconfigured manual fee is not
 * converted into an explicit zero.
 */
export function manualExecutionFeeInputValue(
  value: number | undefined
): string {
  return value === undefined ? "" : String(value);
}
