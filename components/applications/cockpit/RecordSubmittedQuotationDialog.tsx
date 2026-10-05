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
import { parseMajorToMinor } from "@/lib/financeFeeTemplateForm";

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
/**
 * What the calculator has to say — three states, never two.
 *
 * Collapsing "still loading" into "no calculation exists" is not a cosmetic
 * simplification: the dialog labels a figure `MANUAL_ENTRY` when no calculation
 * stands behind it, so a suggestion that had merely not arrived yet would let an
 * operator record a solver-divergent amount with no override reason and the
 * wrong provenance on the audit record.
 */
export type QuotationCalculation =
  | { state: "LOADING" }
  /**
   * `reason` is the server's, when it gave one. The dialog names the ones the
   * operator can act on (SCRUM-681) and keeps the generic line for the rest.
   */
  | { state: "UNAVAILABLE"; reason?: string }
  /** The solver's figure, in MINOR units. */
  | { state: "AVAILABLE"; minor: number };

/** The calculator's answer as the dialog reads it, from the cockpit's query. */
export function toQuotationCalculation(
  canOfferQuotation: boolean,
  suggestion:
    | { available: true; submittedQuotationMinor: number }
    | { available: false; reason: string }
    | undefined
): QuotationCalculation {
  if (!canOfferQuotation) return { state: "UNAVAILABLE" };
  if (suggestion === undefined) return { state: "LOADING" };
  return suggestion.available
    ? { state: "AVAILABLE", minor: suggestion.submittedQuotationMinor }
    : { state: "UNAVAILABLE", reason: suggestion.reason };
}

/** Reasons the operator can do something about, each with its own note. */
const UNAVAILABLE_REASON_KEYS: ReadonlyMap<string, string> = new Map([
  ["OFFSET_RULE_UNKNOWN", "QuotationUnavailableOffsetRuleUnknown"],
  ["OFFSET_RULE_DOES_NOT_APPLY", "QuotationUnavailableOffsetRuleDoesNotApply"],
  ["NO_TARGET_RECORDED", "QuotationUnavailableNoTarget"],
]);

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
  /** What the calculator has to say — including "not yet arrived". */
  calculation: QuotationCalculation;
  /**
   * This deal's own rule snapshot carries no purchase LTV, so the operator has
   * to name the rate that applies to it.
   *
   * The snapshot is frozen at application creation and is never re-read, so
   * adding the rate to the finance company in settings repairs FUTURE deals and
   * cannot repair this one. `recordSubmittedQuotation` takes an explicit
   * `ltvPercent` for exactly this: the deal moves without anyone rewriting the
   * immutable rules it was created under.
   */
  requiresLtvPercent: boolean;
  /**
   * Whether this caller may SET that rate — `approve:finance_application` AND
   * `view:finance`, the pair `recordSubmittedQuotation` checks before it will
   * accept an explicit `ltvPercent` (SCRUM-117, owner-proxy ruling 2026-09-13
   * 15:33). Approval authority alone is no longer enough: a default MANAGER
   * holds it without finance visibility and is refused.
   *
   * Separate from `requiresLtvPercent` because they answer different questions:
   * one is about the deal, the other about the person. Recording the quotation
   * is a transcription and the SALES template may do it; naming the rate the
   * deal is financed at moves the dealership's own contribution, so the server
   * refuses it from anyone without both permissions. Rendering the field to a
   * caller whose entry will be refused is the shape this dialog exists to avoid
   * — the field is replaced by who to ask instead.
   */
  canSetLtvPercent: boolean;
  /** 10^scale for the deal's own pinned currency — never the org's. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    submittedQuotationMinor: number;
    source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
    overrideReason?: string;
    /** The rate for THIS deal, when its own rules carry none. */
    ltvPercent?: number;
  }) => void;
};

