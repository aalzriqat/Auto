"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
/**
 * Vehicle acquisition is the one surface where a purchase can be unpaid and
 * owed to a supplier. Mirrors `AcquisitionPaymentMethod` in
 * `convex/utils/paymentMethods.ts`, which is deliberately kept separate from
 * the base union shared by deposits, expenses, sales and ~20 other call sites
 * that have no "unpaid" concept.
 */
export type AcquisitionPaymentMethod = PaymentMethod | "ON_ACCOUNT";
export type Translate = (key: any) => string;

const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"];

/**
 * Generic over the method union so a caller that genuinely offers more than the
 * settled four — vehicle acquisition, which can be owed to a supplier — can say
 * so without widening the type for every other caller. Callers that pass no
 * `methods` still infer the narrow `PaymentMethod` and are unchanged.
 */
export function PaymentMethodSelect<M extends string = PaymentMethod>({
  t,
  value,
  onValueChange,
  methods = DEFAULT_PAYMENT_METHODS as unknown as readonly M[],
  ariaLabel,
  placeholder,
}: Readonly<{
  t: Translate;
  value: M | undefined;
  onValueChange: (method: M) => void;
  methods?: readonly M[];
  ariaLabel?: string;
  /**
   * Shown when there is no value yet. Callers that must not default a payment
   * method (an unstated method posts as CASH downstream) leave `value`
   * undefined and pass this, rather than seeding a guess to keep the trigger
   * from looking empty.
   */
  placeholder?: string;
}>) {
  return (
    <Select value={value} onValueChange={(method) => onValueChange(method as M)}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {methods.map((method) => (
          <SelectItem key={method} value={method}>
            {t(`PaymentMethod_${method}` as any)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
