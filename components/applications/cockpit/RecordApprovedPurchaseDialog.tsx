"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioCardGroup } from "./RadioCardGroup";
import { isApprovalFarFromEvidence } from "@/lib/financingEconomics";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ApprovalBasis = "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";

export type ApprovalDeparture = {
  enteredMinor: number;
  quotationMinor: number | null;
  appraisalMinor: number | null;
};

/**
 * The figures to put in front of the operator — or null when nothing is odd.
 *
 * The RULE itself lives in `packages/shared`, beside the arithmetic it guards,
 * because `approveDealerPurchaseAmount` enforces the same question and refuses
 * an unacknowledged outlier. A threshold maintained separately here and in the
 * mutation would eventually disagree with itself, and then the screen would
 * warn about a figure the server takes silently, or stay quiet about one the
 * server rejects. This function only decides what to SHOW.
 */
export function approvalDeparture(input: {
  enteredMinor: number | null;
  quotationMinor: number | null;
  appraisalMinor: number | null;
}): ApprovalDeparture | null {
  if (input.enteredMinor === null) return null;
  const far = isApprovalFarFromEvidence({
    approvedAmountMinor: input.enteredMinor,
    submittedQuotationMinor: input.quotationMinor,
    appraisalAmountMinor: input.appraisalMinor,
  });
  if (!far) return null;

  return {
    enteredMinor: input.enteredMinor,
    quotationMinor: input.quotationMinor,
    appraisalMinor: input.appraisalMinor,
  };
}

/**
 * Records the amount the finance company said it will buy the vehicle at.
 *
 * The BASIS is a fact about their decision, not a formula: equal to their
 * appraisal, equal to our quotation under their own tolerance rule, or a third
 * negotiated figure. So the basis is chosen and the amount follows from it —
 * for the first two the amount is fixed by the evidence already on file and
 * shown read-only, because the server refuses any other value under those
 * labels. Only `MANUAL` takes a free amount, and it demands a note saying what
 * the company actually told the dealership.
 *
 * Bases whose evidence does not exist are ABSENT rather than shown disabled: an
 * appraisal-based option on a deal with no appraisal is an offer the server can
 * only refuse. The reason they are missing is stated instead.
 */
type RecordApprovedPurchaseDialogProps = {
  open: boolean;
  submitting: boolean;
  /** The server's refusal, rendered in the form — see the quotation dialog. */
  error: string | null;
  /** The current, non-superseded appraisal, when the deal has one. */
  appraisal: { id: string; amountMinor: number } | null;
  /** Recorded before this dialog can be reached, so never null in practice. */
  submittedQuotationMinor: number | null;
  /**
   * The rate the deal is financed at, shown because it is what turns the amount
   * being recorded here into a funding split.
   *
   * The approver is committing the money decision, and the derived split that
   * follows is not a property of the amount alone — the same approved figure
   * under 90% and under 70% leaves the dealership a different contribution. On
   * the exceptional per-deal path this rate was set by a manager rather than
   * configured on the company, so stating it here is the last point at which it
   * can be recognised as wrong before the split is computed from it.
   */
  appliedLtvPercent: number | null;
  /** 10^scale for the deal's own pinned currency — never the org's. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    approvedAmountMinor: number;
    basis: ApprovalBasis;
    appraisalId?: string;
    notes?: string;
    /**
     * Set only when the operator answered the departure question.
     *
     * The mutation refuses an outlier without it, so this is the answer being
     * carried to the server rather than a note about what the screen displayed.
     */
    outlierAcknowledged?: boolean;
  }) => void;
};

