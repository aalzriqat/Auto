"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioCardGroup } from "./RadioCardGroup";
import { isApprovalFarFromEvidence } from "@/lib/financingEconomics";
import { deriveApprovedFinancingFigures, validateApprovedFinancingAmount } from "@/lib/approvedFinancing";
import { parseMajorToMinor } from "@/lib/financeFeeTemplateForm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ApprovalBasis = "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";
export type DeliveredApprovalCorrection = { economicsStamp: string; currentAmountMinor: number };
export type ApprovalSubmission = {
  approvedAmountMinor: number;
  /** SCRUM-613: the finance company's approved financing amount, entered; the funded authority. */
  approvedFinancingAmountMinor: number;
  outlierAcknowledged?: boolean;
} & (
  | {
      kind: "approval";
      basis: ApprovalBasis;
      appraisalId?: string;
      notes?: string;
      deliveredDealCorrection?: never;
    }
  | {
      kind: "deliveredCorrection";
      basis: "MANUAL";
      appraisalId?: never;
      notes: string;
      deliveredDealCorrection: { economicsStamp: string; confirmationReference: string };
    }
);

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
  deliveredApproval?: DeliveredApprovalCorrection | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ApprovalSubmission) => void;
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
  deliveredApproval,
  onOpenChange,
  onSubmit,
}: Readonly<RecordApprovedPurchaseDialogProps>) {
  const exceptionAvailable = appraisal !== null && submittedQuotationMinor !== null;
  const [selectedBasis, setBasis] = useState<ApprovalBasis>(appraisal ? "APPRAISAL" : "MANUAL");
  const basis = deliveredApproval ? "MANUAL" : selectedBasis;
  const [amount, setAmount] = useState("");
  const [financing, setFinancing] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmationReference, setConfirmationReference] = useState("");
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
    setFinancing("");
    setNotes("");
    setConfirmationReference("");
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

  // Exact, never rounded (SCRUM-605) — see the quotation dialog.
  const strict = parseMajorToMinor(amount, Math.round(Math.log10(factor)));
  const entered = amount.trim() !== "";
  const amountTooPrecise = !strict.ok && strict.problem === "TOO_PRECISE";
  const amountInvalid = basis === "MANUAL" && entered && !(strict.ok && strict.minor > 0);
  const typedMinor = strict.ok && strict.minor > 0 ? strict.minor : null;
  const approvedMinor = basis === "MANUAL" ? typedMinor : impliedMinor;

  const notesRequired = basis === "MANUAL";
  const notesMissing = notesRequired && notes.trim() === "";

  const correctionComplete = !deliveredApproval ||
    (confirmationReference.trim() !== "" && approvedMinor !== deliveredApproval.currentAmountMinor);
  // SCRUM-613: the entered approved financing amount is mandatory; the server enforces the same rule.
  const financingParsed = parseMajorToMinor(financing, Math.round(Math.log10(factor)));
  const financingMinor = financingParsed.ok ? financingParsed.minor : null;
  const financingValidity =
    financingMinor === null || approvedMinor === null
      ? { ok: false as const }
      : validateApprovedFinancingAmount(financingMinor, approvedMinor);
  const financingInvalid = financing.trim() !== "" && !financingValidity.ok;
  const financingFigures =
    financingValidity.ok && financingMinor !== null && approvedMinor !== null
      ? {
          percent: deriveApprovedFinancingFigures({
            approvedFinancingMinor: financingMinor,
            approvedPurchaseAmountMinor: approvedMinor,
            quotationMinor: submittedQuotationMinor ?? approvedMinor,
            customerPaysMinor: 0,
          }).percentOfApprovedValue,
        }
      : null;
  const aboveConfiguredLtv =
    financingFigures !== null && appliedLtvPercent !== null && financingFigures.percent > appliedLtvPercent;
  const canSubmit =
    approvedMinor !== null && approvedMinor > 0 && financingValidity.ok && !notesMissing && correctionComplete && !submitting;

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

  const submitValues = () => {
    if (approvedMinor === null || financingMinor === null) return;
    const amountFields = {
      approvedAmountMinor: approvedMinor,
      approvedFinancingAmountMinor: financingMinor,
      // Set only after the operator answered the amount warning.
      outlierAcknowledged: departure !== null ? true : undefined,
    };
    if (deliveredApproval) {
      onSubmit({
        ...amountFields,
        kind: "deliveredCorrection",
        basis: "MANUAL",
        notes: notes.trim(),
        deliveredDealCorrection: {
          economicsStamp: deliveredApproval.economicsStamp,
          confirmationReference: confirmationReference.trim(),
        },
      });
      return;
    }
    onSubmit({
      ...amountFields,
      kind: "approval",
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
    });
  };

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
          <DialogTitle>{t(deliveredApproval ? "CorrectDeliveredApprovalAction" : "RecordApprovedPurchaseTitle")}</DialogTitle>
          <DialogDescription>{t(deliveredApproval ? "CorrectDeliveredApprovalDesc" : "RecordApprovedPurchaseDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {deliveredApproval ? (
            <p className="text-sm text-muted-foreground">
              {t("CurrentApprovedAmountLabel")} <bdi>{money(deliveredApproval.currentAmountMinor)}</bdi>
            </p>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("ApprovalBasisLabel")}</Label>
              {!appraisal && (
                <p className="text-xs text-muted-foreground">{t("NoAppraisalOnFile")}</p>
              )}
              <RadioCardGroup
                ariaLabel={t("ApprovalBasisLabel")}
                value={basis}
                idPrefix="approval-basis"
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
          )}

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
                  {t(amountTooPrecise ? "AmountTooPrecise" : "ApprovedAmountInvalid")}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="approved-financing-amount">{t("ApprovedFinancingAmountLabel")}</Label>
            <Input
              id="approved-financing-amount"
              inputMode="decimal"
              value={financing}
              aria-invalid={financingInvalid}
              onChange={(event) => setFinancing(event.target.value)}
              className="tabular-nums"
            />
            {financingInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("ApprovedFinancingAmountInvalid")}
              </p>
            )}
            {financingFigures !== null && (
              <p className="text-xs text-muted-foreground">
                {t("ApprovedFinancingDerivedPercent")}:{" "}
                <bdi className="tabular-nums font-medium">{financingFigures.percent.toFixed(2)}%</bdi>
              </p>
            )}
            {aboveConfiguredLtv && (
              <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
                {t("ApprovedFinancingAboveConfiguredLtv")}
              </p>
            )}
          </div>

          {notesRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="approved-purchase-notes">{t(deliveredApproval ? "ReopenApprovalReasonLabel" : "BasisManualNotesLabel")}</Label>
              <Textarea
                id="approved-purchase-notes"
                rows={2}
                maxLength={deliveredApproval ? 1000 : undefined}
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

          {deliveredApproval && (
            <div className="space-y-1.5">
              <Label htmlFor="delivered-approval-reference">{t("DeliveredApprovalReferenceLabel")}</Label>
              <Input
                id="delivered-approval-reference"
                maxLength={160}
                value={confirmationReference}
                onChange={(event) => setConfirmationReference(event.target.value)}
              />
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
            // dir="auto": a server refusal can arrive in English inside the RTL dialog (SCRUM-628 F-24).
            <p role="alert" dir="auto" className="text-sm font-medium text-destructive">
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
            {t(confirming ? "ApprovedAmountConfirmAction" : deliveredApproval ? "CorrectDeliveredApprovalAction" : "RecordApprovedPurchaseAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
