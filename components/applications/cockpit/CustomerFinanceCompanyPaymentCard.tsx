"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parseMajorToMinor } from "@/lib/financeFeeTemplateForm";
import { economicDateInputToMs, economicTodayDateInput, msToDateInput } from "@/lib/dateInput";
import { evidenceTimeInMs, PaymentEvidenceTimeInput, usePaymentEvidenceClock, type EvidenceTime } from "./PaymentEvidenceTimeInput";

/**
 * SCRUM-766 PR-B - the evidence that the customer paid the finance company.
 *
 * What the customer AGREED to pay the finance company is a promise; only a
 * confirmed payment lowers the dealership's contribution, and the deal cannot
 * close while any of the creditable agreement is unconfirmed. This card shows
 * the numbers side by side so the screen never reads an agreement as money, and
 * offers the two commands the server accepts: confirm a payment (amount, date,
 * reference) and take a confirmation back (with a reason). Both are refused on
 * the server for a closed deal and for the deal's own salesperson; the card
 * withdraws the buttons for the same cases rather than offering a refusal.
 *
 * `awaitingMinor` is the server's stored balance, not `agreed - confirmed`: the
 * agreement can exceed what is creditable, and the card, the closing gate and
 * the confirm command's cap must all read the one figure. A payment confirmed
 * against an agreement since withdrawn is listed (it can be taken back) but is
 * marked as not counted.
 */
export type CustomerFinanceCompanyPayment<PaymentId extends string = string> = {
  _id: PaymentId;
  status: "CONFIRMED" | "VOIDED";
  /** Whether it backs the agreement the deal holds now. */
  agreement: "CURRENT" | "PRIOR";
  amountMinor: number;
  paidAt: number;
  reference: string;
  kind?: "RECEIPT" | "CONFIRMATION";
  voidReason?: string;
  canCorrectEvidence?: boolean;
  lenderReturn?: { reference: string; refundedAt: number };
};

type Confirmation = { amountMinor: number; paidAt: number; reference: string };
type EvidenceKind = "RECEIPT" | "CONFIRMATION";
export type FirstPaymentConfirmation = Confirmation & { kind: EvidenceKind; verifiedReplacementAgreement?: true };

