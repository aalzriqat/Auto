"use client";

import { useId, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Wallet } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getCodedErrorMessage } from "@/lib/errors";
import { dateInputToUtcMs, economicDateInputToMs, economicTodayDateInput, todayDateInput } from "@/lib/dateInput";
import { formatMoneyDisplay, moneyDisplayScale, parseTypedAmount } from "@/lib/moneyDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ReceiptMethod = "CASH" | "BANK_TRANSFER";
type PaymentAttempt = { amount: number; method: ReceiptMethod; paymentDate: number; reference?: string };
type ReserveAttempt = { receiptMovementId: Id<"receiptMovements">; amountMinor: number };
/** SCRUM-724 CR-2: a retained-credit refund is paid by bank transfer only. */
const REFUND_METHOD = "BANK_TRANSFER" as const;

function BalanceRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="shrink-0 whitespace-nowrap font-medium">
        <bdi dir="ltr" className="tabular-nums">{value}</bdi>
      </dd>
    </div>
  );
}

export function DealInvoiceReceiptsPanel({ orgId, saleId }: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
}>) {
  const { t, locale } = useLanguage();
  const { hasPermission, isLoading } = usePermissions();
  const canView = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE);
  const canManage = !isLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const command = useCommandIdentity();
  const doorsReasonId = useId();
  const payoutReasonId = useId();
  const recordPayment = useMutation(api.collections.recordPayment);
  const reserve = useMutation(api.collections.reserveSaleInvoiceReceipt);
  const activate = useMutation(api.collections.activateSaleInvoiceReceipt);
  const registerCheque = useMutation(api.collections.registerSaleInvoiceCheque);
  const depositCheque = useMutation(api.collections.depositCheque);
  const clearCheque = useMutation(api.collections.clearCheque);
  const requestRefund = useMutation(api.retainedCreditRefunds.requestRetainedCreditRefund);
  const [pendingCursor, setPendingCursor] = useState<string | null>(null);
  const status = useQuery(api.collections.saleInvoiceReceiptStatus,
    canView ? { orgId, saleId, paginationOpts: { numItems: 20, cursor: pendingCursor } } : "skip");
  const credits = usePaginatedQuery(api.collections.listRetainedCredits,
    canView && status?.customerId
      ? { orgId, customerId: status.customerId, onlyRemaining: true }
      : "skip", { initialNumItems: 20 });
  const cheques = usePaginatedQuery(api.collections.listSaleCustomerCheques,
    canView ? { orgId, saleId } : "skip", { initialNumItems: 20 });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<ReceiptMethod>("CASH");
  const [date, setDate] = useState(economicTodayDateInput);
  const [reference, setReference] = useState("");
  const [chequeBank, setChequeBank] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeDate, setChequeDate] = useState(todayDateInput);
  const [reserveAmount, setReserveAmount] = useState("");
  const [selectedMovement, setSelectedMovement] = useState("");
  const [paymentAttempt, setPaymentAttempt] = useState<PaymentAttempt | null>(null);
  const [reserveAttempt, setReserveAttempt] = useState<ReserveAttempt | null>(null);
  const [refundMovement, setRefundMovement] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canView) return null;
  const invoice = status?.invoice;
  const currency = invoice?.currency ?? "JOD";
  const receiptCurrencyMatches = !!invoice && invoice.currency.toUpperCase() === status?.receiptCurrency.toUpperCase();
  const factor = 10 ** moneyDisplayScale(currency);
  const money = (minor: number, code = currency) =>
    formatMoneyDisplay(minor / 10 ** moneyDisplayScale(code), code, locale);
  // SCRUM-724: the backend reports availability. Absent (a backend that does not
  // report it) means UNAVAILABLE, never "assume enabled". The gated actions stay
  // visible but disabled, tied to the reason, so the operator sees what exists
  // and why it cannot be used yet.
  const doorsAvailable = status?.saleInvoiceDoorsAvailable === true;
  const payoutAvailable = status?.retainedCreditPayoutAvailable === true;
  const doorsReason = doorsAvailable ? undefined : doorsReasonId;
  const payoutReason = payoutAvailable ? undefined : payoutReasonId;
  // The invoice can still take money: the precondition of every receipt door.
  const invoiceOpen = status?.saleStatus === "COMPLETED" && !!invoice && invoice.availableToReserveMinor > 0;
  const pending = status?.page ?? [];
  const positions = credits.results ?? [];
  const selectedCredit = positions.find((position) => position.receiptMovementId === selectedMovement);
  const parsedPayment = parseTypedAmount(amount, moneyDisplayScale(currency));
  const parsedReserve = parseTypedAmount(reserveAmount, moneyDisplayScale(currency));
  const parsedCheque = parseTypedAmount(chequeAmount, moneyDisplayScale(currency));
  const refundCredit = positions.find((position) => position.receiptMovementId === refundMovement);
  const parsedRefund = parseTypedAmount(refundAmount, moneyDisplayScale(refundCredit?.currency ?? currency));
  const paymentIntent = `sale-receipt:${saleId}`;
  const reserveIntent = `sale-reserve:${saleId}`;

  /**
   * SCRUM-724 CR-1: a coded refusal is shown in the user's language; anything
   * else (an uncoded server string, a transport failure) gets this panel's own
   * localized message - the server's English never reaches the screen.
   */
  function showFailure(failure: unknown, fallbackKey: "DealReceiptActionFailed" | "DealReceiptChequeActionFailed") {
    setError(getCodedErrorMessage(failure, t) ?? t(fallbackKey));
  }

  /**
   * A HELD cheque is deposited only while the live invoice can still cover its
   * whole face - the server compares the same figures and refuses otherwise
   * (CHEQUE_INVOICE_UNCOVERED_HELD).
   */
  function invoiceCoversCheque(chequeAmountMajor: number): boolean {
    if (!invoice || status?.saleStatus !== "COMPLETED" || !receiptCurrencyMatches) return false;
    const faceMinor = Math.round(chequeAmountMajor * 10 ** moneyDisplayScale(status.receiptCurrency));
    return invoice.availableToReserveMinor > 0 && faceMinor <= invoice.availableToReserveMinor;
  }

  async function onRecord() {
    if (!doorsAvailable || !status?.customerId || !canManage || !invoice || !receiptCurrencyMatches || busy) return;
    const paymentDate = economicDateInputToMs(date);
    if (!paymentAttempt && (parsedPayment.minor === null || parsedPayment.minor <= 0 ||
      parsedPayment.minor > invoice.availableToReserveMinor ||
      !Number.isFinite(paymentDate) || (method === "BANK_TRANSFER" && !reference.trim()))) {
      setError(t("DealReceiptEnterValidPayment"));
      return;
    }
    const attempt = paymentAttempt ?? {
      amount: parsedPayment.minor! / factor, method, paymentDate,
      reference: reference.trim() || undefined,
    };
    setPaymentAttempt(attempt);
    setBusy(true); setError(""); setNotice("");
    try {
      await recordPayment({ orgId, customerId: status.customerId, invoiceSaleId: saleId, ...attempt,
        idempotencyKey: command.for(paymentIntent) });
      command.retire(paymentIntent);
      setPaymentAttempt(null); setAmount(""); setReference("");
      setNotice(t("DealReceiptRecorded"));
    } catch (error_) {
      showFailure(error_, "DealReceiptActionFailed");
    } finally {
      setBusy(false);
    }
  }

  async function onReserve() {
    if (!doorsAvailable || !canManage || !invoice || busy) return;
    if (!reserveAttempt && (!selectedCredit?.receiptPosted ||
      selectedCredit.currency !== currency || parsedReserve.minor === null ||
      parsedReserve.minor <= 0 || parsedReserve.minor > selectedCredit.availableUnappliedMinor ||
      parsedReserve.minor > invoice.availableToReserveMinor)) {
      setError(t("DealReceiptEnterValidCredit"));
      return;
    }
    const attempt = reserveAttempt ?? {
      receiptMovementId: selectedCredit!.receiptMovementId, amountMinor: parsedReserve.minor!,
    };
    setReserveAttempt(attempt);
    setBusy(true); setError(""); setNotice("");
    try {
      await reserve({ orgId, saleId, ...attempt, idempotencyKey: command.for(reserveIntent) });
      command.retire(reserveIntent);
      setReserveAttempt(null); setReserveAmount(""); setSelectedMovement("");
      setNotice(t("DealReceiptReserved"));
    } catch (error_) {
      showFailure(error_, "DealReceiptActionFailed");
    } finally {
      setBusy(false);
    }
  }

  async function onActivate(applicationId: Id<"invoiceReceiptApplications">, amountMinor: number) {
    if (!doorsAvailable || !canManage || busy) return;
    const intent = `sale-activate:${applicationId}`;
    setBusy(true); setError(""); setNotice("");
    try {
      await activate({ orgId, applicationId, amountMinor, idempotencyKey: command.for(intent) });
      command.retire(intent);
      setNotice(t("DealReceiptActivated"));
    } catch (error_) {
      showFailure(error_, "DealReceiptActionFailed");
    } finally {
      setBusy(false);
    }
  }

  async function onRegisterCheque() {
    if (!doorsAvailable || !canManage || !invoice || !receiptCurrencyMatches || busy) return;
    const chequeDateMs = dateInputToUtcMs(chequeDate);
    if (!chequeBank.trim() || !chequeNumber.trim() || !Number.isFinite(chequeDateMs) ||
      parsedCheque.minor === null || parsedCheque.minor <= 0 ||
      parsedCheque.minor > invoice.availableToReserveMinor) {
      setError(t("DealReceiptEnterValidCheque")); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await registerCheque({ orgId, saleId, bank: chequeBank.trim(),
        chequeNumber: chequeNumber.trim(), chequeDate: chequeDateMs,
        amountMinor: parsedCheque.minor });
      setChequeBank(""); setChequeNumber(""); setChequeAmount("");
      setNotice(t("DealReceiptChequeRegistered"));
    } catch (error_) {
      showFailure(error_, "DealReceiptChequeActionFailed");
    } finally { setBusy(false); }
  }

  async function onRequestRefund() {
    if (!payoutAvailable || !canManage || busy || !refundCredit?.receiptPosted) return;
    if (parsedRefund.minor === null || parsedRefund.minor <= 0 ||
      parsedRefund.minor > refundCredit.availableUnappliedMinor || !refundReason.trim()) {
      setError(t("DealReceiptEnterValidCredit"));
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await requestRefund({ orgId, receiptMovementId: refundCredit.receiptMovementId,
        amountMinor: parsedRefund.minor, method: REFUND_METHOD, reason: refundReason.trim() });
      setRefundMovement(""); setRefundAmount(""); setRefundReason("");
      setNotice(t("RetainedCreditRefundRequested"));
    } catch (error_) {
      showFailure(error_, "DealReceiptActionFailed");
    } finally { setBusy(false); }
  }

  async function onAdvanceCheque(chequeId: Id<"postDatedCheques">, state: "HELD" | "DEPOSITED", chequeAmountMajor: number) {
    // A HELD cheque is deposited only while the live invoice can still cover it
    // (the server refuses otherwise). A DEPOSITED one is already at the bank, so
    // it can always be cleared: the server books it as invoice receipt or, when
    // the sale was cancelled or is now covered, as unreserved customer credit.
    // Neither is a pilot-switched door on the server, so neither is here.
    if (!canManage || busy) return;
    if (state === "HELD" && !invoiceCoversCheque(chequeAmountMajor)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (state === "HELD") {
        await depositCheque({ orgId, chequeId });
        setNotice(t("DealReceiptChequeDepositNotice"));
      } else {
        const intent = `sale-clear-cheque:${chequeId}`;
        await clearCheque({ orgId, chequeId, idempotencyKey: command.for(intent) });
        command.retire(intent);
        // Never "reserved for this invoice": the server reserves only on a live
        // intent with the doors open; otherwise the face is unreserved credit.
        setNotice(t("DealReceiptChequeClearedToCredit"));
      }
    } catch (error_) {
      showFailure(error_, "DealReceiptChequeActionFailed");
    } finally { setBusy(false); }
  }

  function renderInvoice(): ReactNode {
    if (!status || !invoice) return null;
    const canReceive = invoiceOpen && receiptCurrencyMatches && canManage;
    return (
      <>
        <dl className="divide-y divide-border text-sm">
          <BalanceRow label={t("CustomerInvoiceBalance")} value={money(invoice.outstandingMinor)} />
          <BalanceRow label={t("DealReceiptAvailableToApply")} value={money(invoice.availableToReserveMinor)} />
        </dl>
        {status.saleStatus === "COMPLETED" && invoice.availableToReserveMinor === 0 &&
          <p className="text-sm text-muted-foreground">{t("DealReceiptFullyCovered")}</p>}
        {!receiptCurrencyMatches && <p className="text-sm text-muted-foreground">
          {t("DealReceiptCurrencyMismatch")}</p>}
        {canManage && !doorsAvailable && (
          <p id={doorsReasonId} role="note" data-testid="deal-invoice-doors-unavailable"
            className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {t("SaleInvoiceDoorsUnavailable")}</p>
        )}
        {canReceive && (
          <section className="grid gap-3 sm:grid-cols-2" aria-label={t("DealReceiptRecordHeading")}>
            <h3 className="font-medium sm:col-span-2">{t("DealReceiptRecordHeading")}</h3>
            <div><Label htmlFor="sale-receipt-amount">{t("DealReceiptAmount")}</Label>
              <Input id="sale-receipt-amount" inputMode="decimal" value={amount}
                disabled={!!paymentAttempt || busy || !doorsAvailable} aria-describedby={doorsReason}
                onChange={(event) => setAmount(event.target.value)} /></div>
            <div><Label htmlFor="sale-receipt-method">{t("DealReceiptMethod")}</Label>
              <select id="sale-receipt-method" className="flex h-10 w-full rounded-md border bg-background px-3"
                value={method} disabled={!!paymentAttempt || busy || !doorsAvailable} aria-describedby={doorsReason}
                onChange={(event) => setMethod(event.target.value as ReceiptMethod)}>
                <option value="CASH">{t("MethodCash")}</option>
                <option value="BANK_TRANSFER">{t("MethodBankTransfer")}</option>
              </select></div>
            <div><Label htmlFor="sale-receipt-date">{t("DealReceiptDate")}</Label>
              <Input id="sale-receipt-date" type="date" max={economicTodayDateInput()} value={date}
                disabled={!!paymentAttempt || busy || !doorsAvailable} aria-describedby={doorsReason}
                onChange={(event) => setDate(event.target.value)} /></div>
            <div><Label htmlFor="sale-receipt-reference">{t("DealReceiptReference")}</Label>
              <Input id="sale-receipt-reference" value={reference}
                disabled={!!paymentAttempt || busy || !doorsAvailable} aria-describedby={doorsReason}
                onChange={(event) => setReference(event.target.value)} /></div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t("DealReceiptRetainedExplanation")}</p>
            <Button className="w-fit" disabled={busy || !doorsAvailable} aria-describedby={doorsReason}
              onClick={onRecord}>{t("DealReceiptRecordButton")}</Button>
          </section>
        )}
        <section className="space-y-3" aria-label={t("DealReceiptChequeHeading")}>
          <h3 className="font-medium">{t("DealReceiptChequeHeading")}</h3>
          <p className="text-xs text-muted-foreground">{t("DealReceiptChequeExplanation")}</p>
          {canReceive && <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="sale-cheque-bank">{t("DealReceiptChequeBank")}</Label>
              <Input id="sale-cheque-bank" value={chequeBank} disabled={busy || !doorsAvailable}
                aria-describedby={doorsReason} onChange={(event) => setChequeBank(event.target.value)} /></div>
            <div><Label htmlFor="sale-cheque-number">{t("DealReceiptChequeNumber")}</Label>
              <Input id="sale-cheque-number" value={chequeNumber} disabled={busy || !doorsAvailable}
                aria-describedby={doorsReason} onChange={(event) => setChequeNumber(event.target.value)} /></div>
            <div><Label htmlFor="sale-cheque-date">{t("DealReceiptChequeDate")}</Label>
              <Input id="sale-cheque-date" type="date" value={chequeDate} disabled={busy || !doorsAvailable}
                aria-describedby={doorsReason} onChange={(event) => setChequeDate(event.target.value)} /></div>
            <div><Label htmlFor="sale-cheque-amount">{t("DealReceiptAmount")}</Label>
              <Input id="sale-cheque-amount" inputMode="decimal" value={chequeAmount} disabled={busy || !doorsAvailable}
                aria-describedby={doorsReason} onChange={(event) => setChequeAmount(event.target.value)} /></div>
            <Button className="w-fit" disabled={busy || !doorsAvailable} aria-describedby={doorsReason}
              onClick={onRegisterCheque}>{t("DealReceiptRegisterCheque")}</Button>
          </div>}
          {cheques.status === "LoadingFirstPage" && <p className="text-sm">{t("Loading")}</p>}
          {cheques.results.length > 0 && <ul className="space-y-2 text-sm">{cheques.results.map((cheque) => {
            const held = cheque.status === "HELD";
            const depositable = held && invoiceCoversCheque(cheque.amount);
            const uncovered = held && status.saleStatus === "COMPLETED" && receiptCurrencyMatches && !depositable;
            return (
              <li key={cheque.chequeId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <span><bdi dir="ltr">{cheque.bank} #{cheque.chequeNumber}</bdi></span>
                <bdi dir="ltr" className="tabular-nums">{formatMoneyDisplay(cheque.amount, status.receiptCurrency, locale)}</bdi>
                <span>{t(held ? "DealReceiptChequeHeld" : "DealReceiptChequeDeposited")}</span>
                {status.saleStatus === "CANCELLED" && <span className="text-muted-foreground">
                  {t(held ? "RetainedCreditChequeCancelledHeld" : "RetainedCreditChequeBecomesCredit")}</span>}
                {uncovered && <span className="text-muted-foreground">{t("DealReceiptChequeExceedsInvoice")}</span>}
                {canManage && (!held || depositable) &&
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => onAdvanceCheque(cheque.chequeId, held ? "HELD" : "DEPOSITED", cheque.amount)}>
                    {t(held ? "DealReceiptDepositCheque" : "DealReceiptClearCheque")}</Button>}
              </li>
            );
          })}</ul>}
          {cheques.status === "CanLoadMore" && <Button size="sm" variant="outline"
            onClick={() => cheques.loadMore(20)}>{t("LoadMore")}</Button>}
        </section>
        <section className="space-y-3" aria-label={t("DealReceiptCreditHeading")}>
          <h3 className="font-medium">{t("DealReceiptCreditHeading")}</h3>
          {credits.status === "LoadingFirstPage" && <p className="text-sm">{t("Loading")}</p>}
          {credits.status === "Exhausted" && positions.length === 0 &&
            <p className="text-sm text-muted-foreground">{t("DealReceiptNoCredit")}</p>}
          {credits.status === "CanLoadMore" && positions.length === 0 &&
            <p className="text-sm text-muted-foreground">{t("DealReceiptMoreCredit")}</p>}
          {canManage && !payoutAvailable && positions.length > 0 && (
            <p id={payoutReasonId} role="note" data-testid="deal-credit-payout-unavailable"
              className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t("RetainedCreditPayoutUnavailable")}</p>
          )}
          {positions.length > 0 && <ul className="space-y-2 text-sm">{positions.map((position) => (
            <li key={position.receiptMovementId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <bdi dir="ltr" className="tabular-nums">{money(position.availableUnappliedMinor, position.currency)}</bdi>
              {position.createdAt && <span className="text-muted-foreground">
                {new Date(position.createdAt).toLocaleDateString(locale === "ar" ? "ar-JO-u-nu-latn" : "en-US")}
              </span>}
              <span className="text-muted-foreground">{position.receiptPosted
                ? t("DealReceiptPosted") : t("DealReceiptAwaitingPosting")}</span>
              {position.sourceChequeLabel && <span className="text-muted-foreground">
                {t("RetainedCreditFromCheque")} <bdi dir="ltr">{position.sourceChequeLabel}</bdi>
                {" · "}{t(position.originatingSaleStatus === "CANCELLED"
                  ? "RetainedCreditSaleCancelled" : "RetainedCreditSaleActive")}</span>}
              {canManage && position.receiptPosted && position.availableUnappliedMinor > 0 &&
                <Button size="sm" variant="outline" disabled={busy || !payoutAvailable} aria-describedby={payoutReason}
                  onClick={() => { setRefundMovement(position.receiptMovementId); setRefundAmount(""); }}>
                  {t("RetainedCreditRequestRefund")}</Button>}
              {position.originatingSaleStatus === "CANCELLED" && position.availableUnappliedMinor > 0 &&
                <span className="text-xs text-muted-foreground" title={t("RetainedCreditApplyElsewhereHint")}>
                  {t("RetainedCreditApplyElsewhere")}: {t("RetainedCreditApplyElsewhereHint")}</span>}
              {canManage && position.receiptPosted && position.currency === currency &&
                position.availableUnappliedMinor > 0 && invoiceOpen &&
                <Button size="sm" variant="outline" disabled={busy || !!reserveAttempt || !doorsAvailable}
                  aria-describedby={doorsReason}
                  onClick={() => { setSelectedMovement(position.receiptMovementId); setReserveAmount(""); }}>
                  {t("DealReceiptChooseCredit")}</Button>}
            </li>
          ))}</ul>}
          {credits.status === "CanLoadMore" && <Button variant="outline" size="sm"
            onClick={() => credits.loadMore(20)}>{t("LoadMore")}</Button>}
          {canManage && refundCredit && <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="credit-refund-amount">{t("RetainedCreditRefundAmount")}</Label>
              <Input id="credit-refund-amount" inputMode="decimal" value={refundAmount}
                disabled={busy || !payoutAvailable} aria-describedby={payoutReason}
                onChange={(event) => setRefundAmount(event.target.value)} /></div>
            <div><Label htmlFor="credit-refund-method">{t("RetainedCreditRefundMethod")}</Label>
              <select id="credit-refund-method" className="flex h-10 w-full rounded-md border bg-background px-3"
                defaultValue={REFUND_METHOD} disabled={busy || !payoutAvailable} aria-describedby={payoutReason}>
                <option value={REFUND_METHOD}>{t("MethodBankTransfer")}</option>
              </select></div>
            <div className="sm:col-span-2"><Label htmlFor="credit-refund-reason">{t("RetainedCreditRefundReason")}</Label>
              <Input id="credit-refund-reason" value={refundReason}
                disabled={busy || !payoutAvailable} aria-describedby={payoutReason}
                onChange={(event) => setRefundReason(event.target.value)} /></div>
            <Button className="w-fit" disabled={busy || !payoutAvailable} aria-describedby={payoutReason}
              onClick={onRequestRefund}>{t("RetainedCreditRefundSubmit")}</Button>
          </div>}
          {canManage && (selectedCredit || reserveAttempt) && <div className="flex flex-wrap items-end gap-2">
            <div><Label htmlFor="sale-reserve-amount">{t("DealReceiptAmount")}</Label>
              <Input id="sale-reserve-amount" inputMode="decimal" value={reserveAmount}
                disabled={!!reserveAttempt || busy || !doorsAvailable} aria-describedby={doorsReason}
                onChange={(event) => setReserveAmount(event.target.value)} /></div>
            <Button disabled={busy || !doorsAvailable} aria-describedby={doorsReason}
              onClick={onReserve}>{t("DealReceiptReserveButton")}</Button>
          </div>}
        </section>
        <section className="space-y-2" aria-label={t("DealReceiptPendingHeading")}>
          <h3 className="font-medium">{t("DealReceiptPendingHeading")}</h3>
          {pending.length === 0 && <p className="text-sm text-muted-foreground">{t("DealReceiptNoPending")}</p>}
          {pending.map((application) => <div key={application.applicationId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
            <bdi dir="ltr" className="tabular-nums">{money(application.amountMinor, application.currency)}</bdi>
            <span>{application.readiness === "ORIGINS_VERIFIED" ? t("DealReceiptOriginsVerified")
              : t(`DealReceiptReason_${application.reason ?? "PROOF_UNAVAILABLE"}`)}</span>
            {canManage && application.readiness === "ORIGINS_VERIFIED" && status.saleStatus === "COMPLETED" &&
              <Button size="sm" disabled={busy || !doorsAvailable} aria-describedby={doorsReason}
                onClick={() => onActivate(application.applicationId, application.amountMinor)}>
                {t("DealReceiptTryActivateButton")}</Button>}
          </div>)}
          <div className="flex flex-wrap gap-2">
            {pendingCursor !== null && <Button variant="outline" size="sm" onClick={() => setPendingCursor(null)}>
              {t("DealReceiptFirstPage")}</Button>}
            {!status.isDone && <Button variant="outline" size="sm"
              onClick={() => setPendingCursor(status.continueCursor)}>{t("DealReceiptNextPage")}</Button>}
          </div>
        </section>
      </>
    );
  }

  let body: ReactNode;
  if (status === undefined) body = <p className="text-sm text-muted-foreground">{t("Loading")}</p>;
  else if (invoice) body = renderInvoice();
  else body = <p className="text-sm text-muted-foreground">{t("DealReceiptNoInvoice")}</p>;

  return (
    <Card className="mt-6" data-testid="deal-invoice-receipts">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          {t("DealReceiptPanelTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {body}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <output className="block text-sm">{notice}</output>}
      </CardContent>
    </Card>
  );
}
