import { AppErrorCode, throwAppError } from "./errors";
import { fromMinorUnits, supportedCurrencyScale, toMinorUnits } from "./money";

export const SUPPLIER_AMOUNT_PRECISION_MESSAGE =
  "Purchase and supplier payment amounts must match the currency's decimal places. Correct the amount before paying.";

/** No rounding of a stored entitlement or caller-supplied purchase amount. */
function exactMinor(amount: number, currency: string): number | null {
  const scale = supportedCurrencyScale(currency);
  if (scale === null || !Number.isFinite(amount) || amount < 0) return null;
  if (!Number.isSafeInteger(Math.round(amount * 10 ** scale))) return null;
  const minor = toMinorUnits(amount, currency);
  return fromMinorUnits(minor, currency) === amount ? minor : null;
}

export function requireSupplierAmountMinor(amount: number, currency: string): number {
  const minor = exactMinor(amount, currency);
  if (minor === null) {
    throwAppError(AppErrorCode.SUPPLIER_AMOUNT_PRECISION, SUPPLIER_AMOUNT_PRECISION_MESSAGE);
  }
  return minor;
}

export function assertVehicleCostPrecision(
  amounts: { purchasePrice?: number; sourceCost?: number },
  currency: string,
): void {
  if (amounts.purchasePrice !== undefined) requireSupplierAmountMinor(amounts.purchasePrice, currency);
  if (amounts.sourceCost !== undefined) requireSupplierAmountMinor(amounts.sourceCost, currency);
}

/** One server projection for list and settlement. Invalid legacy rows stay visible. */
export function supplierSettlementAmountMinor(
  payable: { amountDue: number; amountPaid?: number; currency: string },
): number | null {
  const due = exactMinor(payable.amountDue, payable.currency);
  const paid = exactMinor(payable.amountPaid ?? 0, payable.currency);
  if (due === null || paid === null || paid > due) return null;
  // Keep markPaid's existing conversion for valid rows. Both consumers use this result.
  return toMinorUnits(payable.amountDue - (payable.amountPaid ?? 0), payable.currency);
}

export function requireSupplierSettlementAmountMinor(
  payable: { amountDue: number; amountPaid?: number; currency: string },
): number {
  const minor = supplierSettlementAmountMinor(payable);
  if (minor === null) {
    throwAppError(AppErrorCode.SUPPLIER_AMOUNT_PRECISION, SUPPLIER_AMOUNT_PRECISION_MESSAGE);
  }
  return minor;
}