type CustomerFinanceCompanyPaymentCardProps<PaymentId extends string> = {
  agreedMinor: number;
  confirmedMinor: number;
  /** What is still to be confirmed, as the server stores it. */
  awaitingMinor: number;
  /** `undefined` while the evidence list loads. */
  payments: ReadonlyArray<CustomerFinanceCompanyPayment<PaymentId>> | undefined;
  /** Finance authority and not the deal's own salesperson. */
  canRecord: boolean;
  closed: boolean;
  /** Minor units per major unit of the deal's currency. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onVoid: (values: { paymentId: PaymentId; reason: string }) => Promise<boolean>;
  onCorrectEvidence?: (payment: CustomerFinanceCompanyPayment<PaymentId>) => void;
} & (
  | { firstPayment?: undefined; onConfirm: (values: Confirmation) => Promise<boolean> }
  | {
    firstPayment: {
      heldMinor: number; canConfirm: boolean; replacementAgreementStartsAt?: number;
    } | { heldMinor?: undefined; canConfirm: false; replacementAgreementStartsAt?: undefined };
    onConfirm: (values: FirstPaymentConfirmation) => Promise<boolean>;
  }
);

function toMinor(value: string, factor: number): number | null {
  const parsed = parseMajorToMinor(value, Math.round(Math.log10(factor)));
  return parsed.ok && parsed.minor > 0 ? parsed.minor : null;
}

export function CustomerFinanceCompanyPaymentCard<PaymentId extends string>(
  props: Readonly<CustomerFinanceCompanyPaymentCardProps<PaymentId>>,
) {
  const { agreedMinor, confirmedMinor, awaitingMinor, payments, canRecord, closed, firstPayment, factor, money, t, onVoid } = props;
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding] = useState<PaymentId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState<EvidenceTime>(() => ({ local: economicTodayDateInput() }));
  const [reference, setReference] = useState("");
  const [kind, setKind] = useState<EvidenceKind>("RECEIPT");
  const [verifiedReplacementAgreement, setVerifiedReplacementAgreement] = useState(false);
  const [reason, setReason] = useState("");
  const replacementAgreementStartsAt = firstPayment?.replacementAgreementStartsAt;
  const replacementProofRequired = replacementAgreementStartsAt !== undefined;
  const now = usePaymentEvidenceClock(confirming && replacementProofRequired);

  // An earlier agreement's evidence keeps the card on screen so it can be taken back.
  if (agreedMinor <= 0 && (payments ?? []).length === 0) return null;
  const amountMinor = toMinor(amount, factor);
  const paymentTime = replacementProofRequired ? evidenceTimeInMs(paidOn) : economicDateInputToMs(paidOn.local);
  const invalidReplacementTime = replacementProofRequired && paidOn.local !== "" &&
    (!Number.isSafeInteger(paymentTime) || paymentTime < replacementAgreementStartsAt || paymentTime > now);
  const confirmInvalid = amountMinor === null || amountMinor > awaitingMinor || reference.trim() === "" || paidOn.local === "" || invalidReplacementTime ||
    (replacementProofRequired && !verifiedReplacementAgreement);
  const offered = canRecord && !closed;
  const canConfirm = offered && (firstPayment?.canConfirm ?? true);
  const showBalances = !firstPayment || firstPayment.heldMinor !== undefined;
  const idPrefix = firstPayment ? "first-payment-proof" : "cust-fc-pay";

  const openConfirm = () => {
    setAmount((awaitingMinor / factor).toString());
    setPaidOn({ local: replacementProofRequired ? "" : economicTodayDateInput() });
    setReference("");
    setKind("RECEIPT");
    setVerifiedReplacementAgreement(false);
    setConfirming(true);
  };

  const submitConfirm = async () => {
    if (amountMinor === null || confirmInvalid || !canConfirm || (replacementProofRequired && paymentTime > Date.now())) return;
    setSubmitting(true);
    try {
      // Ordinary receipts use a ledger day. A replacement receipt needs its actual timestamp.
      const values = {
        amountMinor,
        paidAt: paymentTime,
        reference: reference.trim(),
      };
      if (!Number.isSafeInteger(values.paidAt)) return;
      const recorded = await (props.firstPayment ? props.onConfirm({
        ...values, kind, ...(replacementProofRequired ? { verifiedReplacementAgreement: true as const } : {}),
      }) : props.onConfirm(values));
      if (recorded) setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const submitVoid = async () => {
    if (!offered || voiding === null || reason.trim() === "") return;
    setSubmitting(true);
    try {
      if (await onVoid({ paymentId: voiding, reason: reason.trim() })) {
        setVoiding(null);
        setReason("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card data-testid={firstPayment ? "first-payment-evidence-card" : "customer-finance-company-payment-card"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t(firstPayment ? "FirstPaymentProofTitle" : "CustFcPayTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {showBalances && <dl className={firstPayment ? "grid gap-2 sm:grid-cols-2" : "grid gap-2 sm:grid-cols-3"}>
          <div>
            <dt className="text-muted-foreground">{t(firstPayment ? "FirstPaymentProofAgreed" : "CustFcPayAgreed")}</dt>
            <dd className="tabular-nums font-semibold"><bdi>{money(agreedMinor)}</bdi></dd>
          </div>
          {firstPayment?.heldMinor !== undefined && (
            <div>
              <dt className="text-muted-foreground">{t("FirstPaymentProofDealerReceived")}</dt>
              <dd className="tabular-nums font-semibold"><bdi>{money(firstPayment.heldMinor)}</bdi></dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">{t(firstPayment ? "FirstPaymentProofDirectConfirmed" : "CustFcPayConfirmed")}</dt>
            <dd className="tabular-nums font-semibold" data-testid="customer-finance-company-confirmed">
              <bdi>{money(confirmedMinor)}</bdi>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("CustFcPayAwaiting")}</dt>
            <dd className="tabular-nums font-semibold" data-testid="customer-finance-company-awaiting">
              <bdi>{money(awaitingMinor)}</bdi>
            </dd>
          </div>
        </dl>}
        {awaitingMinor > 0 && (
          <p className="text-xs text-muted-foreground">{t(firstPayment ? "FirstPaymentProofNeeded" : "CustFcPayAwaitingNote")}</p>
        )}
        {(payments ?? []).some((payment) => payment.status === "CONFIRMED" && payment.agreement === "PRIOR") && (
          <p className="text-xs text-muted-foreground">{t(firstPayment ? "FirstPaymentProofPriorNote" : "CustFcPayPriorNote")}</p>
        )}

        {(payments ?? []).length > 0 && (
          <ul className="space-y-1.5">
            {(payments ?? []).map((payment) => (
              <li key={payment._id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span className={payment.status === "VOIDED" ? "text-muted-foreground line-through" : undefined}>
                  <bdi className="tabular-nums font-medium">{money(payment.amountMinor)}</bdi>
                  {" · "}
                  <bdi>{msToDateInput(payment.paidAt)}</bdi>
                  {" · "}
                  <bdi>{payment.reference}</bdi>
                  {payment.kind && <>{" · "}{t(payment.kind === "RECEIPT" ? "FirstPaymentProofReceipt" : "FirstPaymentProofConfirmation")}</>}
                </span>
                {payment.status === "CONFIRMED" && payment.agreement === "PRIOR" && (
                  <span className="text-xs font-medium text-amber-700">{t("CustFcPayPriorAgreement")}</span>
                )}
                {payment.status === "VOIDED" ? (
                  <span className="text-xs text-muted-foreground">
                    {payment.lenderReturn ? <>
                      {t("FirstPaymentProofReturnedByLender")}{" · "}
                      <bdi>{payment.lenderReturn.reference}</bdi>{" · "}
                      <bdi>{msToDateInput(payment.lenderReturn.refundedAt)}</bdi>
                    </> : t("CustFcPayVoided")}
                    {payment.voidReason ? `: ${payment.voidReason}` : ""}
                  </span>
                ) : (
                  offered && (
                    <div className="flex flex-wrap gap-2">
                      {props.onCorrectEvidence && payment.canCorrectEvidence && (
                        <Button size="sm" variant="outline" onClick={() => props.onCorrectEvidence?.(payment)}>
                          {t("FirstPaymentCorrectionRequest")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setReason("");
                          setVoiding(payment._id);
                        }}
                      >
                        {t("CustFcPayVoidAction")}
                      </Button>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {canConfirm && awaitingMinor > 0 && (
          <Button size="sm" onClick={openConfirm}>
            {t("CustFcPayConfirmAction")}
          </Button>
        )}
        {!offered && !closed && awaitingMinor > 0 && (
          <p className="text-xs text-muted-foreground">{t("CustFcPayNotAllowed")}</p>
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("CustFcPayDialogTitle")}</DialogTitle>
            <DialogDescription>{t(firstPayment ? "FirstPaymentProofDialogDescription" : "CustFcPayDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {firstPayment && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-kind`}>{t("FirstPaymentProofSource")}</Label>
                <select
                  id={`${idPrefix}-kind`}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={kind}
                  onChange={(event) => setKind(event.target.value === "CONFIRMATION" ? "CONFIRMATION" : "RECEIPT")}
                >
                  <option value="RECEIPT">{t("FirstPaymentProofReceipt")}</option>
                  <option value="CONFIRMATION">{t("FirstPaymentProofConfirmation")}</option>
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-amount`}>{t("CustFcPayAmountLabel")}</Label>
              <Input
                id={`${idPrefix}-amount`}
                inputMode="decimal"
                value={amount}
                aria-invalid={amountMinor === null || amountMinor > awaitingMinor}
                onChange={(event) => setAmount(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("CustFcPayAtMost")} <bdi className="tabular-nums">{money(awaitingMinor)}</bdi>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-date`}>{t("CustFcPayDateLabel")}</Label>
              {replacementProofRequired ? <PaymentEvidenceTimeInput id={`${idPrefix}-date`} value={paidOn} onChange={setPaidOn}
                invalid={invalidReplacementTime} errorText={t("FirstPaymentProofReplacementTimeInvalid")} t={t} />
                : <Input id={`${idPrefix}-date`} type="date" max={economicTodayDateInput()} value={paidOn.local}
                  onChange={(event) => setPaidOn({ local: event.target.value })} />}
            </div>
            {replacementProofRequired && <Label className="flex items-start gap-2">
              <input type="checkbox" checked={verifiedReplacementAgreement}
                onChange={(event) => setVerifiedReplacementAgreement(event.target.checked)} />
              {t("FirstPaymentProofVerifyReplacementAgreement")}
            </Label>}
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-reference`}>{t("CustFcPayReferenceLabel")}</Label>
              <Input
                id={`${idPrefix}-reference`}
                value={reference}
                aria-invalid={reference.trim() === ""}
                onChange={(event) => setReference(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t("Cancel")}
            </Button>
            <Button disabled={!canConfirm || confirmInvalid || submitting} onClick={submitConfirm}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t("CustFcPayConfirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={voiding !== null} onOpenChange={(open) => !open && setVoiding(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("CustFcPayVoidTitle")}</DialogTitle>
            <DialogDescription>{t(firstPayment ? "FirstPaymentProofVoidDescription" : "CustFcPayVoidDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-void-reason`}>{t("CustFcPayVoidReasonLabel")}</Label>
            <Textarea
              id={`${idPrefix}-void-reason`}
              rows={3}
              value={reason}
              aria-invalid={reason.trim() === ""}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" disabled={reason.trim() === "" || submitting} onClick={submitVoid}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t("CustFcPayVoidAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
