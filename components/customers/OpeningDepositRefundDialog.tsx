"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { DepositRefundBankSelect, useDepositRefundBanks } from "@/components/deposits/DepositRefundBankSelect";
import { formatDepositAmount, type CustomerDepositRow } from "./customerDepositsPresentation";
import { isPilotSwitchOn } from "@/lib/pilotCapabilityManifest";
import { getCodedErrorMessage } from "@/lib/errors";

type RefundReservation = NonNullable<FunctionReturnType<typeof api.openingRefundCustody.openingRefundReservation>>;
type RefundMode =
  | { kind: "reserve" }
  | { kind: "waiting" }
  | { kind: "recover" | "cancel" | "payout"; reservation: RefundReservation };

function refundMode(reserved: boolean, reservation: RefundReservation | null | undefined, cancelling: boolean): RefundMode {
  if (!reserved) return { kind: "reserve" };
  if (!reservation) return { kind: "waiting" };
  if (reservation.canRecover === true) return { kind: "recover", reservation };
  if (cancelling) return { kind: "cancel", reservation };
  return { kind: "payout", reservation };
}

function canSubmitRefund(mode: RefundMode, fields: Readonly<{
  bankBlocked: boolean; isTransfer: boolean; selectedBank: string | undefined;
  payoutAt: number; reference: string; cancelReason: string;
}>) {
  switch (mode.kind) {
    case "reserve": return !fields.bankBlocked && (!fields.isTransfer || fields.selectedBank !== undefined);
    case "recover":
    case "cancel": return fields.cancelReason.trim().length > 0;
    case "payout": return !fields.bankBlocked && Number.isFinite(fields.payoutAt) && fields.reference.trim().length > 0;
    case "waiting": return false;
  }
}

function refundSubmitKey(state: Readonly<{ saving: boolean; canRecover: boolean; cancelling: boolean; reserved: boolean }>) {
  if (state.saving) return "Saving";
  if (state.canRecover) return "OpeningDepositRefundConfirmCustody";
  if (state.cancelling) return "OpeningDepositRefundConfirmUnpaid";
  if (state.reserved) return "OpeningDepositRecordRefund";
  return "OpeningDepositReserveRefund";
}

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

