"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";

/**
 * SCRUM-435 - record that the dealership paid the customer's deposit and its own
 * contribution to the finance company. Sits BEFORE "confirm the transfer": the
 * finance company sends the full approved amount, and this is what the
 * dealership owes back out of it.
 *
 * The amount is never typed. It is the figure the finalized deal froze, shown
 * read-only with what it is made of, and the server refuses the payment if the
 * figure the operator saw is no longer the one due.
 *
 * Mounted without its own trigger: the DISBURSEMENT step of the deal rail owns
 * the action, like the two confirmations beside it.
 */

const METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "CARD"] as const;
export type ForwardPaymentMethod = (typeof METHODS)[number];

const MAX_REFERENCE_CHARS = 200;

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type ForwardPaymentValues = {
  method: ForwardPaymentMethod;
  /** UTC midnight of the calendar day the operator picked. */
  paidAt: number;
  reference?: string;
};

type RecordForwardToFinanceCompanyDialogProps = {
  open: boolean;
  submitting: boolean;
  /** The total owed onward, already formatted in the deal's currency. */
  totalLabel: string;
  depositLabel: string;
  contributionLabel: string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: ForwardPaymentValues) => void | Promise<void>;
};

export function RecordForwardToFinanceCompanyDialog({
  open,
  submitting,
  totalLabel,
  depositLabel,
  contributionLabel,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<RecordForwardToFinanceCompanyDialogProps>) {
  const [method, setMethod] = useState<ForwardPaymentMethod | "">("");
  const [paidOn, setPaidOn] = useState(economicTodayDateInput());
  const [reference, setReference] = useState("");

  // Reset on the closed -> open transition only, so a live re-render of the deal
  // never wipes what the operator is typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setMethod("");
    setPaidOn(economicTodayDateInput());
    setReference("");
  }, [open]);

  const paidAt = paidOn === "" ? Number.NaN : economicDateInputToMs(paidOn);
  const ready = method !== "" && Number.isFinite(paidAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RecordForwardTitle")}</DialogTitle>
          <DialogDescription>{t("RecordForwardDesc")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/50 p-3" data-testid="forward-breakdown">
          <p className="text-xs text-muted-foreground">{t("RecordForwardAmount")}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            <bdi dir="ltr">{totalLabel}</bdi>
          </p>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm">
            <dt className="text-muted-foreground">{t("RecordForwardDeposit")}</dt>
            <dd className="tabular-nums">
              <bdi dir="ltr">{depositLabel}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("RecordForwardContribution")}</dt>
            <dd className="tabular-nums">
              <bdi dir="ltr">{contributionLabel}</bdi>
            </dd>
          </dl>
        </div>

        <form
          id="record-forward-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (method === "" || !Number.isFinite(paidAt)) return;
            const trimmed = reference.trim();
            void onConfirm({ method, paidAt, reference: trimmed === "" ? undefined : trimmed });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="record-forward-method">{t("DirectPaymentMethodLabel")}</Label>
            <select
              id="record-forward-method"
              className={selectClass}
              value={method}
              required
              disabled={submitting}
              onChange={(event) => setMethod(event.target.value as ForwardPaymentMethod | "")}
            >
              <option value="">{t("DirectPaymentMethodChoose")}</option>
              {METHODS.map((option) => (
                <option key={option} value={option}>
                  {t(`PaymentMethod_${option}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="record-forward-date">{t("CostPaidOnLabel")}</Label>
            <Input
              id="record-forward-date"
              type="date"
              required
              max={economicTodayDateInput()}
              value={paidOn}
              disabled={submitting}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-forward-reference">{t("ReceiptReferenceLabel")}</Label>
            <Input
              id="record-forward-reference"
              maxLength={MAX_REFERENCE_CHARS}
              value={reference}
              disabled={submitting}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="record-forward-form" disabled={submitting || !ready}>
            {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" aria-hidden />}
            {t("RecordForwardConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