export function RecordApprovedPurchaseDialog({
  open,
  submitting,
  error,
  appraisal,
  submittedQuotationMinor,
  appliedLtvPercent,
  factor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordApprovedPurchaseDialogProps>) {
  const exceptionAvailable = appraisal !== null && submittedQuotationMinor !== null;
  const [basis, setBasis] = useState<ApprovalBasis>(appraisal ? "APPRAISAL" : "MANUAL");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  /** The departure has been put to the operator and they stood by the figure. */
  const [confirming, setConfirming] = useState(false);

  // Reset on the closed -> open TRANSITION only, for the same reason as the
  // quotation dialog: the evidence behind these options arrives from a live
  // query, and a reset on every change would clear an entry mid-typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setBasis(appraisal ? "APPRAISAL" : "MANUAL");
    setAmount("");
    setNotes("");
    setConfirming(false);
  }, [open, appraisal]);

  // The amount each basis IMPLIES, from evidence the server will check against.
  // `MANUAL` implies nothing, which is why it is the only one that is typed.
  const impliedMinor =
    basis === "APPRAISAL"
      ? (appraisal?.amountMinor ?? null)
      : basis === "QUOTATION_EXCEPTION"
        ? submittedQuotationMinor
        : null;

  const parsed = Number(amount);
  const entered = amount.trim() !== "";
  const amountInvalid = basis === "MANUAL" && entered && !(parsed > 0);
  const typedMinor = entered && parsed > 0 ? Math.round(parsed * factor) : null;
  const approvedMinor = basis === "MANUAL" ? typedMinor : impliedMinor;

  const notesRequired = basis === "MANUAL";
  const notesMissing = notesRequired && notes.trim() === "";

  const canSubmit = approvedMinor !== null && approvedMinor > 0 && !notesMissing && !submitting;

  // Only the typed basis can depart from anything. Under APPRAISAL and
  // QUOTATION_EXCEPTION the amount IS one of the reference figures, so the
  // comparison would be against itself.
  const departure =
    basis === "MANUAL"
      ? approvalDeparture({
          enteredMinor: approvedMinor,
          quotationMinor: submittedQuotationMinor,
          appraisalMinor: appraisal?.amountMinor ?? null,
        })
      : null;

  const submitValues = () =>
    onSubmit({
      approvedAmountMinor: approvedMinor!,
      basis,
      // Named explicitly so the server approves against the appraisal the
      // operator was actually shown, rather than whichever one it would pick
      // for itself.
      appraisalId: basis === "MANUAL" ? undefined : (appraisal?.id ?? undefined),
      // Only from the basis that asks for them. The field is hidden under the
      // other two, so text typed under MANUAL and left behind by a change of
      // basis would be stored against an approval the operator never wrote it
      // for.
      notes: notesRequired ? notes.trim() || undefined : undefined,
      // Sent only when there was a question to answer. Passing it
      // unconditionally would acknowledge a departure nobody was shown, which
      // is the same as not having the guard.
      outlierAcknowledged: departure !== null ? true : undefined,
    });

  const options: Array<{ value: ApprovalBasis; label: string; hint: string; amountMinor: number | null }> =
    [
      ...(appraisal
        ? [
            {
              value: "APPRAISAL" as const,
              label: t("BasisAppraisal"),
              hint: t("BasisAppraisalHint"),
              amountMinor: appraisal.amountMinor,
            },
          ]
        : []),
      ...(exceptionAvailable
        ? [
            {
              value: "QUOTATION_EXCEPTION" as const,
              label: t("BasisQuotationException"),
              hint: t("BasisQuotationExceptionHint"),
              amountMinor: submittedQuotationMinor,
            },
          ]
        : []),
      {
        value: "MANUAL" as const,
        label: t("BasisManual"),
        hint: "",
        amountMinor: null,
      },
    ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RecordApprovedPurchaseTitle")}</DialogTitle>
          <DialogDescription>{t("RecordApprovedPurchaseDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("ApprovalBasisLabel")}</Label>
            {!appraisal && (
              <p className="text-xs text-muted-foreground">{t("NoAppraisalOnFile")}</p>
            )}
            <RadioCardGroup
              ariaLabel={t("ApprovalBasisLabel")}
              value={basis}
              idPrefix="approval-basis"
              // Changing the basis retires the question: only MANUAL can
              // depart from anything, so leaving `confirming` set left the
              // footer offering to confirm an amount nothing was asked about.
              onChange={(next) => {
                setConfirming(false);
                setBasis(next);
              }}
              options={options.map((option) => ({
                value: option.value,
                label: (
                  <>
                    {option.label}
                    {option.amountMinor !== null && (
                      <>
                        {" — "}
                        <bdi className="tabular-nums font-medium">
                          {money(option.amountMinor)}
                        </bdi>
                      </>
                    )}
                  </>
                ),
                hint: option.hint || undefined,
              }))}
            />
          </div>

          {/* Which rate the split below will be computed at — stated before the
              money decision is committed, not discovered in the result. */}
          {appliedLtvPercent !== null && (
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <p>
                {t("DerivedAppliedLtv")}:{" "}
                <bdi className="tabular-nums font-medium">{appliedLtvPercent}%</bdi>
              </p>
              <p>{t("ApprovedPurchaseLtvDrivesSplit")}</p>
            </div>
          )}

          {/* Typed only under MANUAL. Under the other two the amount IS the
              evidence, and an editable copy of it would be an invitation to
              enter something the server is bound to reject. */}
          {basis === "MANUAL" && (
            <div className="space-y-1.5">
              <Label htmlFor="approved-purchase-amount">{t("ApprovedAmountLabel")}</Label>
              <Input
                id="approved-purchase-amount"
                inputMode="decimal"
                value={amount}
                aria-invalid={amountInvalid}
                onChange={(event) => setAmount(event.target.value)}
                className="tabular-nums"
              />
              {amountInvalid && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {t("ApprovedAmountInvalid")}
                </p>
              )}
            </div>
          )}

          {notesRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="approved-purchase-notes">{t("BasisManualNotesLabel")}</Label>
              <Textarea
                id="approved-purchase-notes"
                rows={2}
                value={notes}
                placeholder={t("BasisManualNotesPlaceholder")}
                aria-invalid={notesMissing}
                onChange={(event) => setNotes(event.target.value)}
              />
              {notesMissing && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {t("BasisManualNotesRequired")}
                </p>
              )}
            </div>
          )}

          {/* Put to the operator BEFORE the write, never after. It states the
              figures side by side and asks a question — it does not judge the
              amount, because the number belongs to the finance company and
              AutoFlow is not entitled to refuse it. */}
          {confirming && departure && (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3"
            >
              <p className="text-sm font-medium">{t("ApprovedAmountFarFromEvidence")}</p>
              <dl className="space-y-1 text-sm">
                {departure.quotationMinor !== null && (
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{t("QuotationSubmittedLabel")}</dt>
                    <dd>
                      <bdi className="tabular-nums">{money(departure.quotationMinor)}</bdi>
                    </dd>
                  </div>
                )}
                {departure.appraisalMinor !== null && (
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{t("TheirAppraisalLabel")}</dt>
                    <dd>
                      <bdi className="tabular-nums">{money(departure.appraisalMinor)}</bdi>
                    </dd>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4 font-semibold">
                  <dt>{t("ApprovedAmountYouEntered")}</dt>
                  <dd>
                    <bdi className="tabular-nums">{money(departure.enteredMinor)}</bdi>
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t("ApprovedAmountConfirmPrompt")}
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => (confirming ? setConfirming(false) : onOpenChange(false))}
          >
            {confirming ? t("GoBack") : t("Cancel")}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              // One stop, not a loop: an unremarkable amount submits on the
              // first click exactly as before, and a departure costs one extra
              // deliberate press.
              if (departure && !confirming) {
                setConfirming(true);
                return;
              }
              submitValues();
            }}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Stamp className="h-4 w-4 me-2" />
            )}
            {confirming ? t("ApprovedAmountConfirmAction") : t("RecordApprovedPurchaseAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
