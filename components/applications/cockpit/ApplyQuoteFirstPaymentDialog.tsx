"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-373 D2 — applies the originating quote's down payment to an approved
 * deal whose first payment was recorded as 0.
 *
 * There is no amount field: the server applies exactly the quote's figure, so
 * the only thing the operator supplies is why. Offered only when the server's
 * `firstPaymentCorrection.available` says it would accept — never re-derived
 * here.
 */
type ApplyQuoteFirstPaymentDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  quoteDownPaymentMinor: number;
  /** The figures on screen; captured when the dialog opens and submitted with it. */
  economicsStamp: string;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { reason: string; economicsStamp: string }) => void;
};

export function ApplyQuoteFirstPaymentDialog({
  open,
  submitting,
  error,
  quoteDownPaymentMinor,
  economicsStamp,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ApplyQuoteFirstPaymentDialogProps>) {
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState<{ quoteDownPaymentMinor: number; economicsStamp: string } | null>(null);

  // Reset on the closed -> open transition only, and snapshot the figure with
  // its stamp, like the sibling dialogs: the operator confirms the figure they
  // were shown, and a change made meanwhile makes the server refuse the stamp.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setReason("");
    setAttempt({ quoteDownPaymentMinor, economicsStamp });
  }, [open, quoteDownPaymentMinor, economicsStamp]);

  const live = attempt ?? { quoteDownPaymentMinor, economicsStamp };

  const reasonMissing = reason.trim() === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ApplyQuoteFirstPaymentTitle")}</DialogTitle>
          <DialogDescription>{t("ApplyQuoteFirstPaymentDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <dl className="divide-y rounded-md border text-sm">
            <div className="flex items-center justify-between gap-4 p-3">
              <dt className="text-muted-foreground">{t("ApplyQuoteFirstPaymentCurrent")}</dt>
              <dd>
                <bdi className="tabular-nums">{money(0)}</bdi>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 p-3">
              <dt className="text-muted-foreground">{t("ApplyQuoteFirstPaymentNew")}</dt>
              <dd>
                <bdi className="tabular-nums font-semibold">{money(live.quoteDownPaymentMinor)}</bdi>
              </dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <Label htmlFor="apply-quote-first-payment-reason">
              {t("ApplyQuoteFirstPaymentReasonLabel")}
            </Label>
            <Textarea
              id="apply-quote-first-payment-reason"
              rows={3}
              value={reason}
              aria-invalid={reasonMissing}
              onChange={(event) => setReason(event.target.value)}
            />
            {reasonMissing && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("ApplyQuoteFirstPaymentReasonRequired")}
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={reasonMissing || submitting}
            onClick={() => onSubmit({ reason: reason.trim(), economicsStamp: live.economicsStamp })}
          >
            {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {t("ApplyQuoteFirstPaymentAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
