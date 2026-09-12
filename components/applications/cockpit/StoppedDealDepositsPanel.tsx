"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HandCoins, Undo2, XCircle } from "lucide-react";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";

export type DepositResolution = "REFUNDED" | "FORFEITED";

/** A deposit as `applications.get` lists it against the deal's quote. */
export type DealDeposit = {
  _id: string;
  amount: number;
  status: string;
  method?: string;
  /** Minor units already paid out of this row by an earlier release. */
  releasedAmountMinor?: number;
  /**
   * The payout GENERATION of this row — `deposits.releaseCount`, bumped by the
   * server in the same patch that moves the money. Captured with the operator's
   * decision so the release identity names the generation it was taken against.
   */
  releaseCount?: number;
};

/**
 * The customer's money on a deal that is over.
 *
 * A rejected or cancelled application can still be holding a HELD deposit —
 * real cash sitting in `Customer Deposits Liability` with no outcome recorded.
 * The applications LIST has always flagged this as DEPOSIT_PENDING and the
 * Review dialog was the only place to act on it. The action now lives on the
 * deal, on the SAME `deposits.release` mutation: refund (with the method the
 * cash actually leaves by, because the GL credits that account) or forfeit.
 *
 * This screen decides nothing about the money. It lists what the server
 * lists, offers the two outcomes to a caller the server will accept
 * (`approve:requests`), and confirms the amount and outcome before posting an
 * audited financial decision — the same confirmation Review required.
 */
export function StoppedDealDepositsPanel({
  deposits,
  canResolve,
  faceValueIsReleasable,
  resolvingId,
  formatAmount,
  t,
  onResolve,
}: Readonly<{
  deposits: ReadonlyArray<DealDeposit>;
  canResolve: boolean;
  /**
   * Server-derived: nothing on the quote is applied, assigned to a car,
   * awaiting its own decision, or paid out — so a row's face value IS what
   * `deposits.release` would pay. When false the action is withheld and the
   * reason is stated, because an irreversible confirmation must show the exact
   * amount that will move, and this screen cannot compute the free remainder.
   */
  faceValueIsReleasable: boolean;
  resolvingId: string | null;
  formatAmount: (amount: number) => string;
  t: (key: string) => string;
  onResolve: (
    depositId: string,
    resolution: DepositResolution,
    refundMethod: PaymentMethod | undefined,
    observedReleaseCount: number
  ) => Promise<void>;
}>) {
  const [pending, setPending] = useState<{
    depositId: string;
    amount: number;
    resolution: DepositResolution;
    /**
     * `releaseCount` as observed when the operator chose the action — THIS is
     * the intent boundary. Re-reading it at confirm time would let the
     * generation move underneath a decision already made.
     */
    releaseCount: number;
  } | null>(null);
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>("CASH");

  const statusLabel = (status: string) => {
    switch (status) {
      case "HELD":
        return t("DepositStatusHeld");
      case "REFUNDED":
        return t("DepositStatusRefunded");
      case "FORFEITED":
        return t("DepositStatusForfeited");
      case "APPLIED":
        return t("DepositStatusApplied");
      default:
        return status;
    }
  };
  const statusClass = (status: string) => {
    switch (status) {
      case "HELD":
        return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
      case "REFUNDED":
        return "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
      case "FORFEITED":
        return "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300";
      default:
        return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    }
  };

  const close = () => {
    setPending(null);
    setRefundMethod("CASH");
  };
  const isResolvingPending = pending !== null && resolvingId === pending.depositId;

  return (
    <>
      <div className="space-y-2" data-testid="deal-deposits">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          <HandCoins className="h-4 w-4" />
          {t("ApplicationDeposits")}
        </div>
        {/* Stated once, above the rows, when the decision belongs elsewhere. */}
        {canResolve && !faceValueIsReleasable && deposits.some((d) => d.status === "HELD") && (
          <p className="text-xs text-muted-foreground">{t("DepositResolveElsewhere")}</p>
        )}
        {deposits.map((deposit) => {
          const held = deposit.status === "HELD";
          // A row partly paid out is never resolved from its face value here,
          // whatever the quote summary says.
          const resolvable =
            held && canResolve && faceValueIsReleasable && !(deposit.releasedAmountMinor ?? 0);
          return (
            <div
              key={deposit._id}
              className="space-y-2 rounded-md border bg-background p-2 text-sm"
              data-testid={`deal-deposit-${deposit._id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    <bdi className="tabular-nums">{formatAmount(deposit.amount)}</bdi>
                  </p>
                  {deposit.method && (
                    // Translated, never the raw enum. The dictionary carries
                    // `PaymentMethod_<METHOD>`; an unknown method falls back to
                    // its own name rather than to nothing.
                    <p className="text-xs text-muted-foreground">
                      <bdi>{t(`PaymentMethod_${deposit.method}`)}</bdi>
                    </p>
                  )}
                </div>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusClass(deposit.status)}`}>
                  {statusLabel(deposit.status)}
                </span>
              </div>
              {held && canResolve && !!(deposit.releasedAmountMinor ?? 0) && faceValueIsReleasable && (
                <p className="text-xs text-muted-foreground">{t("DepositResolveElsewhere")}</p>
              )}
              {resolvable && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolvingId === deposit._id}
                    onClick={() =>
                      setPending({
                        depositId: deposit._id,
                        amount: deposit.amount,
                        resolution: "REFUNDED",
                        releaseCount: deposit.releaseCount ?? 0,
                      })
                    }
                  >
                    <Undo2 className="h-3.5 w-3.5 me-1.5" />
                    {t("Refund")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={resolvingId === deposit._id}
                    onClick={() =>
                      setPending({
                        depositId: deposit._id,
                        amount: deposit.amount,
                        resolution: "FORFEITED",
                        releaseCount: deposit.releaseCount ?? 0,
                      })
                    }
                  >
                    <XCircle className="h-3.5 w-3.5 me-1.5" />
                    {t("Forfeit")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && !isResolvingPending) close();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ConfirmDepositResolution")}</DialogTitle>
            <DialogDescription>{t("DepositResolutionConfirmDesc")}</DialogDescription>
          </DialogHeader>
          {pending && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("DepositResolutionAmount")}</span>
                <span className="font-medium">
                  <bdi className="tabular-nums">{formatAmount(pending.amount)}</bdi>
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("DepositResolutionOutcome")}</span>
                <span className="font-medium">
                  {pending.resolution === "REFUNDED" ? t("Refund") : t("Forfeit")}
                </span>
              </div>
            </div>
          )}
          {pending?.resolution === "REFUNDED" && (
            <div className="space-y-1">
              <span className="text-sm font-medium">{t("PaymentMethodLabel")}</span>
              <PaymentMethodSelect t={t} value={refundMethod} onValueChange={setRefundMethod} />
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={isResolvingPending} onClick={close}>
              {t("Cancel")}
            </Button>
            {pending && (
              <Button
                variant={pending.resolution === "FORFEITED" ? "destructive" : "default"}
                disabled={isResolvingPending}
                onClick={() =>
                  void onResolve(
                    pending.depositId,
                    pending.resolution,
                    pending.resolution === "REFUNDED" ? refundMethod : undefined,
                    pending.releaseCount
                  ).then(close, () => undefined)
                }
              >
                {pending.resolution === "REFUNDED" ? t("ConfirmRefund") : t("ConfirmForfeit")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
