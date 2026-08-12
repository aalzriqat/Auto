"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 * Records the quotation the dealership SENT the finance company.
 *
 * The provenance label — `SYSTEM_CALCULATED`, `CALCULATED_WITH_OVERRIDE`,
 * `MANUAL_ENTRY` — is derived from what the operator actually did rather than
 * asked for as a dropdown. That is not a convenience: the server refuses a
 * `SYSTEM_CALCULATED` figure that does not equal the solver's, refuses an
 * "override" that matches it exactly, and refuses either calculated label when
 * the solver never ran. A picker would let an operator choose a label the server
 * will reject, with an error naming a rule they were never shown. Here the label
 * follows the amount: same figure as the calculation → calculated; different →
 * an override, which then demands its reason; no calculation available at all →
 * manual, which is the honest label for a negotiated number.
 */
type RecordSubmittedQuotationDialogProps = {
  open: boolean;
  submitting: boolean;
  /**
   * The server's refusal, rendered in the form rather than only as a toast.
   *
   * Every refusal this mutation raises names the figure or the rule to fix, and
   * a toast that has already faded is not a recovery path for a form the
   * operator is still looking at.
   */
  error: string | null;
  /** The solver's figure in MINOR units, or null when it could not run. */
  calculatedMinor: number | null;
  /** 10^scale for the deal's own pinned currency — never the org's. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    submittedQuotationMinor: number;
    source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
    overrideReason?: string;
  }) => void;
};

export function RecordSubmittedQuotationDialog({
  open,
  submitting,
  error,
  calculatedMinor,
  factor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordSubmittedQuotationDialogProps>) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  // Reset on the closed -> open TRANSITION only. `calculatedMinor` comes from a
  // live query, so resetting whenever it changed would wipe what the operator
  // had typed off the paperwork mid-entry.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setAmount("");
    setReason("");
  }, [open]);

  const parsed = Number(amount);
  const entered = amount.trim() !== "";
  // `!(x > 0)` rather than `x <= 0`: they differ on NaN, and a non-numeric entry
  // must count as invalid. `NaN <= 0` is false, which would let it through.
  const amountInvalid = entered && !(parsed > 0);
  const enteredMinor = entered && parsed > 0 ? Math.round(parsed * factor) : null;

  const hasCalculation = calculatedMinor !== null;
  const matchesCalculation = hasCalculation && enteredMinor === calculatedMinor;
  const source = !hasCalculation
    ? ("MANUAL_ENTRY" as const)
    : matchesCalculation
      ? ("SYSTEM_CALCULATED" as const)
      : ("CALCULATED_WITH_OVERRIDE" as const);
  const reasonRequired = source === "CALCULATED_WITH_OVERRIDE";
  const reasonMissing = reasonRequired && reason.trim() === "";

  const canSubmit = enteredMinor !== null && !reasonMissing && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RecordQuotationTitle")}</DialogTitle>
          <DialogDescription>{t("RecordQuotationDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="submitted-quotation-amount">{t("QuotationAmountLabel")}</Label>
            <Input
              id="submitted-quotation-amount"
              inputMode="decimal"
              value={amount}
              aria-invalid={amountInvalid}
              onChange={(event) => setAmount(event.target.value)}
              className="tabular-nums"
            />
            {amountInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("QuotationAmountInvalid")}
              </p>
            )}

            {/* The calculation is offered, never imposed. It is a suggestion
                about a document that has already been sent, so the amount that
                was actually sent always wins — the operator copies the figure in
                with one press if it matches, and departs from it with a reason
                if it does not. */}
            {calculatedMinor !== null ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs text-muted-foreground">
                <span>
                  {t("QuotationCalculatedLabel")}:{" "}
                  <bdi className="tabular-nums font-medium">{money(calculatedMinor)}</bdi>
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setAmount(String(calculatedMinor / factor))}
                >
                  {t("QuotationUseCalculated")}
                </Button>
              </div>
            ) : (
              <p className="pt-0.5 text-xs text-muted-foreground">
                {t("QuotationCalculatorUnavailable")}
              </p>
            )}

            {/* What the record will say about where this figure came from,
                stated before it is written rather than discovered afterwards in
                an audit row. */}
            {enteredMinor !== null && hasCalculation && (
              <p className="text-xs text-muted-foreground">
                {matchesCalculation
                  ? t("QuotationMatchesCalculation")
                  : t("QuotationDiffersFromCalculation")}
              </p>
            )}
          </div>

          {reasonRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="submitted-quotation-reason">
                {t("QuotationOverrideReasonLabel")}
              </Label>
              <Textarea
                id="submitted-quotation-reason"
                rows={2}
                value={reason}
                placeholder={t("QuotationOverrideReasonPlaceholder")}
                aria-invalid={reasonMissing}
                onChange={(event) => setReason(event.target.value)}
              />
              {reasonMissing && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {t("QuotationOverrideReasonRequired")}
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
                submittedQuotationMinor: enteredMinor!,
                source,
                overrideReason: reasonRequired ? reason.trim() : undefined,
              })
            }
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4 me-2" />
            )}
            {t("RecordQuotationAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