export function RecordSubmittedQuotationDialog({
  open,
  submitting,
  error,
  calculation,
  requiresLtvPercent,
  canSetLtvPercent,
  factor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordSubmittedQuotationDialogProps>) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [ltvPercent, setLtvPercent] = useState("");

  /**
   * Whether the operator has touched the amount since the dialog opened.
   *
   * The prefill below is allowed to write the field exactly while this is
   * false. "Pristine" is about the OPERATOR, not the value: a field they typed
   * into and then emptied is theirs, and a calculation landing afterwards must
   * not refill it any more than it may overwrite a figure they are still
   * typing (SCRUM-321).
   */
  const touchedRef = useRef(false);
  const amountInputRef = useRef<HTMLInputElement>(null);
  /** The calculation already offered into the field this opening — a one-shot. */
  const prefilledRef = useRef(false);

  // Reset on the closed -> open TRANSITION only. `calculatedMinor` comes from a
  // live query, so resetting whenever it changed would wipe what the operator
  // had typed off the paperwork mid-entry.
  //
  // When the calculation is already AVAILABLE at that transition, the amount
  // opens carrying it: the sent quotation is the calculated figure on the
  // ordinary deal, and an empty box with a "use calculated" link made the
  // operator retype (or mis-type) what AutoFlow already knew. Opening never
  // records anything; the explicit Record press below still does.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    touchedRef.current = false;
    const initial = calculation.state === "AVAILABLE" ? String(calculation.minor / factor) : "";
    prefilledRef.current = initial !== "";
    setAmount(initial);
    setReason("");
    setLtvPercent("");
    // Deliberately only `open`: the calculation is read at the moment of
    // opening; a figure arriving LATER is handled by the one-shot effect below,
    // and a figure CHANGING later must not move what the operator is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The calculation arrived after the dialog opened. Fill the field ONCE, and
  // only if the operator has not touched it — their typing, or their choice to
  // leave it empty, always wins over a suggestion that came second.
  useEffect(() => {
    if (!open || prefilledRef.current || touchedRef.current) return;
    if (calculation.state !== "AVAILABLE") return;
    // SCRUM-607: an operator already in the field is about to type their own
    // figure; a prefill landing now would put the caret after it and the first
    // keystrokes would be appended to the calculated number. The offer is
    // not lost: onBlur below makes it if the operator leaves the field empty.
    if (amountInputRef.current && document.activeElement === amountInputRef.current) return;
    prefilledRef.current = true;
    // This is the deliberate handoff from an asynchronously arriving server
    // suggestion into a controlled input; the touched guard prevents it from
    // becoming a props-to-state synchronization loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAmount(String(calculation.minor / factor));
  }, [open, calculation, factor]);

  // Exact, never rounded (SCRUM-605): "21428.57213000" once rounded to the
  // calculated 21428.572 and went on the record as SYSTEM_CALCULATED — a figure
  // the operator never typed, under a provenance they never claimed.
  const strict = parseMajorToMinor(amount, Math.round(Math.log10(factor)));
  const entered = amount.trim() !== "";
  const amountTooPrecise = !strict.ok && strict.problem === "TOO_PRECISE";
  const amountInvalid = entered && !(strict.ok && strict.minor > 0);
  const enteredMinor = strict.ok && strict.minor > 0 ? strict.minor : null;

  const calculatedMinor = calculation.state === "AVAILABLE" ? calculation.minor : null;
  const hasCalculation = calculatedMinor !== null;
  const matchesCalculation = hasCalculation && enteredMinor === calculatedMinor;
  const source = !hasCalculation
    ? ("MANUAL_ENTRY" as const)
    : matchesCalculation
      ? ("SYSTEM_CALCULATED" as const)
      : ("CALCULATED_WITH_OVERRIDE" as const);
  // Only once an amount exists. With a calculation on file and the field still
  // empty, `enteredMinor` is null and therefore does not match it — so the
  // source read as an override and the form demanded a reason, in red, before
  // the operator had typed anything at all.
  const reasonRequired = enteredMinor !== null && source === "CALCULATED_WITH_OVERRIDE";
  const reasonMissing = reasonRequired && reason.trim() === "";

  // Nothing may be submitted while the calculator is still answering. Every
  // figure entered in that window would be labelled MANUAL_ENTRY — a claim
  // about provenance, not a description of the wait — and a solver-divergent
  // amount would go on the record with no override reason behind it.
  const parsedLtv = Number(ltvPercent);
  const ltvEntered = ltvPercent.trim() !== "";
  // The server's own bounds: greater than zero, at most 100, and inside
  // whatever the snapshot allows. The first two are checked here so the button
  // does not sit dead; the snapshot bounds stay the server's to enforce.
  const ltvInvalid = ltvEntered && !(parsedLtv > 0 && parsedLtv <= 100);
  // A caller who may not set the rate can never satisfy this, which is the
  // point: the deal is blocked on someone else, and the button says so by
  // staying disabled under a note naming who.
  const ltvMissing = requiresLtvPercent && !ltvEntered;

  const canSubmit =
    enteredMinor !== null &&
    !reasonMissing &&
    !submitting &&
    calculation.state !== "LOADING" &&
    !ltvMissing &&
    !ltvInvalid;

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
              ref={amountInputRef}
              onBlur={() => {
                if (prefilledRef.current || touchedRef.current || amount !== "") return;
                if (calculation.state !== "AVAILABLE") return;
                prefilledRef.current = true;
                setAmount(String(calculation.minor / factor));
              }}
              inputMode="decimal"
              value={amount}
              aria-invalid={amountInvalid}
              onChange={(event) => {
                touchedRef.current = true;
                setAmount(event.target.value);
              }}
              className="tabular-nums"
            />
            {amountInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t(amountTooPrecise ? "AmountTooPrecise" : "QuotationAmountInvalid")}
              </p>
            )}

            {/* The calculation is offered, never imposed. It is a suggestion
                about a document that has already been sent, so the amount that
                was actually sent always wins — the operator copies the figure in
                with one press if it matches, and departs from it with a reason
                if it does not. */}
            {calculation.state === "LOADING" ? (
              <p className="pt-0.5 text-xs text-muted-foreground">
                {t("QuotationCalculatorLoading")}
              </p>
            ) : calculatedMinor !== null ? (
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
                  onClick={() => {
                    // An operator's choice, like typing: once they have asked
                    // for the calculated figure, the one-shot prefill must not
                    // move the field again if the calculation changes underneath.
                    touchedRef.current = true;
                    setAmount(String(calculatedMinor / factor));
                  }}
                >
                  {t("QuotationUseCalculated")}
                </Button>
              </div>
            ) : (
              <p className="pt-0.5 text-xs text-muted-foreground">
                {t(
                  (calculation.state === "UNAVAILABLE" &&
                    calculation.reason !== undefined &&
                    UNAVAILABLE_REASON_KEYS.get(calculation.reason)) ||
                    "QuotationCalculatorUnavailable"
                )}
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

          {requiresLtvPercent && !canSetLtvPercent && (
            <p className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
              {t("DealPurchaseLtvNeedsApprover")}
            </p>
          )}

          {requiresLtvPercent && canSetLtvPercent && (
            <div className="space-y-1.5">
              <Label htmlFor="submitted-quotation-ltv">{t("DealPurchaseLtvLabel")}</Label>
              <Input
                id="submitted-quotation-ltv"
                inputMode="decimal"
                value={ltvPercent}
                aria-invalid={ltvInvalid}
                onChange={(event) => setLtvPercent(event.target.value)}
                className="tabular-nums"
              />
              {ltvInvalid && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {t("DealPurchaseLtvInvalid")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t("DealPurchaseLtvHint")}</p>
            </div>
          )}

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
                // Only where this deal has no rate of its own. Sending one
                // otherwise would override the company's rules for a deal that
                // has them, which is a different decision than the operator
                // was asked to make.
                ltvPercent: requiresLtvPercent && ltvEntered ? parsedLtv : undefined,
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
