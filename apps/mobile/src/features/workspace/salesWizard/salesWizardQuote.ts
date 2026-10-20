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
 * The figure the backend compares with the vehicle's Minimum Price Uplift
 * (convex/utils/profitApproval.ts): the final sale price minus the list price.
 * It is NOT the "markup added to base price" input, because the base price is
 * editable and need not equal the list price. Rounded so float noise cannot
 * flip a comparison.
 */
export function priceUpliftOverList(
  vehiclePrice: number,
  desiredProfit: number,
  listPrice: number
): number {
  return Math.round((effectiveMobileQuoteVehiclePrice(vehiclePrice, desiredProfit) - listPrice) * 1000) / 1000;
}

/** The backend rule: approval is required when the minimum is above 0 and the uplift is below it. */
export function priceUpliftNeedsApproval(uplift: number, minimumUplift: number): boolean {
  return minimumUplift > 0 && uplift < minimumUplift;
}

export type MobileApprovalRequest = {
  status: "PENDING" | "APPROVED" | "REJECTED";
  /** What the server stored: final price minus list price when it was requested. */
  requestedProfit: number;
  minimumProfit?: number;
};

/**
 * The server honours an approval only for EXACTLY the terms it was recorded for
 * (requestMatchesTerms in convex/utils/profitApproval.ts): a later, higher or
 * lower price needs a new approval. This is the one matcher the wizard uses.
 */
export function approvalMatchesTerms(
  request: MobileApprovalRequest | null | undefined,
  uplift: number,
  minimumUplift: number
): boolean {
  if (!request) return false;
  const same = (a: number, b: number) => Math.round(a * 1000) === Math.round(b * 1000);
  return same(request.requestedProfit, uplift) && (request.minimumProfit === undefined || same(request.minimumProfit, minimumUplift));
}

/** Everything the wizard shows or blocks on for the minimum price uplift, from one place. */
export function profitApprovalGate(args: {
  isCash: boolean;
  hasVehicle: boolean;
  uplift: number;
  minimum: number;
  approval: MobileApprovalRequest | null | undefined;
}) {
  const needsApproval = !args.isCash && args.hasVehicle && priceUpliftNeedsApproval(args.uplift, args.minimum);
  const exact = approvalMatchesTerms(args.approval, args.uplift, args.minimum);
  const approvalValid = needsApproval && exact && args.approval?.status === "APPROVED";
  return {
    needsApproval,
    approvalValid,
    pending: needsApproval && exact && args.approval?.status === "PENDING",
    rejected: needsApproval && exact && args.approval?.status === "REJECTED",
    blocked: needsApproval && !approvalValid,
  };
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
