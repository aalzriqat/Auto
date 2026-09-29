"use client";

import { Button } from "@/components/ui/button";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";

/**
 * Refund or forfeit a HELD deposit, from the vehicle's own deposit list.
 *
 * SCRUM-469 — the refund method picks the ledger account the money leaves by, so
 * it is CHOSEN, never assumed: the picker starts empty, Refund is refused until
 * one is chosen (with the reason on screen), and only the chosen method is ever
 * handed to `onRefund`. Forfeit moves no cash and asks for none.
 *
 * Controlled: the parent owns the chosen method (it is part of the release
 * command's identity) and the mutation.
 */
export function HeldDepositActions({
  method,
  onMethodChange,
  busy,
  onRefund,
  onForfeit,
  t,
}: Readonly<{
  method: PaymentMethod | undefined;
  onMethodChange: (method: PaymentMethod) => void;
  busy: boolean;
  onRefund: (method: PaymentMethod) => void;
  onForfeit: () => void;
  t: (key: any) => string;
}>) {
  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <div className="flex gap-2 items-center">
        <div className="w-32">
          <PaymentMethodSelect
            t={t}
            value={method}
            onValueChange={onMethodChange}
            ariaLabel={t("PaymentMethodLabel")}
            placeholder={t("RefundChooseMethod")}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy || method === undefined}
          onClick={() => {
            if (method !== undefined) onRefund(method);
          }}
        >
          {t("Refund") ?? "Refund"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive"
          disabled={busy}
          onClick={onForfeit}
        >
          {t("Forfeit") ?? "Forfeit"}
        </Button>
      </div>
      {method === undefined ? (
        <p className="text-xs font-medium text-destructive text-end" role="alert">
          {t("RefundMethodRequired")}
        </p>
      ) : null}
    </div>
  );
}
