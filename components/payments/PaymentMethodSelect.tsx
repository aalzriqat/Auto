"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
export type Translate = (key: any) => string;

const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"];

export function PaymentMethodSelect({
  t,
  value,
  onValueChange,
  methods = DEFAULT_PAYMENT_METHODS,
  ariaLabel,
  placeholder,
}: Readonly<{
  t: Translate;
  value: PaymentMethod | undefined;
  onValueChange: (method: PaymentMethod) => void;
  methods?: readonly PaymentMethod[];
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
    <Select value={value} onValueChange={(method) => onValueChange(method as PaymentMethod)}>
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
