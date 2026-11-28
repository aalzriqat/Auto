"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirms cancelling a CASH deal (SCRUM-969). Not `CancelApplicationDialog`:
 * a cash sale has no application, so no failure reason, appraisal fee or status
 * choice applies, and the warning describes a sale.
 *
 * An alert dialog (WAI-ARIA `alertdialog`): it interrupts for a response and is
 * named and described by its title and warning. The least destructive action
 * ("Keep deal") comes first in the DOM, so it takes the initial focus.
 * Not dismissible while the request is in flight: the request cannot be called
 * back, so a dialog that vanished would claim the deal was kept.
 */
export function CancelCashDealDialog({
  open,
  submitting,
  error,
  isCompleted,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  error: string | null;
  /** A COMPLETED sale is reversed; a PENDING one is only voided. */
  isCompleted: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void | Promise<void>;
}>) {
  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent
        role="alertdialog"
        className="max-w-md"
        onEscapeKeyDown={(event) => submitting && event.preventDefault()}
        onPointerDownOutside={(event) => submitting && event.preventDefault()}
        onInteractOutside={(event) => submitting && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("CancelDealTitle")}</DialogTitle>
          <DialogDescription>
            {isCompleted ? t("CancelDealCompletedWarning") : t("CancelDealDraftWarning")}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" data-testid="cancel-deal-error" className="text-sm font-medium text-destructive">
            {t("CancelDealRefusedLead")} <span dir="auto">{error}</span>
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" data-testid="cancel-deal-keep" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("CancelDealKeep")}
          </Button>
          <Button
            variant="destructive"
            data-testid="cancel-deal-confirm"
            disabled={submitting}
            onClick={() => void onSubmit()}
          >
            {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" aria-hidden />}
            {t("CancelDealAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
