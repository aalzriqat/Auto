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
}: Readonly<{
  t: Translate;
  value: PaymentMethod;
  onValueChange: (method: PaymentMethod) => void;
  methods?: readonly PaymentMethod[];
}>) {
  return (
    <Select value={value} onValueChange={(method) => onValueChange(method as PaymentMethod)}>
      <SelectTrigger>
        <SelectValue />
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
