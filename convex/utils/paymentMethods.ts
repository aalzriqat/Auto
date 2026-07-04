import { v } from "convex/values";

export type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

export const paymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("CARD")
);

export function normalizePaymentMethod(method?: PaymentMethod): PaymentMethod {
  return method ?? "CASH";
}
