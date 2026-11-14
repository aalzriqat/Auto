"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { DepositRefundBankSelect, useDepositRefundBanks } from "@/components/deposits/DepositRefundBankSelect";
import { formatDepositAmount, type CustomerDepositRow } from "./customerDepositsPresentation";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";

export function SelectedOpeningDepositRefund({ orgId, deposit, onClose }: Readonly<{
  orgId: Id<"organizations">;
  deposit: (CustomerDepositRow & { _id: Id<"deposits"> }) | undefined;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  if (!deposit?.currency) return null;
  const { amount, currency } = formatDepositAmount(deposit, undefined);
  return (
    <OpeningDepositRefundDialog orgId={orgId} depositId={deposit._id} currency={deposit.currency}
      amountLabel={`${amount} ${currency === "JOD" ? t("JOD") : currency}`} reserved={deposit.openingRefundReserved === true} onClose={onClose} />
  );
}

function OpeningDepositRefundDialog({ orgId, depositId, amountLabel, currency, reserved, onClose }: Readonly<{
  orgId: Id<"organizations">;
  depositId: Id<"deposits">;
  amountLabel: string;
  currency: string;
  reserved: boolean;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const fieldId = useId();
  const reserveRefund = useMutation(api.openingDepositRefunds.reserveOpeningRefund);
  const cancelReservation = useMutation(api.openingDepositRefunds.cancelOpeningRefundReservation);
  const reservation = useQuery(api.openingDepositRefunds.openingRefundReservation, reserved ? { orgId, depositId } : "skip");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const recordRefund = useMutation(api.openingDepositRefunds.recordOpeningRefund);
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER">("CASH");
  const [bank, setBank] = useState("");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(economicTodayDateInput);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const isTransfer = (reservation?.method ?? method) === "BANK_TRANSFER";
  const bankOptions = useDepositRefundBanks(orgId, currency, !reserved && isTransfer, bank);
  const selectedBank = bankOptions.banks?.find((option) => option._id === bank)?._id;
  const canSubmit = reserved
    ? !!reservation && (cancelling ? cancelReason.trim().length > 0 : date.length > 0 && reference.trim().length > 0)
    : !isTransfer || selectedBank !== undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !canSubmit) return;
    const payoutReference = reference.trim();
    const payoutDate = economicDateInputToMs(date);
    const bankAccountId = isTransfer ? selectedBank : undefined;
    const fingerprint = reserved
      ? JSON.stringify([reservation?.reservationKey, payoutReference, payoutDate, cancelling, cancelReason])
      : JSON.stringify([method, bankAccountId]);
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = { fingerprint, key: crypto.randomUUID() };
    }
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try {
      if (!reserved) {
        await reserveRefund({ orgId, depositId, method, bankAccountId, idempotencyKey: intent.current.key });
        toast.success(t("OpeningDepositRefundReserved"));
      } else if (reservation && cancelling) {
        await cancelReservation({ orgId, depositId, reservationKey: reservation.reservationKey,
          confirmedUnpaid: true, reason: cancelReason.trim() });
        toast.success(t("OpeningDepositRefundCancelled"));
        onClose();
      } else if (reservation) {
        await recordRefund({ orgId, depositId, reservationKey: reservation.reservationKey,
          payoutReference, payoutDate, idempotencyKey: intent.current.key });
        toast.success(t("OpeningDepositRefundRecorded"));
        onClose();
      }
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(reserved ? "OpeningDepositContinueRefund" : "OpeningDepositReserveRefund")}</DialogTitle>
          <DialogDescription>{t(reserved ? "OpeningDepositRefundDescription" : "OpeningDepositReserveDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <bdi dir="ltr" className="font-medium">{amountLabel}</bdi>
          {!reserved && <fieldset disabled={saving} className="space-y-2">
            <legend className="text-sm font-medium">{t("OpeningDepositRefundMethod")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={fieldId} checked={!isTransfer} onChange={() => setMethod("CASH")} />
              {t("Cash")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={fieldId} checked={isTransfer} onChange={() => setMethod("BANK_TRANSFER")} />
              {t("OpeningDepositRefundBankTransfer")}
            </label>
          </fieldset>}
          {!reserved && isTransfer && <DepositRefundBankSelect value={bank} onChange={setBank} bankOptions={bankOptions} disabled={saving} />}
          {reserved && reservation === undefined && <p role="status">{t("Loading")}</p>}
          {reserved && reservation === null && <p role="status">{t("OpeningDepositRefundHeldByApprover")}</p>}
          {reservation && <p className="text-sm">
            {t(isTransfer ? "OpeningDepositRefundBankTransfer" : "Cash")}
            {reservation.bankAccountName && <> · <bdi>{reservation.bankAccountName}</bdi></>}
          </p>}
          {reservation && !cancelling && <>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-date`}>{t("OpeningDepositRefundPaidDate")}</Label>
            <Input id={`${fieldId}-date`} type="date" value={date} max={economicTodayDateInput()}
              onChange={(event) => setDate(event.target.value)} required disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId}>{t("OpeningDepositRefundReference")}</Label>
            <Input id={fieldId} value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} required disabled={saving} />
          </div>
          </>}
          {reservation && cancelling && <div className="space-y-2">
            <Label htmlFor={`${fieldId}-reason`}>{t("OpeningDepositRefundCancelReason")}</Label>
            <Input id={`${fieldId}-reason`} value={cancelReason} maxLength={240} required disabled={saving}
              onChange={(event) => setCancelReason(event.target.value)} />
          </div>}
          {failed && <p role="alert" className="text-sm text-destructive">{t("OpeningDepositRefundUnconfirmed")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            {reservation && !cancelling && <Button type="button" variant="outline" disabled={saving}
              onClick={() => { setCancelling(true); setFailed(false); }}>{t("OpeningDepositRefundCancelReservation")}</Button>}
            <Button type="submit" disabled={saving || !canSubmit}>
              {t(saving ? "Saving" : cancelling ? "OpeningDepositRefundConfirmUnpaid" :
                reserved ? "OpeningDepositRecordRefund" : "OpeningDepositReserveRefund")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
