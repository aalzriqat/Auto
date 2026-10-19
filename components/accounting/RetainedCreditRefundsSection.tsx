"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getCodedErrorMessage } from "@/lib/errors";
import { formatMoneyDisplay, moneyDisplayScale } from "@/lib/moneyDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReceiptBankSelect, useReceiptBankOptions } from "./ReceiptBankSelect";

function ApprovedPayoutControls({ orgId, requestId, method, currency, busy, payoutAvailable,
  payoutReasonId, onExecute,
}: Readonly<{
  orgId: Id<"organizations">;
  requestId: Id<"retainedCreditRefundRequests">;
  method: string;
  currency: string;
  busy: boolean;
  payoutAvailable: boolean;
  payoutReasonId: string;
  onExecute: (requestId: Id<"retainedCreditRefundRequests">, reference: string,
    bankAccountId?: Id<"bankAccounts">) => Promise<void>;
}>) {
  const { t } = useLanguage();
  const [reference, setReference] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const needsBank = method === "BANK_TRANSFER";
  const bankOptions = useReceiptBankOptions(orgId, payoutAvailable && needsBank, bankAccountId, currency);
  const canExecute = !busy && payoutAvailable && reference.trim().length > 0 &&
    (!needsBank || bankOptions.chosenOffered);
  return <>
    {needsBank && <ReceiptBankSelect id={`retained-refund-bank-${requestId}`}
      value={bankAccountId} onChange={setBankAccountId} bankOptions={bankOptions}
      disabled={busy || !payoutAvailable} />}
    <Input className="w-48" aria-label={t("RetainedCreditPayoutReference")}
      placeholder={t("RetainedCreditPayoutReference")} value={reference}
      disabled={busy || !payoutAvailable}
      aria-describedby={payoutAvailable ? undefined : payoutReasonId}
      onChange={(event) => setReference(event.target.value)} />
    <Button size="sm" disabled={!canExecute}
      aria-describedby={payoutAvailable ? undefined : payoutReasonId}
      onClick={() => {
        if (!canExecute) return;
        void onExecute(requestId, reference.trim(),
          needsBank ? bankAccountId as Id<"bankAccounts"> : undefined);
      }}>{t("RetainedCreditExecute")}</Button>
  </>;
}

/**
 * SCRUM-724: standalone customer-credit refunds (cheque cleared after its sale
 * was cancelled). Listed beside the collection approvals: a different actor
 * approves, then a finance user records the payout. The server owns every rule;
 * this only shows the queue and forwards the three commands.
 */
