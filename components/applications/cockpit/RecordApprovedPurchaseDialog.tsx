"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ApprovalBasis = "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";

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
  }) => void;
};

export function RecordApprovedPurchaseDialog({
  open,
  submitting,
  error,
  appraisal,
  submittedQuotationMinor,
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
            {/* A radio group built from buttons rather than pulling in a radix
                primitive this project does not have. `role="radio"` +
                `aria-checked` keeps it a real radio group for assistive
                technology and for keyboard users, and each option carries the
                amount it implies so the choice is made against the figure it
                will record. */}
            <div role="radiogroup" aria-label={t("ApprovalBasisLabel")} className="space-y-2">
              {options.map((option) => {
                const selected = basis === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setBasis(option.value)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md border p-3 text-start transition-colors",
                      selected ? "border-primary bg-primary/[0.06]" : "hover:bg-muted/60"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-primary bg-primary text-primary-foreground" : ""
                      )}
                      aria-hidden
                    >
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm leading-snug">
                        {option.label}
                        {option.amountMinor !== null && (
                          <>
                            {" — "}
                            <bdi className="tabular-nums font-medium">
                              {money(option.amountMinor)}
                            </bdi>
                          </>
                        )}
                      </span>
                      {option.hint && (
                        <span className="block text-xs text-muted-foreground">{option.hint}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

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
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                approvedAmountMinor: approvedMinor!,
                basis,
                // Named explicitly so the server approves against the appraisal
                // the operator was actually shown, rather than whichever one it
                // would pick for itself.
                appraisalId: basis === "MANUAL" ? undefined : (appraisal?.id ?? undefined),
                // Only from the basis that asks for them. The field is hidden
                // under the other two, so text typed under MANUAL and left
                // behind by a change of basis would be stored against an
                // approval the operator never wrote it for.
                // Only from the basis that asks for them. The field is hidden
                // under the other two, so text typed under MANUAL and left
                // behind by a change of basis would be stored against an
                // approval the operator never wrote it for.
                notes: notesRequired ? notes.trim() || undefined : undefined,
              })
            }
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Stamp className="h-4 w-4 me-2" />
            )}
            {t("RecordApprovedPurchaseAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
