import { isRequestedFinancingTermValid } from "@autoflow/shared/financing";

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

/** Returns the exact sale price that the backend must price for a quote. */
export function effectiveMobileQuoteVehiclePrice(
  vehiclePrice: number,
  desiredProfit: number
): number {
  return vehiclePrice + desiredProfit;
}

/**
 * Mirrors the backend financing-term authority before the mobile wizard allows
 * a financed quote to advance or submit.
 */
export function mobileFinancingTermIsValid({
  termMonths,
  gracePeriodMonths = 0,
  maxTermMonths,
}: {
  termMonths: number;
  gracePeriodMonths?: number;
  maxTermMonths?: number;
}): boolean {
  return isRequestedFinancingTermValid({
    termMonths,
    gracePeriodMonths,
    maxTermMonths,
  });
}
