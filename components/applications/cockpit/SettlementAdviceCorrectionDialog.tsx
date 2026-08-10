"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { dateInputToUtcMs, msToDateInput, todayDateInput } from "@/lib/dateInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Correcting a settlement advice that was transcribed wrongly.
 *
 * The dealership holds two records of one payment and they disagree: what the
 * finance company was approved to pay the supplier, and what its advice says it
 * paid. This dialog corrects the SECOND one — the dealership's transcription of
 * somebody else's document — and nothing else.
 *
 * It deliberately offers no way to change the approved amount, and says so.
 * That figure is the frozen basis the supplier's debt, the agency revenue, the
 * salesperson's commission and the reports were all measured from; moving it
 * here would restate four things without touching any of them. If the approval
 * itself was wrong, that is a financial correction against a closed sale, not a
 * form field.
 *
 * Deliberately NOT modelled on `SupplierSettlementDialog`, which records money
 * ARRIVING and posts a journal. This posts nothing. The two dialogs look alike
 * and mean opposite things, so this one leads with the discrepancy rather than
 * with an amount box, and its primary action is worded as a correction.
 */
type SettlementAdviceCorrectionDialogProps = {
  open: boolean;
  submitting: boolean;
  /** What the advice currently says, in MAJOR units — the value being corrected. */
  recordedMajor: number | null;
  /**
   * The rest of what is on file. Prefilled so a correction to one field does
   * not submit blanks over the other two — this form previously opened with an
   * empty reference and today's date, and an amount-only correction therefore
   * erased the cheque number and moved the payment date.
   */
  recordedReference: string | null;
  recordedAt: number | null;
  /** What the deal was approved at, for the operator to check against. Read-only. */
  approvedLabel: string;
  recordedLabel: string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onCorrect: (correction: {
    amountMajor: number;
    reference?: string;
    /**
     * The operator emptied a reference that was on file.
     *
     * Distinct from omitting `reference`, which means "not part of this
     * correction". Both used to arrive as `undefined`, so clearing a wrongly
     * transcribed cheque number reported success and changed nothing.
     */
    clearReference?: boolean;
    disbursedAt?: number;
    reason: string;
  }) => void;
};

/** Mirrors the server's minimum. Rejecting on the server alone makes the
 *  operator type a reason twice to find out it was too short. */
const MIN_REASON_LENGTH = 10;

