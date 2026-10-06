"use client";

import { useEffect, useState } from "react";
import { Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { exactMinorFromMajor } from "@/lib/moneyDisplay";
import {
  economicDateInputToMs,
  economicTodayDateInput,
  msToDateInput,
  todayDateInput,
} from "@/lib/dateInput";

function parseMajor(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return exactMinorFromMajor(parsed, scale);
}

/**
 * The legal invoice date is a DOCUMENT date — the one printed on the paper —
 * so, unlike a movement date, it is never pre-filled with the ledger's UTC day
 * when that differs from the operator's own day: at 01:30 in Amman on
 * 1 October that would silently file an invoice dated 1 October under
 * 30 September, i.e. in the previous period (SCRUM-596). The server refuses a
 * day its clock has not reached, so the latest pickable day is the earlier of
 * the two calendars, and while the operator's day has not begun on the ledger
 * nothing is pre-filled and the operator must pick the paper's date.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function untouchedDefault(bounds: { localDayNotOpen: boolean; latestDay: string }) {
  return bounds.localDayNotOpen ? "" : bounds.latestDay;
}

function invoiceDayBounds() {
  const localDay = todayDateInput();
  const ledgerDay = economicTodayDateInput();
  const localDayNotOpen = localDay > ledgerDay;
  const nextLedgerDayAt = economicDateInputToMs(ledgerDay) + ONE_DAY_MS;
  const now = new Date();
  // Local construction, so a DST change still lands on midnight.
  const nextLocalDayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return {
    localDayNotOpen,
    latestDay: localDayNotOpen ? ledgerDay : localDay,
    /** The operator's clock time at which the ledger's next day begins. */
    nextLedgerDayAt,
    /** Either calendar turning over moves the bounds. */
    nextBoundaryAt: Math.min(nextLedgerDayAt, nextLocalDayAt),
  };
}

type IssuedTo = "CUSTOMER" | "FINANCE_COMPANY" | "OTHER";

export type RecordLegalInvoiceValues = {
  legalInvoiceAmountMinor: number;
  legalInvoiceNumber: string;
  legalInvoiceDate: number;
  issuedTo: IssuedTo;
  issuedToOther?: string;
};

type RecordLegalInvoiceDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  scale: number;
  currency: string;
  existing?: {
    amountMinor?: number;
    number?: string;
    date?: number;
    issuedTo?: string;
    issuedToOther?: string;
  };
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: RecordLegalInvoiceValues) => Promise<void>;
};

