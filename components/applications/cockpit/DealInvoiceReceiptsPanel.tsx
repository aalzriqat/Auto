"use client";

import { useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { dateInputToUtcMs, economicDateInputToMs, economicTodayDateInput, todayDateInput } from "@/lib/dateInput";
import { formatMoneyDisplay, moneyDisplayScale, parseTypedAmount } from "@/lib/moneyDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ReceiptMethod = "CASH" | "BANK_TRANSFER";
type PaymentAttempt = { amount: number; method: ReceiptMethod; paymentDate: number; reference?: string };
type ReserveAttempt = { receiptMovementId: Id<"receiptMovements">; amountMinor: number };

export function DealInvoiceReceiptsPanel({ orgId, saleId }: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
}>) {
  const { t, locale } = useLanguage();
  const { hasPermission, isLoading } = usePermissions();
  const canView = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE);
  const canManage = !isLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const command = useCommandIdentity();
  const recordPayment = useMutation(api.collections.recordPayment);
  const reserve = useMutation(api.collections.reserveSaleInvoiceReceipt);
  const activate = useMutation(api.collections.activateSaleInvoiceReceipt);
  const registerCheque = useMutation(api.collections.registerSaleInvoiceCheque);
  const depositCheque = useMutation(api.collections.depositCheque);
  const clearCheque = useMutation(api.collections.clearCheque);
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
  const pending = status?.page ?? [];
  const positions = credits.results ?? [];
  const selectedCredit = positions.find((position) => position.receiptMovementId === selectedMovement);
  const parsedPayment = parseTypedAmount(amount, moneyDisplayScale(currency));
  const parsedReserve = parseTypedAmount(reserveAmount, moneyDisplayScale(currency));
  const parsedCheque = parseTypedAmount(chequeAmount, moneyDisplayScale(currency));
  const paymentIntent = `sale-receipt:${saleId}`;
  const reserveIntent = `sale-reserve:${saleId}`;

  async function onRecord() {
    if (!status?.customerId || !canManage || !invoice || !receiptCurrencyMatches || busy) return;
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
    } catch {
      setError(t("DealReceiptActionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onReserve() {
    if (!canManage || !invoice || busy) return;
    if (!reserveAttempt && (!selectedCredit || !selectedCredit.receiptPosted ||
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
    } catch {
      setError(t("DealReceiptActionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onActivate(applicationId: Id<"invoiceReceiptApplications">, amountMinor: number) {
    if (!canManage || busy) return;
    const intent = `sale-activate:${applicationId}`;
    setBusy(true); setError(""); setNotice("");
    try {
      await activate({ orgId, applicationId, amountMinor, idempotencyKey: command.for(intent) });
      command.retire(intent);
      setNotice(t("DealReceiptActivated"));
    } catch {
      setError(t("DealReceiptActionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onRegisterCheque() {
    if (!canManage || !invoice || !receiptCurrencyMatches || busy) return;
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
    } catch {
      setError(t("DealReceiptChequeActionFailed"));
    } finally { setBusy(false); }
  }

  async function onAdvanceCheque(chequeId: Id<"postDatedCheques">, state: "HELD" | "DEPOSITED") {
    if (!canManage || busy || status?.saleStatus !== "COMPLETED" ||
      !invoice || invoice.availableToReserveMinor <= 0 || !receiptCurrencyMatches) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (state === "HELD") {
        await depositCheque({ orgId, chequeId });
        setNotice(t("DealReceiptChequeDepositNotice"));
      } else {
        const intent = `sale-clear-cheque:${chequeId}`;
        await clearCheque({ orgId, chequeId, idempotencyKey: command.for(intent) });
        command.retire(intent);
        setNotice(t("DealReceiptChequeCleared"));
      }
    } catch {
      setError(t("DealReceiptChequeActionFailed"));
    } finally { setBusy(false); }
  }

  return (
    <Card className="mt-6" data-testid="deal-invoice-receipts">
      <CardHeader><CardTitle>{t("DealReceiptPanelTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {status === undefined ? <p>{t("Loading")}</p> : !invoice ? (
          <p className="text-sm text-muted-foreground">{t("DealReceiptNoInvoice")}</p>
        ) : (
          <>
            <p className="text-sm">{t("CustomerInvoiceBalance")}: <strong>{money(invoice.outstandingMinor)}</strong></p>
            <p className="text-sm text-muted-foreground">{t("DealReceiptAvailableToApply")}: {money(invoice.availableToReserveMinor)}</p>
            {status.saleStatus === "COMPLETED" && invoice.availableToReserveMinor === 0 &&
              <p className="text-sm text-muted-foreground">{t("DealReceiptFullyCovered")}</p>}
            {!receiptCurrencyMatches && <p className="text-sm text-muted-foreground">
              {t("DealReceiptCurrencyMismatch")}</p>}
            {status.saleStatus === "COMPLETED" && invoice.availableToReserveMinor > 0 &&
              receiptCurrencyMatches && canManage && (
              <section className="grid gap-3 sm:grid-cols-2" aria-label={t("DealReceiptRecordHeading")}>
                <h3 className="sm:col-span-2 font-medium">{t("DealReceiptRecordHeading")}</h3>
                <div><Label htmlFor="sale-receipt-amount">{t("DealReceiptAmount")}</Label>
                  <Input id="sale-receipt-amount" inputMode="decimal" value={amount} disabled={!!paymentAttempt || busy}
                    onChange={(event) => setAmount(event.target.value)} /></div>
                <div><Label htmlFor="sale-receipt-method">{t("DealReceiptMethod")}</Label>
                  <select id="sale-receipt-method" className="flex h-10 w-full rounded-md border bg-background px-3"
                    value={method} disabled={!!paymentAttempt || busy}
                    onChange={(event) => setMethod(event.target.value as ReceiptMethod)}>
                    <option value="CASH">{t("MethodCash")}</option>
                    <option value="BANK_TRANSFER">{t("MethodBankTransfer")}</option>
                  </select></div>
                <div><Label htmlFor="sale-receipt-date">{t("DealReceiptDate")}</Label>
                  <Input id="sale-receipt-date" type="date" max={economicTodayDateInput()} value={date}
                    disabled={!!paymentAttempt || busy} onChange={(event) => setDate(event.target.value)} /></div>
                <div><Label htmlFor="sale-receipt-reference">{t("DealReceiptReference")}</Label>
                  <Input id="sale-receipt-reference" value={reference} disabled={!!paymentAttempt || busy}
                    onChange={(event) => setReference(event.target.value)} /></div>
                <p className="text-xs text-muted-foreground sm:col-span-2">{t("DealReceiptRetainedExplanation")}</p>
                <Button className="w-fit" disabled={busy} onClick={onRecord}>{t("DealReceiptRecordButton")}</Button>
              </section>
            )}
            <section className="space-y-3" aria-label={t("DealReceiptChequeHeading")}>
              <h3 className="font-medium">{t("DealReceiptChequeHeading")}</h3>
              <p className="text-xs text-muted-foreground">{t("DealReceiptChequeExplanation")}</p>
              {status.saleStatus === "COMPLETED" && invoice.availableToReserveMinor > 0 &&
                receiptCurrencyMatches && canManage && <div className="grid gap-3 sm:grid-cols-2">
                <div><Label htmlFor="sale-cheque-bank">{t("DealReceiptChequeBank")}</Label>
                  <Input id="sale-cheque-bank" value={chequeBank} disabled={busy}
                    onChange={(event) => setChequeBank(event.target.value)} /></div>
                <div><Label htmlFor="sale-cheque-number">{t("DealReceiptChequeNumber")}</Label>
                  <Input id="sale-cheque-number" value={chequeNumber} disabled={busy}
                    onChange={(event) => setChequeNumber(event.target.value)} /></div>
                <div><Label htmlFor="sale-cheque-date">{t("DealReceiptChequeDate")}</Label>
                  <Input id="sale-cheque-date" type="date" value={chequeDate} disabled={busy}
                    onChange={(event) => setChequeDate(event.target.value)} /></div>
                <div><Label htmlFor="sale-cheque-amount">{t("DealReceiptAmount")}</Label>
                  <Input id="sale-cheque-amount" inputMode="decimal" value={chequeAmount} disabled={busy}
                    onChange={(event) => setChequeAmount(event.target.value)} /></div>
                <Button className="w-fit" disabled={busy} onClick={onRegisterCheque}>
                  {t("DealReceiptRegisterCheque")}</Button>
              </div>}
              {cheques.status === "LoadingFirstPage" && <p className="text-sm">{t("Loading")}</p>}
              {cheques.results.length > 0 && <ul className="space-y-2 text-sm">{cheques.results.map((cheque) =>
                <li key={cheque.chequeId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span><bdi dir="ltr">{cheque.bank} #{cheque.chequeNumber}</bdi></span>
                  <span>{formatMoneyDisplay(cheque.amount, status.receiptCurrency, locale)}</span>
                  <span>{t(cheque.status === "HELD" ? "DealReceiptChequeHeld" : "DealReceiptChequeDeposited")}</span>
                  {canManage && status.saleStatus === "COMPLETED" &&
                    invoice.availableToReserveMinor > 0 && receiptCurrencyMatches &&
                    <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => onAdvanceCheque(cheque.chequeId,
                      cheque.status === "HELD" ? "HELD" : "DEPOSITED")}>
                    {t(cheque.status === "HELD" ? "DealReceiptDepositCheque" : "DealReceiptClearCheque")}</Button>}
                </li>)}</ul>}
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
              {positions.length > 0 && <ul className="space-y-2 text-sm">{positions.map((position) => (
                <li key={position.receiptMovementId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span>{money(position.availableUnappliedMinor, position.currency)}</span>
                  {position.createdAt && <span className="text-muted-foreground">
                    {new Date(position.createdAt).toLocaleDateString(locale === "ar" ? "ar-JO-u-nu-latn" : "en-US")}
                  </span>}
                  <span className="text-muted-foreground">{position.receiptPosted
                    ? t("DealReceiptPosted") : t("DealReceiptAwaitingPosting")}</span>
                  {canManage && position.receiptPosted && position.currency === currency &&
                    position.availableUnappliedMinor > 0 && status.saleStatus === "COMPLETED" &&
                    invoice.availableToReserveMinor > 0 &&
                    <Button size="sm" variant="outline" disabled={busy || !!reserveAttempt}
                      onClick={() => { setSelectedMovement(position.receiptMovementId); setReserveAmount(""); }}>
                      {t("DealReceiptChooseCredit")}</Button>}
                </li>
              ))}</ul>}
              {credits.status === "CanLoadMore" && <Button variant="outline" size="sm"
                onClick={() => credits.loadMore(20)}>{t("LoadMore")}</Button>}
              {canManage && (selectedCredit || reserveAttempt) && <div className="flex flex-wrap items-end gap-2">
                <div><Label htmlFor="sale-reserve-amount">{t("DealReceiptAmount")}</Label>
                  <Input id="sale-reserve-amount" inputMode="decimal" value={reserveAmount}
                    disabled={!!reserveAttempt || busy} onChange={(event) => setReserveAmount(event.target.value)} /></div>
                <Button disabled={busy} onClick={onReserve}>{t("DealReceiptReserveButton")}</Button>
              </div>}
            </section>
            <section className="space-y-2" aria-label={t("DealReceiptPendingHeading")}>
              <h3 className="font-medium">{t("DealReceiptPendingHeading")}</h3>
              {pending.length === 0 && <p className="text-sm text-muted-foreground">{t("DealReceiptNoPending")}</p>}
              {pending.map((application) => <div key={application.applicationId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                <span>{money(application.amountMinor, application.currency)}</span>
                <span>{application.readiness === "ORIGINS_VERIFIED" ? t("DealReceiptOriginsVerified")
                  : t(`DealReceiptReason_${application.reason ?? "PROOF_UNAVAILABLE"}`)}</span>
                {canManage && application.readiness === "ORIGINS_VERIFIED" && status.saleStatus === "COMPLETED" &&
                  <Button size="sm" disabled={busy} onClick={() => onActivate(application.applicationId, application.amountMinor)}>
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
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
      </CardContent>
    </Card>
  );
}
