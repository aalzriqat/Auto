"use client";

import { Loader2, CheckCircle2 } from "lucide-react";
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
 * Closes the deal — and says what closing it creates.
 *
 * `finalizeDeal` is not a status change. It creates the sale, posts its
 * journals, moves the vehicle and opens whatever the settlement route implies,
 * and there is no unwind button: reversing it means cancelling the sale.
 *
 * The review dialog fires it from a bare button, which was defensible on a
 * modal an operator had to go looking for. On the cockpit it sits on the screen
 * the deal lives on, so it is confirmed first. The confirmation carries no
 * figures deliberately — the amounts that matter were sealed at handover, one
 * step earlier, and repeating them here would suggest they are still in play.
 */
type ConfirmFinalizeDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
};

export function ConfirmFinalizeDialog({
  open,
  submitting,
  error,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ConfirmFinalizeDialogProps>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ConfirmFinalizeTitle")}</DialogTitle>
          <DialogDescription>{t("ConfirmFinalizeDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">{t("FinalizeCreatesTheSale")}</p>
          </div>

          {/* Every refusal reachable from this button names the thing to change
              — an unrecorded settlement route, missing economics, an unresolved
              عربون. Kept on the dialog rather than only in a toast, because it
              is the instruction for the next attempt. */}
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
          <Button disabled={submitting} onClick={onSubmit}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 me-2" />
            )}
            {t("ConfirmFinalizeAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
