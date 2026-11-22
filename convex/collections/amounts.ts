import { ConvexError } from "convex/values";
import { scaleForCurrency } from "../utils/money";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function assertPositiveAmount(amount: number, label = "Amount") {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConvexError(`${label} must be greater than 0.`);
  }
}

export function roundMoney(amount: number, currency: string) {
  const factor = Math.pow(10, scaleForCurrency(currency));
  return Math.round(amount * factor) / factor;
}
