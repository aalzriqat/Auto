"use client";

import { Button } from "@/components/ui/button";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { isChosenMethod } from "@/components/payments/paymentMethod";

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
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="w-44 max-w-full">
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
          disabled={busy || !isChosenMethod(method)}
          onClick={() => {
            if (isChosenMethod(method)) onRefund(method);
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
      {!isChosenMethod(method) ? (
        <p className="max-w-[18rem] text-xs font-medium text-destructive text-end" role="status">
          {t("RefundMethodRequired")}
        </p>
      ) : null}
    </div>
  );
}
