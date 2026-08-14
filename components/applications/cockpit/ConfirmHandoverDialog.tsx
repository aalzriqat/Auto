"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Truck } from "lucide-react";
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
 * Registers the vehicle going out to the customer — and says what that closes.
 *
 * Handover is the deal's one-way door. `reopenApproval` refuses once
 * `vehicleHandoverAt` is set, so from this moment a wrong approved purchase
 * amount can no longer be corrected through the normal flow; the only remedy
 * left is cancelling the application. Moving this action onto the cockpit puts
 * that door one row below the figure it seals, which is why the warning is
 * stated here rather than discovered afterwards.
 *
 * The approved amount and the funding split are shown INSIDE the dialog, not
 * merely referred to. A confirmation that asks an operator to "verify the
 * approved amount" without showing it is asking them to remember a number, and
 * the deal that prompted this whole workstream carried a 150,000 JOD figure
 * against a 17,000 quotation. This is the last screen that would have shown it.
 */
type ConfirmHandoverDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  /**
   * What the finance company approved, when this caller may see it.
   *
   * Null where `redactSettlementEvidence` withheld it. The warning still
   * applies — the door still closes — so it is stated either way, and the
   * dialog simply cannot show the figure it is asking about. Suppressing the
   * whole warning because one caller cannot see one number would remove the
   * safeguard from the deals it protects.
   */
  approvedAmountMinor: number | null;
  financeCompanyFundedPortionMinor: number | null;
  dealerContributionMinor: number | null;
  /**
   * The SERVER's verdict that this amount is unlike every figure on file.
   *
   * Consumed, never re-derived. `getEconomics` computes it with the same rule
   * and against the same appraisal that `approveDealerPurchaseAmount` uses to
   * refuse an unacknowledged outlier, so this dialog cannot form a second
   * opinion about what counts as unusual. A screen that disagreed with the
   * mutation about the same deal would be worse than one that said nothing.
   *
   * It changes emphasis only. The mutation stays authoritative regardless of
   * what is rendered here, and handover is never refused on this basis — an
   * unusual amount can be perfectly correct.
   */
  approvedAmountIsFarFromEvidence: boolean;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { notes?: string }) => void;
};

export function ConfirmHandoverDialog({
  open,
  submitting,
  error,
  approvedAmountMinor,
  financeCompanyFundedPortionMinor,
  dealerContributionMinor,
  approvedAmountIsFarFromEvidence,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ConfirmHandoverDialogProps>) {
  const [notes, setNotes] = useState("");

  // Reset on the closed -> open transition only, as the sibling dialogs do.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setNotes("");
  }, [open]);

  const figures: Array<{ key: string; label: string; minor: number; flagged?: boolean }> = [];
  if (approvedAmountMinor !== null) {
    figures.push({
      key: "approved",
      label: t("ApprovedPurchaseLabel"),
      minor: approvedAmountMinor,
      // The figure this dialog exists to have a last look at, and the one the
      // server has already judged unusual. Presenting it with the same weight
      // as the rest is how an order-of-magnitude mistake reads as ordinary.
      flagged: approvedAmountIsFarFromEvidence,
    });
  }
  if (financeCompanyFundedPortionMinor !== null) {
    figures.push({
      key: "funded",
      label: t("DerivedFundedPortion"),
      minor: financeCompanyFundedPortionMinor,
    });
  }
  if (dealerContributionMinor !== null) {
    figures.push({
      key: "contribution",
      label: t("DerivedDealerContribution"),
      minor: dealerContributionMinor,
    });
  }

  return (
    // Not dismissible while the mutation is in flight. Escape, the overlay and
    // the built-in × all resolve to `onOpenChange(false)` and none of them
    // cancels the request — the handover records regardless, and it is the
    // moment the approved amount stops being correctable. An operator who backs
    // out and watches the dialog close has been told the one-way door did not
    // open. It did.
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => submitting && event.preventDefault()}
        onPointerDownOutside={(event) => submitting && event.preventDefault()}
        onInteractOutside={(event) => submitting && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("ConfirmHandoverTitle")}</DialogTitle>
          <DialogDescription>{t("ConfirmHandoverDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* The warning is the point of this dialog, so it leads. */}
          <div
            role="alert"
            className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3"
          >
            <p className="text-sm font-medium">{t("HandoverSealsApprovedAmount")}</p>
            {figures.length > 0 && (
              <dl className="space-y-1 text-sm">
                {figures.map((figure) => (
                  <div key={figure.key} className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{figure.label}</dt>
                    <dd className={figure.flagged ? "text-destructive" : undefined}>
                      <bdi
                        className={
                          figure.flagged
                            ? "tabular-nums font-bold text-base"
                            : "tabular-nums font-medium"
                        }
                      >
                        {money(figure.minor)}
                      </bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {/* Named, not merely coloured: colour alone is not a message, and
                it is not available to every reader. */}
            {approvedAmountIsFarFromEvidence && (
              <p className="text-sm font-medium text-destructive">
                {t("HandoverAmountLooksUnusual")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("HandoverVerifyBeforeContinuing")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handover-notes">{t("HandoverNotesLabel")}</Label>
            <Textarea
              id="handover-notes"
              rows={2}
              value={notes}
              placeholder={t("HandoverNotesPlaceholder")}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

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
          <Button
            disabled={submitting}
            onClick={() => onSubmit({ notes: notes.trim() || undefined })}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Truck className="h-4 w-4 me-2" />
            )}
            {t("ConfirmHandoverAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
