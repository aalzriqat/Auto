"use client";

import { useId, useState, type FormEvent } from "react";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { economicDateInputToMs, economicTodayDateInput, msToDateInput } from "@/lib/dateInput";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";
import { parseKnownCurrencyMinor } from "../setup/openingMoneyInput";
import type { BankAccountSummary } from "./types";

type Transfer = NonNullable<FunctionReturnType<typeof api.bankTransfers.recent>>["transfers"][number];
type Account = Pick<BankAccountSummary, "_id" | "name" | "currency" | "isActive">;

const CASH = "cash";
const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";

function AccountSelect({ label, accounts, value, change }: {
  label: string; accounts: Account[]; value: string; change: (value: string) => void;
}) {
  const id = useId();
  const { t } = useLanguage();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={selectClass} value={value} onChange={event => change(event.target.value)} required>
        <option value="">{t("BankTransferChooseAccount")}</option>
        <option value={CASH}>{t("DashboardCashOnHand")}</option>
        {accounts.map(bank => <option key={bank._id} value={bank._id}>{bank.name} · {bank.currency}</option>)}
      </select>
    </div>
  );
}

function RecordTransferDialog({ orgId, accounts }: { orgId: Id<"organizations">; accounts: Account[] }) {
  const { t, isRtl } = useLanguage();
  const record = useMutation(api.bankTransfers.record);
  const command = useCommandIdentity();
  const field = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(economicTodayDateInput);
  const [reference, setReference] = useState("");
  const fromBank = accounts.find(bank => bank._id === from);
  const toBank = accounts.find(bank => bank._id === to);
  const fromBankAccountId = from === CASH ? null : fromBank?._id;
  const toBankAccountId = to === CASH ? null : toBank?._id;
  const currency = fromBank?.currency ?? toBank?.currency ?? "";
  const differentCurrencies = !!fromBank && !!toBank && fromBank.currency !== toBank.currency;
  const amountMinor = parseKnownCurrencyMinor(amount, currency);
  const today = economicTodayDateInput();
  const selectedAccountingDate = economicDateInputToMs(date);
  const confirmation = reference.trim();
  const valid = fromBankAccountId !== undefined && toBankAccountId !== undefined && fromBankAccountId !== toBankAccountId &&
    !differentCurrencies && amountMinor !== null && amountMinor > 0 && Number.isSafeInteger(selectedAccountingDate) &&
    date <= today && !!confirmation;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountingDate = selectedAccountingDate;
    if (!valid || busy || typeof accountingDate !== "number") return;
    const intent = JSON.stringify([orgId, fromBankAccountId, toBankAccountId, currency, amountMinor, accountingDate, confirmation]);
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return;
    setBusy(true);
    try {
      await record({ orgId, fromBankAccountId, toBankAccountId, amountMinor, currency, accountingDate,
        reference: confirmation, idempotencyKey });
      command.retire(intent);
      setOpen(false);
      setFrom("");
      setTo("");
      setAmount("");
      setDate(economicTodayDateInput());
      setReference("");
      toast.success(t("BankTransferRecorded"));
    } catch {
      toast.error(t("BankTransferRecordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogTrigger asChild><Button type="button" size="sm" disabled={!accounts.length}>{t("BankTransferRecord")}</Button></DialogTrigger>
      <DialogContent dir={isRtl ? "rtl" : "ltr"} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("BankTransferRecord")}</DialogTitle>
          <DialogDescription>{t("BankTransferEvidenceHelp")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <AccountSelect label={t("BankTransferFrom")} accounts={accounts} value={from} change={setFrom} />
            <AccountSelect label={t("BankTransferTo")} accounts={accounts} value={to} change={setTo} />
          </div>
          {differentCurrencies && <p className="text-sm text-destructive" role="alert">{t("BankTransferCurrencyMismatch")}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={field + "-amount"}>{t("Amount")} {currency && <bdi>{currency}</bdi>}</Label>
              <Input id={field + "-amount"} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}
                aria-invalid={amount.length > 0 && amountMinor === null} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={field + "-date"}>{t("BankTransferDate")}</Label>
              <Input id={field + "-date"} type="date" max={today} value={date}
                onChange={event => setDate(event.target.value)} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={field + "-reference"}>{t("BankTransferReference")}</Label>
            <Input id={field + "-reference"} value={reference} onChange={event => setReference(event.target.value)} maxLength={160} required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={!valid || busy}>{t("BankTransferRecord")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReverseTransferDialog({ orgId, transfer, close }: {
  orgId: Id<"organizations">; transfer: Transfer; close: () => void;
}) {
  const { t, isRtl } = useLanguage();
  const reverse = useMutation(api.bankTransfers.reverse);
  const command = useCommandIdentity();
  const field = useId();
  const [date, setDate] = useState(economicTodayDateInput);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const transferDay = msToDateInput(transfer.accountingDate);
  const today = economicTodayDateInput();
  const selectedAccountingDate = date === transferDay ? transfer.accountingDate : economicDateInputToMs(date);
  const validDate = Number.isSafeInteger(selectedAccountingDate) && date >= transferDay && date <= today;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const explanation = reason.trim();
    const accountingDate = selectedAccountingDate;
    if (busy || !explanation || !validDate || typeof accountingDate !== "number") return;
    const eventId = transfer.eventId;
    const intent = JSON.stringify([orgId, eventId, accountingDate, explanation]);
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return;
    setBusy(true);
    try {
      await reverse({ orgId, eventId, accountingDate, reason: explanation, idempotencyKey });
      command.retire(intent);
      toast.success(t("BankTransferReversed"));
      close();
    } catch {
      toast.error(t("BankTransferReverseFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={value => { if (!value && !busy) close(); }}>
      <DialogContent dir={isRtl ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle>{t("BankTransferReverse")}</DialogTitle>
          <DialogDescription>{t("BankTransferReversalHelp")} <bdi>{transfer.reference}</bdi></DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={field + "-date"}>{t("BankTransferDate")}</Label>
            <Input id={field + "-date"} type="date" min={transferDay} max={today} value={date}
              onChange={event => setDate(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={field + "-reason"}>{t("BankTransferReversalReason")}</Label>
            <Input id={field + "-reason"} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t("Cancel")}</Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim() || !validDate}>
              {t("BankTransferReverse")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BankTransfersPanel({ orgId, accounts, canManageFinance }: {
  orgId: Id<"organizations">; accounts: Account[]; canManageFinance: boolean;
}) {
  const { t, locale } = useLanguage();
  const [cursors, setCursors] = useState<string[]>([]);
  const history = useQuery(api.bankTransfers.recent, { orgId, cursor: cursors.at(-1) });
  const [reversing, setReversing] = useState<Transfer | null>(null);
  const cash = t("DashboardCashOnHand");
  const nextCursor = history?.nextCursor;
  const ledgerDate = new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-GB", {
    timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
  });
  return (
    <section id="bank-transfers" className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{t("BankTransfers")}</h3>
        {canManageFinance && <RecordTransferDialog orgId={orgId} accounts={accounts.filter(account => account.isActive)} />}
      </div>
      {history === undefined ? <p className="text-sm text-muted-foreground">{t("Loading")}</p>
        : history === null ? <p className="text-sm text-muted-foreground">{t("BankTransferHistoryUnavailable")}</p>
        : history.transfers.length ? (
          <ul className="divide-y">
            {history.transfers.map(transfer => (
              <li key={transfer.eventId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 space-y-1">
                  <div className="break-words font-medium">
                    {t("BankTransferFrom")} <bdi>{transfer.fromBankName ?? cash}</bdi>{" · "}
                    {t("BankTransferTo")} <bdi>{transfer.toBankName ?? cash}</bdi>
                  </div>
                  <div className="break-words text-muted-foreground">
                    <bdi>{transfer.reference}</bdi>{" · "}<bdi>{ledgerDate.format(transfer.accountingDate)}</bdi>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <bdi className="font-semibold tabular-nums">
                    {formatExactMinorAmount(transfer.amountMinor, transfer.currency)} {moneyDisplayLabel(transfer.currency, locale)}
                  </bdi>
                  {transfer.reversed ? <span className="text-muted-foreground">{t("BankTransferReversed")}</span>
                    : canManageFinance && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setReversing(transfer)}>
                        {t("BankTransferReverse")}
                      </Button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t("BankTransferNone")}</p>}
      {(cursors.length > 0 || nextCursor) && (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 0 && (
            <Button type="button" size="sm" variant="outline" onClick={() => setCursors(current => current.slice(0, -1))}>
              {t("BankTransferNewer")}
            </Button>
          )}
          {nextCursor && (
            <Button type="button" size="sm" variant="outline" onClick={() => setCursors(current => [...current, nextCursor])}>
              {t("BankTransferOlder")}
            </Button>
          )}
        </div>
      )}
      {canManageFinance && reversing && <ReverseTransferDialog orgId={orgId} transfer={reversing}
        key={reversing.eventId} close={() => setReversing(null)} />}
    </section>
  );
}
