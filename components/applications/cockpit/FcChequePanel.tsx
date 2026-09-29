"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { Input } from "@/components/ui/input";
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
 * SCRUM-447 D6 — the finance-company cheque's own actions on a deal.
 *
 * Presentational: the workflow facts arrive as flags the SERVER computed
 * (no amounts), and the three actions arrive as handlers. Nothing here decides
 * whether a cheque may be corrected or attested — the server refuses what it
 * must, and this only hides what the caller can never do (MANAGE_FINANCE).
 *
 *   - face unrecorded on a legacy cheque  -> attest the face
 *   - a cheque payment is registered      -> correct it (withdraws the open row)
 *   - closed deal, nothing registered     -> register it again
 */
export type FcChequePanelProps = {
  /** MANAGE_FINANCE. Without it the notices still show, the actions do not. */
  canManage: boolean;
  /**
   * REGISTER_EXPECTED_PAYMENT. On a closed, undisbursed deal the server accepts
   * registration from this OR MANAGE_FINANCE, so either one offers the action.
   */
  canRegisterPayment: boolean;
  /** A returned/cancelled cheque needs its expected payment corrected. */
  needsCorrection: boolean;
  /** The face was attested by a finance manager (not read from the receipt). */
  chequeFaceAttested: boolean;
  chequeFaceUnrecorded: boolean;
  unattestedChequeId: string | null;
  expectedPaymentCorrectable: boolean;
  chequePaymentRegistered: boolean;
  /** The deal is CLOSED, not disbursed, and no expected payment is on file. */
  needsReRegistration: boolean;
  t: (key: string) => string;
  onAttest: (faceAmount: string, note: string) => Promise<void>;
  onCorrect: (reason: string) => Promise<void>;
  onRegister: () => void;
};

const DECIMAL = /^\d+(\.\d+)?$/;

/** 44px on a phone (thumb target), the compact `sm` height from `sm:` up. */
const ACTION_SIZE = "h-11 w-full sm:h-8 sm:w-auto";

export function FcChequePanel({
  canManage,
  canRegisterPayment,
  needsCorrection,
  chequeFaceAttested,
  chequeFaceUnrecorded,
  unattestedChequeId,
  expectedPaymentCorrectable,
  chequePaymentRegistered,
  needsReRegistration,
  t,
  onAttest,
  onCorrect,
  onRegister,
}: Readonly<FcChequePanelProps>) {
  const [dialog, setDialog] = useState<"attest" | "correct" | null>(null);
  const [face, setFace] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAttest =
    canManage && chequeFaceUnrecorded && unattestedChequeId !== null;
  const canCorrect =
    canManage && expectedPaymentCorrectable && chequePaymentRegistered;
  const canRegister = (canManage || canRegisterPayment) && needsReRegistration;
  const showNotice =
    chequeFaceUnrecorded || needsReRegistration || needsCorrection;
  if (!showNotice && !canCorrect) return null;

  // B2: when the viewer lacks the permission for the step the deal is waiting
  // on, say who acts instead of leaving a notice with nothing to press.
  let reasonKey: string | null = null;
  if (chequeFaceUnrecorded && !canManage) reasonKey = "FcNeedsFinanceAttest";
  else if (needsReRegistration && !canRegister)
    reasonKey = "FcNeedsRegisterPermission";
  else if (needsCorrection && !canManage) reasonKey = "FcNeedsFinanceCorrect";

  const close = () => {
    setDialog(null);
    setFace("");
    setReason("");
    setNote("");
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (dialog === "attest") await onAttest(face.trim(), note.trim());
      else await onCorrect(reason.trim());
      close();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const attestValid = DECIMAL.test(face.trim()) && note.trim().length > 0;
  const correctValid = reason.trim().length > 0;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30"
      data-testid="deal-fc-cheque-panel"
    >
      <div className="flex min-w-0 items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
        {showNotice && (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="min-w-0">
            {chequeFaceUnrecorded
              ? t("FcChequeFaceUnrecordedNotice")
              : needsReRegistration
                ? t("FcReRegisterNotice")
                : needsCorrection
                  ? t("FcCorrectNeededNotice")
                  : t("FcChequeRegisteredNote")}
            {chequeFaceAttested && (
              <span className="ms-2 inline-flex items-center rounded-sm border border-amber-400/70 px-1.5 py-0.5 text-xs font-medium">
                {t("FcFaceAttestedBadge")}
              </span>
            )}
          </p>
          {reasonKey && (
            <p
              className="mt-1 min-w-0 text-xs font-medium opacity-90"
              data-testid="fc-reason-line"
            >
              {t(reasonKey)}
            </p>
          )}
        </div>
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
        {canAttest && (
          <Button
            size="sm"
            className={ACTION_SIZE}
            onClick={() => setDialog("attest")}
          >
            {t("FcAttestChequeFace")}
          </Button>
        )}
        {canCorrect && (
          <Button
            size="sm"
            variant="outline"
            className={ACTION_SIZE}
            onClick={() => setDialog("correct")}
          >
            {t("FcCorrectExpectedPayment")}
          </Button>
        )}
        {canRegister && (
          <Button size="sm" className={ACTION_SIZE} onClick={onRegister}>
            {t("RegisterExpectedPayment")}
          </Button>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog === "attest"
                ? t("FcAttestChequeFace")
                : t("FcCorrectExpectedPayment")}
            </DialogTitle>
            <DialogDescription>
              {dialog === "attest"
                ? t("FcAttestChequeFaceDesc")
                : t("FcCorrectExpectedPaymentDesc")}
            </DialogDescription>
          </DialogHeader>
          {dialog === "attest" ? (
            <div className="space-y-1">
              <label htmlFor="fc-face" className="text-sm font-medium">
                {t("FcChequeFaceLabel")}
              </label>
              <Input
                id="fc-face"
                value={face}
                inputMode="decimal"
                dir="ltr"
                className="h-11 sm:h-9 rtl:text-end"
                autoComplete="off"
                onChange={(event) => setFace(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("FcChequeFaceHelp")}
              </p>
              <label
                htmlFor="fc-note"
                className="block pt-2 text-sm font-medium"
              >
                {t("FcAttestNoteLabel")}
              </label>
              <Textarea
                id="fc-note"
                value={note}
                maxLength={500}
                placeholder={t("FcAttestNotePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor="fc-reason" className="text-sm font-medium">
                {t("FcCorrectReasonLabel")}
              </label>
              <Textarea
                id="fc-reason"
                value={reason}
                placeholder={t("FcCorrectReasonPlaceholder")}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              onClick={close}
            >
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              className="h-11 sm:h-9"
              disabled={
                submitting ||
                (dialog === "attest" ? !attestValid : !correctValid)
              }
              onClick={() => void submit()}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("Confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
