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
export type CustomerFinanceCompanyPayment = {
  _id: string;
  status: "CONFIRMED" | "VOIDED";
  /** Whether it backs the agreement the deal holds now. */
  agreement: "CURRENT" | "PRIOR";
  amountMinor: number;
  paidAt: number;
  reference: string;
  voidReason?: string;
};

type CustomerFinanceCompanyPaymentCardProps = {
  agreedMinor: number;
  confirmedMinor: number;
  /** What is still to be confirmed, as the server stores it. */
  awaitingMinor: number;
  /** `undefined` while the evidence list loads. */
  payments: ReadonlyArray<CustomerFinanceCompanyPayment> | undefined;
  /** Finance authority and not the deal's own salesperson. */
  canRecord: boolean;
  closed: boolean;
  /** Minor units per major unit of the deal's currency. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  /** Resolve `true` only when the server accepted the command, so a refusal leaves the dialog open. */
  onConfirm: (values: { amountMinor: number; paidAt: number; reference: string }) => Promise<boolean>;
  onVoid: (values: { paymentId: string; reason: string }) => Promise<boolean>;
};

function toMinor(value: string, factor: number): number | null {
  const parsed = parseMajorToMinor(value, Math.round(Math.log10(factor)));
  return parsed.ok && parsed.minor > 0 ? parsed.minor : null;
}

export function CustomerFinanceCompanyPaymentCard({
  agreedMinor,
  confirmedMinor,
  awaitingMinor,
  payments,
  canRecord,
  closed,
  factor,
  money,
  t,
  onConfirm,
  onVoid,
}: Readonly<CustomerFinanceCompanyPaymentCardProps>) {
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(economicTodayDateInput);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");

  // An earlier agreement's evidence keeps the card on screen so it can be taken back.
  if (agreedMinor <= 0 && (payments ?? []).length === 0) return null;
  const amountMinor = toMinor(amount, factor);
  const confirmInvalid = amountMinor === null || amountMinor > awaitingMinor || reference.trim() === "" || paidOn === "";
  const offered = canRecord && !closed;

  const openConfirm = () => {
    setAmount((awaitingMinor / factor).toString());
    setPaidOn(economicTodayDateInput());
    setReference("");
    setConfirming(true);
  };

  const submitConfirm = async () => {
    if (amountMinor === null || confirmInvalid) return;
    setSubmitting(true);
    try {
      // UTC midnight of the chosen day: the ledger calendar, never in the future.
      const recorded = await onConfirm({
        amountMinor,
        paidAt: economicDateInputToMs(paidOn),
        reference: reference.trim(),
      });
      if (recorded) setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const submitVoid = async () => {
    if (voiding === null || reason.trim() === "") return;
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
    <Card data-testid="customer-finance-company-payment-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("CustFcPayTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("CustFcPayAgreed")}</dt>
            <dd className="tabular-nums font-semibold"><bdi>{money(agreedMinor)}</bdi></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("CustFcPayConfirmed")}</dt>
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
        </dl>
        {awaitingMinor > 0 && <p className="text-xs text-muted-foreground">{t("CustFcPayAwaitingNote")}</p>}
        {(payments ?? []).some((payment) => payment.status === "CONFIRMED" && payment.agreement === "PRIOR") && (
          <p className="text-xs text-muted-foreground">{t("CustFcPayPriorNote")}</p>
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
                </span>
                {payment.status === "CONFIRMED" && payment.agreement === "PRIOR" && (
                  <span className="text-xs font-medium text-amber-700">{t("CustFcPayPriorAgreement")}</span>
                )}
                {payment.status === "VOIDED" ? (
                  <span className="text-xs text-muted-foreground">
                    {t("CustFcPayVoided")}
                    {payment.voidReason ? `: ${payment.voidReason}` : ""}
                  </span>
                ) : (
                  offered && (
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
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {offered && awaitingMinor > 0 && (
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
            <DialogDescription>{t("CustFcPayDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cust-fc-pay-amount">{t("CustFcPayAmountLabel")}</Label>
              <Input
                id="cust-fc-pay-amount"
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
              <Label htmlFor="cust-fc-pay-date">{t("CustFcPayDateLabel")}</Label>
              <Input
                id="cust-fc-pay-date"
                type="date"
                max={economicTodayDateInput()}
                value={paidOn}
                onChange={(event) => setPaidOn(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-fc-pay-reference">{t("CustFcPayReferenceLabel")}</Label>
              <Input
                id="cust-fc-pay-reference"
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
            <Button disabled={confirmInvalid || submitting} onClick={submitConfirm}>
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
            <DialogDescription>{t("CustFcPayVoidDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cust-fc-pay-void-reason">{t("CustFcPayVoidReasonLabel")}</Label>
            <Textarea
              id="cust-fc-pay-void-reason"
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
