import { ConvexError } from "convex/values";

export function monthStart(timestamp: number): number {
  const date = new Date(timestamp);
  const result = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(result)) {
    throw new ConvexError("Choose a valid management schedule date.");
  }
  return result;
}

/** Freeze economics once: six floor shares and the exact remainder in month seven. */
export function managementInstallments(totalMinor: number, firstMonth: number) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw new ConvexError("Enter a positive integer minor-unit total.");
  if (monthStart(firstMonth) !== firstMonth) throw new ConvexError("Choose the first day of a management month.");
  const base = Math.floor(totalMinor / 7);
  const start = new Date(firstMonth);
  const installments = Array.from({ length: 7 }, (_, index) => ({
    sequence: index + 1,
    effectiveMonth: Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1),
    amountMinor: index === 6 ? totalMinor - base * 6 : base,
  }));
  if (installments.some((row) => !Number.isSafeInteger(row.effectiveMonth))) {
    throw new ConvexError("Choose a management schedule date with seven representable months.");
  }
  return installments;
}