export function OpeningDepositRefundDialog({ orgId, depositId, amountLabel, currency, reserved, onClose }: Readonly<{
  orgId: Id<"organizations">;
  depositId: Id<"deposits">;
  amountLabel: string;
  currency: string;
  reserved: boolean;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const fieldId = useId();
  const bankRefundsDisabled = isPilotSwitchOn("OPENING_REFUND_BANK_PILOT_DISABLED");
  const reserveRefund = useMutation(api.openingDepositRefunds.reserveOpeningRefund);
  const cancelReservation = useMutation(api.openingDepositRefunds.cancelOpeningRefundReservation);
  const reservation = useQuery(api.openingRefundCustody.openingRefundReservation, reserved ? { orgId, depositId } : "skip");
  const recoverCustody = useMutation(api.openingRefundCustody.recoverOpeningRefundCustody);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const recordRefund = useMutation(api.openingDepositRefunds.recordOpeningRefund);
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER">("CASH");
  const [bank, setBank] = useState("");
  const [reference, setReference] = useState("");
  const [paidAtInput, setPaidAtInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [codedError, setCodedError] = useState<string | null>(null);
  const pending = useRef(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const isTransfer = (reservation?.method ?? method) === "BANK_TRANSFER";
  const bankOptions = useDepositRefundBanks(orgId, currency, !reserved && method === "BANK_TRANSFER", bank);
  const selectedBank = bankOptions.banks?.find((option) => option._id === bank)?._id;
  const bankAccountId = method === "BANK_TRANSFER" ? selectedBank : undefined;
  const canRecover = reservation?.canRecover === true;
  const bankBlocked = bankRefundsDisabled && isTransfer;
  const mode = refundMode(reserved, reservation, cancelling);
  const payoutAt = Date.parse(`${paidAtInput}Z`);
  const canSubmit = canSubmitRefund(mode, { bankBlocked, isTransfer, selectedBank, payoutAt, reference, cancelReason });

  async function submitReservation() {
    const idempotencyKey = intent.current?.key;
    if (typeof idempotencyKey !== "string") {
      setFailed(true);
      return;
    }
    await reserveRefund({ orgId, depositId, method, bankAccountId, idempotencyKey });
    toast.success(t("OpeningDepositRefundReserved"));
  }

  async function submitCustodyRecovery(currentKey: unknown) {
    const expectedReservationKey = currentKey;
    const idempotencyKey = intent.current?.key;
    if (typeof expectedReservationKey !== "string" || typeof idempotencyKey !== "string") {
      setFailed(true);
      return;
    }
    await recoverCustody({ orgId, depositId, expectedReservationKey,
      confirmedPaymentControlTransferred: true, reason: cancelReason.trim(), idempotencyKey });
    setCancelReason("");
    toast.success(t("OpeningDepositRefundCustodyRecovered"));
  }

  async function submitCancellation(currentKey: unknown) {
    const reservationKey = currentKey;
    if (typeof reservationKey !== "string") {
      setFailed(true);
      return;
    }
    await cancelReservation({ orgId, depositId, reservationKey,
      confirmedUnpaid: true, reason: cancelReason.trim() });
    toast.success(t("OpeningDepositRefundCancelled"));
    onClose();
  }

  async function submitPayout(currentKey: unknown, payoutReference: string) {
    const reservationKey = currentKey;
    const idempotencyKey = intent.current?.key;
    if (typeof reservationKey !== "string" || typeof idempotencyKey !== "string") {
      setFailed(true);
      return;
    }
    await recordRefund({ orgId, depositId, reservationKey, payoutReference, payoutAt, idempotencyKey });
    toast.success(t("OpeningDepositRefundRecorded"));
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !canSubmit) return;
    const payoutReference = reference.trim();
    const fingerprint = reserved
      ? JSON.stringify([reservation?.reservationKey, payoutReference, payoutAt, cancelling, canRecover, cancelReason])
      : JSON.stringify([method, bankAccountId]);
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = { fingerprint, key: crypto.randomUUID() };
    }
    pending.current = true;
    setSaving(true);
    setFailed(false);
    setCodedError(null);
    try {
      if (mode.kind === "reserve") {
        await submitReservation();
      } else if (mode.kind === "recover") {
        await submitCustodyRecovery(mode.reservation.reservationKey);
      } else if (mode.kind === "cancel") {
        await submitCancellation(mode.reservation.reservationKey);
      } else if (mode.kind === "payout") {
        await submitPayout(mode.reservation.reservationKey, payoutReference);
      }
    } catch (error) {
      setCodedError(getCodedErrorMessage(error, t));
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
            {!bankRefundsDisabled && <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={fieldId} checked={isTransfer} onChange={() => setMethod("BANK_TRANSFER")} />
              {t("OpeningDepositRefundBankTransfer")}
            </label>}
          </fieldset>}
          {!reserved && isTransfer && <DepositRefundBankSelect value={bank} onChange={setBank} bankOptions={bankOptions} disabled={saving} />}
          {reserved && reservation === undefined && <output className="block">{t("Loading")}</output>}
          {reserved && reservation === null && <output className="block">{t("OpeningDepositRefundHeldByApprover")}</output>}
          {reservation && <p className="text-sm">
            {t(isTransfer ? "OpeningDepositRefundBankTransfer" : "Cash")}
            {reservation.canRecover !== true && reservation.bankAccountName && <> · <bdi>{reservation.bankAccountName}</bdi></>}
          </p>}
          {bankBlocked && !cancelling && !canRecover && <p role="alert" className="text-sm text-destructive">
            {t("ServerError_OPENING_REFUND_BANK_PILOT_DISABLED")}
          </p>}
          {reservation && !bankBlocked && !cancelling && !canRecover && <>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-date`}>{t("OpeningDepositRefundPaidDate")}</Label>
            <Input id={`${fieldId}-date`} type="datetime-local" step={1} value={paidAtInput}
              onChange={(event) => setPaidAtInput(event.target.value)} required disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId}>{t("OpeningDepositRefundReference")}</Label>
            <Input id={fieldId} value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} required disabled={saving} />
          </div>
          </>}
          {reservation && (cancelling || canRecover) && <div className="space-y-2">
            <Label htmlFor={`${fieldId}-reason`}>{t(canRecover ? "OpeningDepositRefundRecoveryReason" : "OpeningDepositRefundCancelReason")}</Label>
            <Input id={`${fieldId}-reason`} value={cancelReason} maxLength={240} required disabled={saving}
              onChange={(event) => setCancelReason(event.target.value)} />
          </div>}
          {failed && <p role="alert" className="text-sm text-destructive">{codedError || t("OpeningDepositRefundUnconfirmed")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            {reservation && !cancelling && !canRecover && <Button type="button" variant="outline" disabled={saving}
              onClick={() => { setCancelling(true); setFailed(false); }}>{t("OpeningDepositRefundCancelReservation")}</Button>}
            <Button type="submit" disabled={saving || !canSubmit}>
              {t(refundSubmitKey({ saving, canRecover, cancelling, reserved }))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
