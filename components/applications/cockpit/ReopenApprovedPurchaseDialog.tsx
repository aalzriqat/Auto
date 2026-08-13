"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
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
 * Takes a recorded approved purchase amount back off the record, with a reason.
 *
 * The amount already on file is a FACT ABOUT AN OUTSIDE PARTY — what the
 * finance company said it would buy the vehicle at — and the funding split, the
 * dealership's contribution and the expected remittance are all derived from
 * it. Replacing such a figure silently would leave the deal telling a different
 * story than it did an hour ago with nothing on the record to say so, which is
 * why this is a reopen-with-a-reason and not an edit box.
 *
 * The reason is not decoration: `reopenApproval` refuses an empty one, and the
 * row it writes to `financeApplicationOverrides` is the only place the previous
 * amount survives. So the text typed here IS the audit trail.
 *
 * Two steps rather than one — reopen, then record again — because the server
 * clears the whole derived cluster on reopen and re-derives it from the new
 * amount. A single "change it to X" would have to either recompute on the
 * client or leave the deal briefly describing a split that no longer follows
 * from its own inputs.
 */
type ReopenApprovedPurchaseDialogProps = {
  open: boolean;
  submitting: boolean;
  /** The server's refusal, rendered in the form rather than as a toast. */
  error: string | null;
  /**
   * What is on the record now, when this caller is allowed to see it.
   *
   * Null where `redactSettlementEvidence` withheld it — the correction is still
   * legitimate, so the dialog states the amount it can and stays silent about
   * the one it cannot rather than printing a blank where a figure belongs.
   */
  currentAmountMinor: number | null;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { reason: string }) => void;
};

export function ReopenApprovedPurchaseDialog({
  open,
  submitting,
  error,
  currentAmountMinor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ReopenApprovedPurchaseDialogProps>) {
  const [reason, setReason] = useState("");

  // Reset on the closed -> open transition only, matching the sibling dialogs:
  // resetting on every render would clear a half-typed reason the moment the
  // live query behind the amount ticks.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setReason("");
  }, [open]);

  const reasonMissing = reason.trim() === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ReopenApprovedPurchaseTitle")}</DialogTitle>
          <DialogDescription>{t("ReopenApprovedPurchaseDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {currentAmountMinor !== null && (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <span className="text-sm text-muted-foreground">
                {t("ApprovedPurchaseLabel")}
              </span>
              <bdi className="tabular-nums font-semibold">{money(currentAmountMinor)}</bdi>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="reopen-approval-reason">{t("ReopenApprovalReasonLabel")}</Label>
            <Textarea
              id="reopen-approval-reason"
              rows={3}
              value={reason}
              placeholder={t("ReopenApprovalReasonPlaceholder")}
              aria-invalid={reasonMissing}
              onChange={(event) => setReason(event.target.value)}
            />
            {reasonMissing && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("ReopenApprovalReasonRequired")}
              </p>
            )}
          </div>

          {/* Said before the write, because the next screen asks for a figure
              and an operator who does not expect that reads the cleared split
              as data loss. */}
          <p className="text-xs text-muted-foreground">{t("ReopenApprovalWhatHappensNext")}</p>

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
            variant="destructive"
            disabled={reasonMissing || submitting}
            onClick={() => onSubmit({ reason: reason.trim() })}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Undo2 className="h-4 w-4 me-2" />
            )}
            {t("ReopenApprovedPurchaseAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
