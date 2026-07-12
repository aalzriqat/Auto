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

// A separate, wider type/validator scoped ONLY to vehicle-acquisition
// payment method args (vehicles.create/update's purchasePaymentMethod) —
// deliberately not folded into the base PaymentMethod above, which is
// shared by ~20 other call sites (deposits, expenses, sales, landed costs,
// claims, ...) that have no "unpaid, owed to a supplier" concept and would
// silently fall through cashAccountKey's default-to-CASH branch if handed
// a method it doesn't recognize.
export type AcquisitionPaymentMethod = PaymentMethod | "ON_ACCOUNT";

export const acquisitionPaymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("CARD"),
  v.literal("ON_ACCOUNT")
);
