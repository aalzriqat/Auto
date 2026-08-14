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
/**
 * What the server says this deal's economics are, as one object.
 *
 * Resolved by `handoverEvidenceFor` and consumed identically by the cockpit and
 * the legacy Review screen, so the two doors into the same irreversible action
 * cannot describe the same deal differently.
 */
export type HandoverEvidence = {
  approvedPurchaseAmountMinor: number | null;
  financeCompanyFundedPortionMinor: number | null;
  dealerContributionMinor: number | null;
  approvedAmountIsFarFromEvidence: boolean;
  /** Null when the deal's denomination cannot be established. Fails closed. */
  currency: { code: string; scale: number } | null;
};

type ConfirmHandoverDialogProps = {
  open: boolean;
  submitting: boolean;
  evidence: HandoverEvidence;
  /** The revision this deal stood at. Snapshotted with the evidence. */
  economicsStamp: string | undefined;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  /**
   * Rejects to report a refusal. The dialog catches it and holds the message
   * against THIS attempt.
   *
   * Error state deliberately does not live in the parent. It did, and the
   * parent cleared it on submit rather than on open — so reopening after a
   * stale-stamp refusal showed the previous attempt's "the figures changed"
   * message beside freshly snapshotted figures from a different revision. That
   * was the fifth defect of one class in this component, and the reason it is
   * now shaped this way: an error that belongs to an attempt cannot outlive it
   * if the attempt owns it.
   */
  onSubmit: (values: { notes?: string; economicsStamp: string | undefined }) => Promise<void>;
};

export function ConfirmHandoverDialog({
  open,
  submitting,
  evidence,
  economicsStamp,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ConfirmHandoverDialogProps>) {
  /**
   * ONE confirmation attempt, created atomically when the dialog opens.
   *
   * This component used to be a dialog with props, and five separate defects
   * came from that shape: part of what the operator saw was frozen and part was
   * live, so the screen described two states of the deal at once. The figures,
   * then the currency they were spelled in, then the anomaly warning, then the
   * error — each found by a reviewer after the previous was called fixed, and
   * the fourth fix (collapsing the economics reads) still missed the error
   * because it drew the boundary around the wrong thing.
   *
   * So the unit here is an ATTEMPT, not a dialog. Everything the operator is
   * asked to confirm, everything used to spell it, the revision it stands at,
   * and any refusal it earns all belong to the same object and are replaced
   * together. A live Convex refetch may invalidate an attempt — the server's
   * stamp comparison is what enforces that — but it cannot alter what the
   * operator is currently being asked to confirm.
   *
   * Nothing below reads a prop. If a future field needs rendering it must join
   * the attempt, and reaching past it is visible on the line.
   */
  type Attempt = {
    evidence: HandoverEvidence;
    economicsStamp: string | undefined;
    notes: string;
    error: string | null;
  };
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    // A new open is a new attempt — never a reset of the previous one, which is
    // how a stale error survived into a fresh confirmation.
    if (open) setAttempt({ evidence, economicsStamp, notes: "", error: null });
  }

  // Before the first open there is no attempt and nothing is rendered from it;
  // the dialog is closed, so there is no state to be inconsistent with.
  const live: Attempt = attempt ?? { evidence, economicsStamp, notes: "", error: null };
  const shown = live.evidence;

  /**
   * The attempt's own formatter, built from the denomination the SERVER
   * established for this deal.
   *
   * No fallback chain. The previous version fell from the deal's currency to
   * the org's to a hardcoded default, and for a role that cannot read org
   * settings that meant a USD deal rendered in JOD — 1,150,000 minor units
   * shown as 1,150 on the screen that seals the deal permanently.
   */
  const money = (minor: number) =>
    shown.currency
      ? `${(minor / Math.pow(10, shown.currency.scale)).toLocaleString()} ${shown.currency.code}`
      : "";
  // Figures exist but nobody can say what they are denominated in: refuse
  // rather than spell them in a currency nobody verified.
  const denominationUnverified =
    shown.currency === null && shown.approvedPurchaseAmountMinor !== null;

  const setNotes = (value: string) =>
    setAttempt((current) => (current ? { ...current, notes: value } : current));
  const notes = live.notes;

  const submit = async () => {
    setAttempt((current) => (current ? { ...current, error: null } : current));
    try {
      await onSubmit({
        notes: live.notes.trim() || undefined,
        // The revision this attempt was opened against, never a fresh read.
        economicsStamp: live.economicsStamp,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAttempt((current) => (current ? { ...current, error: message } : current));
    }
  };

  const figures: Array<{ key: string; label: string; minor: number; flagged?: boolean }> = [];
  if (shown.approvedPurchaseAmountMinor != null) {
    figures.push({
      key: "approved",
      label: t("ApprovedPurchaseLabel"),
      minor: shown.approvedPurchaseAmountMinor,
      // The figure this dialog exists to have a last look at, and the one the
      // server has already judged unusual. Presenting it with the same weight
      // as the rest is how an order-of-magnitude mistake reads as ordinary.
      flagged: shown.approvedAmountIsFarFromEvidence,
    });
  }
  if (shown.financeCompanyFundedPortionMinor != null) {
    figures.push({
      key: "funded",
      label: t("DerivedFundedPortion"),
      minor: shown.financeCompanyFundedPortionMinor,
    });
  }
  if (shown.dealerContributionMinor != null) {
    figures.push({
      key: "contribution",
      label: t("DerivedDealerContribution"),
      minor: shown.dealerContributionMinor,
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
            {shown.approvedAmountIsFarFromEvidence && (
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

          {denominationUnverified && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t("HandoverCurrencyUnverified")}
            </p>
          )}

          {live.error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {live.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            // Refused outright while the denomination is unverified: an
            // operator cannot meaningfully confirm a figure whose currency
            // nobody can establish, and this door does not reopen.
            disabled={submitting || denominationUnverified}
            onClick={submit}
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