export function RetainedCreditRefundsSection({ orgId, canApprove, canManage, payoutAvailable = false }: Readonly<{
  orgId: Id<"organizations">;
  canApprove: boolean;
  canManage: boolean;
  /**
   * Backend-reported availability (`collections.summary.retainedCreditPayoutAvailable`).
   * Absent or false (the pilot, or a backend that does not report it) shows
   * approve and record-payout DISABLED, tied to the reason; reject and cancel stay
   * available.
   */
  payoutAvailable?: boolean;
}>) {
  const { t, locale } = useLanguage();
  const command = useCommandIdentity();
  const pending = useQuery(api.retainedCreditRefunds.listRetainedCreditRefundRequests,
    { orgId, status: "PENDING" });
  const approved = useQuery(api.retainedCreditRefunds.listRetainedCreditRefundRequests,
    { orgId, status: "APPROVED" });
  const respond = useMutation(api.retainedCreditRefunds.respondToRetainedCreditRefund);
  const execute = useMutation(api.retainedCreditRefunds.executeRetainedCreditRefund);
  const cancel = useMutation(api.retainedCreditRefunds.cancelRetainedCreditRefund);
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({});
  const paidAtByRequest = useRef<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const payoutReasonId = useId();
  const rows = [...(pending ?? []), ...(approved ?? [])];

  /** A coded refusal in the user's language, else the queue's own message: never server English. */
  function showFailure(error: unknown) {
    toast.error(getCodedErrorMessage(error, t) ?? t("RetainedCreditRefundActionFailed"));
  }

  async function onDecide(requestId: Id<"retainedCreditRefundRequests">, status: "APPROVED" | "REJECTED") {
    if (busyId || (status === "APPROVED" && !payoutAvailable)) return;
    setBusyId(requestId);
    const intent = `retained-refund-decide:${requestId}:${status}`;
    try {
      await respond({ orgId, requestId, status, idempotencyKey: command.for(intent) });
      command.retire(intent);
      toast.success(t(status === "APPROVED" ? "RetainedCreditRefundApproved" : "RetainedCreditRefundRejected"));
    } catch (error) {
      showFailure(error);
    } finally { setBusyId(null); }
  }

  async function onCancel(requestId: Id<"retainedCreditRefundRequests">) {
    const reason = (cancelReasons[requestId] ?? "").trim();
    if (busyId || !reason) return;
    setBusyId(requestId);
    try {
      await cancel({ orgId, requestId, reason });
      toast.success(t("RetainedCreditRefundCancelled"));
    } catch (error) {
      showFailure(error);
    } finally { setBusyId(null); }
  }

  async function onExecute(requestId: Id<"retainedCreditRefundRequests">, reference: string,
    bankAccountId?: Id<"bankAccounts">) {
    const request = approved?.find((row) => row._id === requestId);
    if (busyId || !reference || !payoutAvailable || !request ||
        (request.method === "BANK_TRANSFER" && !bankAccountId)) return;
    setBusyId(requestId);
    const intent = `retained-refund-execute:${requestId}:${bankAccountId ?? "none"}`;
    try {
      // The payout date is part of the command fingerprint, so it is fixed on
      // the first attempt: a retry replays instead of mismatching the key.
      const paidAt = paidAtByRequest.current[requestId] ?? (Date.now() - 60_000);
      paidAtByRequest.current[requestId] = paidAt;
      await execute({ orgId, requestId, reference, paidAt,
        ...(request.method === "BANK_TRANSFER" ? { bankAccountId } : {}),
        idempotencyKey: command.for(intent) });
      command.retire(intent);
      delete paidAtByRequest.current[requestId];
      toast.success(t("RetainedCreditRefundPaid"));
    } catch (error) {
      showFailure(error);
    } finally { setBusyId(null); }
  }

  return (
    <section className="mt-4 space-y-2" aria-label={t("RetainedCreditRefundsHeading")}
      data-testid="retained-credit-refunds">
      <h3 className="font-medium">{t("RetainedCreditRefundsHeading")}</h3>
      {rows.length > 0 && !payoutAvailable && (
        <p id={payoutReasonId} className="text-sm text-muted-foreground" role="note"
          data-testid="retained-credit-payout-unavailable">
          {t("RetainedCreditPayoutUnavailable")}</p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("RetainedCreditRefundsEmpty")}</p>}
      {rows.map((row) => (
        <div key={row._id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
          <span className="font-medium">{row.customerName ?? "-"}</span>
          <span>{formatMoneyDisplay(row.amountMinor / 10 ** moneyDisplayScale(row.currency), row.currency, locale)}</span>
          {row.sourceChequeLabel && <span className="text-muted-foreground">
            {t("RetainedCreditFromCheque")} <bdi dir="ltr">{row.sourceChequeLabel}</bdi>
            {row.originatingSaleStatus === "CANCELLED" && <> · {t("RetainedCreditSaleCancelled")}</>}</span>}
          <span className="text-muted-foreground">
            {t(row.status === "PENDING" ? "RetainedCreditStatusPENDING" : "RetainedCreditStatusAPPROVED")}</span>
          {row.status === "PENDING" && canApprove && !row.requestedByMe && <>
            <Button size="sm" variant="outline" disabled={!!busyId || !payoutAvailable}
              aria-describedby={payoutAvailable ? undefined : payoutReasonId}
              onClick={() => onDecide(row._id, "APPROVED")}>{t("Approve")}</Button>
            <Button size="sm" variant="outline" disabled={!!busyId}
              onClick={() => onDecide(row._id, "REJECTED")}>{t("Reject")}</Button>
          </>}
          {canManage && (row.status === "PENDING" || row.status === "APPROVED") && <>
            <Input className="w-48" aria-label={t("RetainedCreditCancelReason")}
              placeholder={t("RetainedCreditCancelReason")} maxLength={500}
              value={cancelReasons[row._id] ?? ""} disabled={!!busyId}
              onChange={(event) => setCancelReasons((prev) => ({ ...prev, [row._id]: event.target.value }))} />
            <Button size="sm" variant="outline" disabled={!!busyId || !(cancelReasons[row._id] ?? "").trim()}
              onClick={() => onCancel(row._id)}>{t("RetainedCreditRefundCancel")}</Button>
          </>}
          {row.status === "APPROVED" && canManage &&
            <ApprovedPayoutControls orgId={orgId} requestId={row._id} method={row.method}
              currency={row.currency} busy={!!busyId} payoutAvailable={payoutAvailable}
              payoutReasonId={payoutReasonId} onExecute={onExecute} />}
        </div>
      ))}
    </section>
  );
}
