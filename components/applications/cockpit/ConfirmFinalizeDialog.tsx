"use client";

import { Loader2, CheckCircle2, LockKeyhole } from "lucide-react";
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
  /**
   * SCRUM-260: the minimum-profit approval for the price this sale persists,
   * with its request action. `blocked` disables the close while the server
   * would refuse it for want of that approval.
   */
  profitApproval?: { notice: React.ReactNode; blocked: boolean };
  /**
   * S414-R3-1: why the close may not be submitted right now — the dialog can
   * outlive the READY verdict it was opened on (a failed read, a verdict that
   * turned BLOCKED), or the caller cannot read the readiness at all. Shown in
   * place and the confirm is disabled while it is set.
   */
  readinessHold?: string | null;
};

export function ConfirmFinalizeDialog({
  open,
  submitting,
  error,
  t,
  onOpenChange,
  onSubmit,
  profitApproval,
  readinessHold,
}: Readonly<ConfirmFinalizeDialogProps>) {
  return (
    // Not dismissible while the mutation is in flight.
    //
    // Escape, the overlay and the built-in × are all `onOpenChange(false)`, and
    // none of them cancels the request — there is no abort path, and the sale
    // posts regardless. An operator who backs out of "close the deal" and
    // watches the dialog disappear has been told the action was stopped. It was
    // not. `SettlementAdviceCorrectionDialog` already refuses to close mid-
    // submit; this is the same rule on the action that has no unwind at all.
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => submitting && event.preventDefault()}
        onPointerDownOutside={(event) => submitting && event.preventDefault()}
        onInteractOutside={(event) => submitting && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("ConfirmFinalizeTitle")}</DialogTitle>
          <DialogDescription>{t("ConfirmFinalizeDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">{t("FinalizeCreatesTheSale")}</p>
          </div>

          {profitApproval?.notice}

          {readinessHold && (
            <p
              role="status"
              data-testid="finalize-readiness-hold"
              className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-foreground"
            >
              <LockKeyhole aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{readinessHold}</span>
            </p>
          )}

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
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={submitting || !!profitApproval?.blocked || !!readinessHold} onClick={onSubmit}>
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