export function RecordLegalInvoiceDialog({
  open,
  submitting,
  error,
  scale,
  currency,
  existing,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordLegalInvoiceDialogProps>) {
  const [amount, setAmount] = useState(() =>
    existing?.amountMinor !== undefined ? String(existing.amountMinor / Math.pow(10, scale)) : ""
  );
  const [number, setNumber] = useState(() => existing?.number ?? "");
  // A stored date was accepted by the server, so it stays saveable even
  // where it is past this operator's local day (an editor behind UTC).
  const [storedDay] = useState(() => (existing?.date ? msToDateInput(existing.date) : null));
  // The pre-fill is offered only for the day the form opened on. If the day
  // changes while it is open, neither the old day nor the new one is assumed:
  // a pick of the shown day fires no change event, so "untouched" cannot be
  // told from "confirmed" (Sol 6 SCRUM-596-3) and the operator picks again.
  const [openedDefault] = useState(() => untouchedDefault(invoiceDayBounds()));
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [issuedTo, setIssuedTo] = useState<IssuedTo>(() =>
    existing?.issuedTo === "CUSTOMER" || existing?.issuedTo === "OTHER"
      ? existing.issuedTo
      : "FINANCE_COMPANY"
  );
  const [issuedToOther, setIssuedToOther] = useState(() => existing?.issuedToOther ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const bounds = invoiceDayBounds();
  const { localDayNotOpen, latestDay, nextLedgerDayAt, nextBoundaryAt } = bounds;
  const dayChangedWhileOpen = (current: typeof bounds) =>
    pickedDay === null && storedDay === null && untouchedDefault(current) !== openedDefault;
  const dayChanged = dayChangedWhileOpen(bounds);
  const date = pickedDay ?? storedDay ?? (dayChanged ? "" : openedDefault);
  const dateHintId = localDayNotOpen
    ? "legal-invoice-date-hint"
    : dayChanged
      ? "legal-invoice-date-changed"
      : undefined;
  // The bounds follow both clocks, so re-render when the local or the ledger's
  // day turns over, and when the tab regains focus or visibility in case its
  // timer was suspended. The operator's pick is state and survives.
  const [, refreshBounds] = useState(0);
  useEffect(() => {
    if (!open) return;
    const refresh = () => refreshBounds((n) => n + 1);
    // A second late: a timer that fires early would re-render on the old day.
    const timer = setTimeout(refresh, Math.max(0, nextBoundaryAt - Date.now()) + 1000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, nextBoundaryAt]);
  const amountMinor = parseMajor(amount, scale);
  const isInvalid =
    amountMinor === null ||
    !number.trim() ||
    !date ||
    (issuedTo === "OTHER" && !issuedToOther.trim());

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || isInvalid) return;
    if (!dayChanged && dayChangedWhileOpen(invoiceDayBounds())) {
      // The refresh lands just after midnight (or late, after sleep): the
      // pre-fill of a day that has ended is withdrawn rather than sent.
      refreshBounds((n) => n + 1);
      return;
    }

    setLocalError(null);
    try {
      // The caller closes the dialog once the save succeeds; on a refusal it
      // stays open with the operator's entries and the reason.
      await onSubmit({
        legalInvoiceAmountMinor: amountMinor,
        legalInvoiceNumber: number.trim(),
        legalInvoiceDate: economicDateInputToMs(date),
        issuedTo,
        issuedToOther: issuedTo === "OTHER" ? issuedToOther.trim() : undefined,
      });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t("UnexpectedError"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            {t("RecordLegalInvoice")}
          </DialogTitle>
          <DialogDescription>{t("RecordLegalInvoiceDesc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-amount">
              {t("LegalInvoiceAmount")} (<bdi dir="ltr">{currency}</bdi>)
            </Label>
            <Input
              id="legal-invoice-amount"
              inputMode="decimal"
              className="tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-number">{t("LegalInvoiceNumber")}</Label>
            <Input
              id="legal-invoice-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="INV-0001"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-date">{t("LegalInvoiceDate")}</Label>
            <Input
              id="legal-invoice-date"
              type="date"
              max={storedDay && storedDay > latestDay ? storedDay : latestDay}
              value={date}
              onChange={(e) => setPickedDay(e.target.value)}
              aria-describedby={dateHintId}
              required
            />
            {localDayNotOpen && (
              <p id="legal-invoice-date-hint" className="text-xs text-muted-foreground">
                {/* The time is isolated so Arabic text cannot reorder "03:00 AM". */}
                {t("LegalInvoiceDateNotOpenYet")
                  .split("{time}")
                  .flatMap((part, index) =>
                    index === 0
                      ? [part]
                      : [
                          <bdi key={index} dir="ltr">
                            {new Date(nextLedgerDayAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </bdi>,
                          part,
                        ]
                  )}
              </p>
            )}
            {dateHintId === "legal-invoice-date-changed" && (
              <p id="legal-invoice-date-changed" className="text-xs text-muted-foreground">
                {/* Opened blank before the ledger's day: only the ledger moved. */}
                {t(openedDefault === "" ? "LegalInvoiceDateNowOpen" : "LegalInvoiceDateDayChanged")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-issued-to">{t("LegalInvoiceIssuedTo")}</Label>
            <Select value={issuedTo} onValueChange={(val: IssuedTo) => setIssuedTo(val)}>
              <SelectTrigger id="legal-invoice-issued-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FINANCE_COMPANY">{t("PartyFinancier")}</SelectItem>
                <SelectItem value="CUSTOMER">{t("Customer")}</SelectItem>
                <SelectItem value="OTHER">{t("Other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {issuedTo === "OTHER" && (
            <div className="space-y-1.5">
              <Label htmlFor="legal-invoice-other">{t("LegalInvoiceIssuedToOther")}</Label>
              <Input
                id="legal-invoice-other"
                value={issuedToOther}
                onChange={(e) => setIssuedToOther(e.target.value)}
                required
              />
            </div>
          )}

          {(error || localError) && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error || localError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={submitting || isInvalid}>
              {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
              {t("SubmitLegalInvoice")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