export function SettlementAdviceCorrectionDialog({
  open,
  submitting,
  recordedMajor,
  recordedReference,
  recordedAt,
  approvedLabel,
  recordedLabel,
  t,
  onOpenChange,
  onCorrect,
}: Readonly<SettlementAdviceCorrectionDialogProps>) {
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [reason, setReason] = useState("");
  /**
   * What the date field was seeded with, so an untouched date can be told from
   * a deliberately re-entered one.
   *
   * This control is date-ONLY. The recorded instant comes in through
   * `msToDateInput`, which keeps the UTC calendar date and drops the time, and
   * would go back out through `dateInputToUtcMs`, which is documented to
   * produce UTC midnight. There is no round trip that preserves 14:32:17.456,
   * so the form does not attempt one — it reports "the date was not part of
   * this correction" by sending nothing, and the server keeps the instant it
   * already holds. Comparing against the seed rather than tracking a "touched"
   * flag also covers the operator who edits the date and then puts it back.
   */
  const seededPaidOnRef = useRef("");

  // Reset on the closed -> open TRANSITION only. The recorded figure comes from
  // a live query, and re-seeding whenever it changed would wipe what the
  // operator had typed off the advice mid-entry.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    // Prefilled with what is currently recorded, because this is a correction
    // of that value and not a fresh entry — the operator is usually changing
    // one digit, and making them retype the whole figure invites a second
    // transcription error on top of the first.
    setAmount(recordedMajor === null ? "" : String(recordedMajor));
    // Seeded from what is on file, not blanked. Every field here is submitted
    // on every save, so an empty reference and today's date were not "no
    // change" — they were an instruction to erase a cheque number and restate
    // when the supplier was paid, issued by an operator who only touched the
    // amount. Today's date is the fallback only when nothing is recorded.
    setReference(recordedReference ?? "");
    const seededPaidOn = recordedAt !== null ? msToDateInput(recordedAt) : todayDateInput();
    seededPaidOnRef.current = seededPaidOn;
    setPaidOn(seededPaidOn);
    setReason("");
  }, [open, recordedMajor, recordedReference, recordedAt]);

  const amountValue = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(amountValue) && amountValue > 0;
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit = amountValid && reasonValid && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileWarning className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            {t("CorrectSettlementAdvice")}
          </DialogTitle>
          <DialogDescription>{t("CorrectSettlementAdviceDescription")}</DialogDescription>
        </DialogHeader>

        {/* The two records, restated inside the dialog. The operator is about to
            change one of them and needs the other in front of them while they
            do it — sending them back to the page to check is how the wrong one
            gets edited. */}
        <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs text-muted-foreground">{t("SettlementAdviceRecorded")}</dt>
            <dd className="font-medium">
              <bdi className="tabular-nums">{recordedLabel}</bdi>
            </dd>
          </div>
          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs text-muted-foreground">{t("SettlementAdviceApproved")}</dt>
            <dd className="font-medium">
              <bdi className="tabular-nums">{approvedLabel}</bdi>
            </dd>
          </div>
        </dl>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="advice-amount">{t("SettlementAdviceAmountLabel")}</Label>
            <Input
              id="advice-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="advice-reference">{t("SettlementAdviceReferenceLabel")}</Label>
              <Input
                id="advice-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advice-date">{t("SettlementAdviceDateLabel")}</Label>
              <Input
                id="advice-date"
                type="date"
                value={paidOn}
                max={todayDateInput()}
                onChange={(event) => setPaidOn(event.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="advice-reason">{t("SettlementAdviceReasonLabel")}</Label>
            <Textarea
              id="advice-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("SettlementAdviceReasonPlaceholder")}
              disabled={submitting}
              aria-describedby="advice-reason-note"
            />
            {/* Stated as the reason it is required rather than as a character
                count. An amendment with no account of itself is
                indistinguishable from someone making the discrepancy go away. */}
            <p id="advice-reason-note" className="text-xs text-muted-foreground">
              {t("SettlementAdviceReasonNote")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() =>
              onCorrect({
                amountMajor: amountValue,
                reference: reference.trim() || undefined,
                // Emptying a field that had something in it is an instruction,
                // and it has to be told apart from silence — the server treats
                // an absent reference as "leave it alone", which is what keeps
                // an amount-only correction from erasing the cheque number.
                clearReference:
                  reference.trim() === "" && (recordedReference ?? "") !== ""
                    ? true
                    : undefined,
                // Sent only when the operator actually moved the date. See
                // `seededPaidOnRef`: an unchanged date has no lossless
                // representation here, so omitting it is what preserves the
                // recorded instant to the millisecond.
                //
                // TODAY becomes the current instant rather than UTC midnight,
                // because only this side knows the operator's local day. East
                // of UTC, UTC-midnight-of-today is still in the FUTURE for the
                // first hours of the morning — until 03:00 in Amman — and the
                // server refuses a future disbursement date, so the form was
                // offering a date its own backend would reject. On the only
                // route out of REQUIRES_RECONCILIATION that meant the deal
                // could not be corrected before 03:00. The server cannot fix
                // this: it has no way to know the caller's offset.
                //
                // Any OTHER day is sent as chosen. Clamping a backdated entry
                // to `Date.now()` would file the advice under a date the
                // operator never entered, on the record whose entire job is to
                // state what somebody else's document said.
                //
                // `DisbursementConfirmationDialog` and `SupplierSettlementDialog`
                // both carry this branch already; this dialog was written
                // without it.
                disbursedAt:
                  paidOn && paidOn !== seededPaidOnRef.current
                    ? paidOn === todayDateInput()
                      ? Date.now()
                      : dateInputToUtcMs(paidOn)
                    : undefined,
                reason: reason.trim(),
              })
            }
            disabled={!canSubmit}
          >
            {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
            {t("SaveCorrection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
