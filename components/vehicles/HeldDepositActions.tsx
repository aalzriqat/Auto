"use client";

import { Button } from "@/components/ui/button";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { isChosenMethod } from "@/components/payments/paymentMethod";
import type { Id } from "@/convex/_generated/dataModel";
import { DepositRefundBankSelect, useDepositRefundBanks } from "@/components/deposits/DepositRefundBankSelect";

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
  orgId,
  currency,
  method,
  bankAccountId,
  onMethodChange,
  onBankChange,
  busy,
  onRefund,
  onForfeit,
  t,
}: Readonly<{
  orgId: Id<"organizations"> | undefined;
  currency?: string;
  method: PaymentMethod | undefined;
  bankAccountId: string;
  onMethodChange: (method: PaymentMethod) => void;
  onBankChange: (bankAccountId: string) => void;
  busy: boolean;
  onRefund: (method: PaymentMethod, bankAccountId?: Id<"bankAccounts">) => void;
  onForfeit: () => void;
  t: (key: any) => string;
}>) {
  const needsBank = method === "BANK_TRANSFER" || method === "CARD" || method === "CHEQUE";
  const bankOptions = useDepositRefundBanks(orgId, currency, needsBank, bankAccountId);
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
          disabled={busy || !isChosenMethod(method) || (needsBank && !bankOptions.chosenOffered)}
          onClick={() => {
            if (isChosenMethod(method) && (!needsBank || bankOptions.chosenOffered))
              onRefund(method, needsBank ? bankAccountId as Id<"bankAccounts"> : undefined);
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
      {needsBank && (
        <div className="w-64 max-w-full">
          <DepositRefundBankSelect value={bankAccountId}
            onChange={onBankChange} bankOptions={bankOptions} disabled={busy} />
        </div>
      )}
      {!isChosenMethod(method) ? (
        <p className="max-w-[18rem] text-xs font-medium text-destructive text-end" role="status">
          {t("RefundMethodRequired")}
        </p>
      ) : null}
    </div>
  );
}
