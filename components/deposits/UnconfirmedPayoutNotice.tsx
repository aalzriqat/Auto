"use client";

import { Button } from "@/components/ui/button";
import type { PendingPayout } from "@/hooks/usePendingDepositPayouts";

/**
 * SCRUM-469 — shown when the operator asks for a payout that differs from an
 * earlier attempt on the same deposit whose outcome was never confirmed. The
 * earlier payout may already have gone through, so a differently-shaped request
 * is not sent: the operator retries the recorded attempt (the server replays it
 * if it committed) or dismisses it after checking the refund history.
 */
export function UnconfirmedPayoutNotice({
  pending,
  busy,
  onRetry,
  onDismiss,
  t,
}: Readonly<{
  pending: PendingPayout;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  t: (key: any) => string;
}>) {
  const attempt = pending.resolution === "REFUNDED" ? t(`PaymentMethod_${pending.method}`) : t("Forfeit");
  return (
    <div
      className="basis-full space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      role="alert"
      data-testid="unconfirmed-payout-notice"
    >
      <p className="font-medium">{t("PayoutUnconfirmedTitle")}</p>
      <p>{t("PayoutUnconfirmedBody")}</p>
      <p>
        {t("PayoutUnconfirmedAttempt")} <bdi className="font-medium">{attempt}</bdi>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onRetry}>
          {t("PayoutUnconfirmedRetry")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={onDismiss}>
          {t("PayoutUnconfirmedDismiss")}
        </Button>
      </div>
    </div>
  );
}
