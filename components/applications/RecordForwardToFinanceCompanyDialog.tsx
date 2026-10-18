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
import type { Id } from "@/convex/_generated/dataModel";
import { BANK_PAYMENT_METHODS, type DirectPaymentBankOptions } from "./cockpit/HandoverCostsPanel";

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
  /** SCRUM-54: the physical bank, for a bank-account method only. */
  bankAccountId?: Id<"bankAccounts">;
  /** UTC midnight of the calendar day the operator picked. */
  paidAt: number;
  reference?: string;
  /** The amount due when this attempt was first submitted; a same-command retry re-sends it, never the live figure. */
  expectedAmountMinor: number;
};

type PinnedFigures = { totalLabel: string; depositLabel: string; contributionLabel: string };

/** "UNKNOWN": the response was lost, so the payment may be recorded - the form freezes for a same-command retry. */
export type ForwardConfirmOutcome = "UNKNOWN" | void;

type RecordForwardToFinanceCompanyDialogProps = {
  open: boolean;
  submitting: boolean;
  /** The live amount owed onward, in minor units; pinned into the attempt at first submit. */
  dueMinor: number;
  /** The total owed onward, already formatted in the deal's currency. */
  totalLabel: string;
  depositLabel: string;
  contributionLabel: string;
  /** Banks a bank-account method may name, in the deal's currency; `undefined` while loading. */
  bankOptions: DirectPaymentBankOptions;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: ForwardPaymentValues) => ForwardConfirmOutcome | Promise<ForwardConfirmOutcome>;
};

export function RecordForwardToFinanceCompanyDialog({
  open,
  submitting,
  dueMinor,
  totalLabel,
  depositLabel,
  contributionLabel,
  bankOptions,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<RecordForwardToFinanceCompanyDialogProps>) {
  const [method, setMethod] = useState<ForwardPaymentMethod | "">("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paidOn, setPaidOn] = useState(economicTodayDateInput());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The attempt whose outcome is unknown: every field is frozen and a retry re-sends exactly this.
  const [unknownSent, setUnknownSent] = useState<{ values: ForwardPaymentValues; figures: PinnedFigures } | null>(null);

  // Reset on the closed -> open transition only, so a live re-render of the deal
  // never wipes what the operator is typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setMethod("");
    setBankAccountId("");
    setPaidOn(economicTodayDateInput());
    setReference("");
    setError(null);
    setUnknownSent(null);
  }, [open]);

  const paidAt = paidOn === "" ? Number.NaN : economicDateInputToMs(paidOn);
  const frozen = unknownSent !== null;
  const needsBank = method !== "" && BANK_PAYMENT_METHODS.includes(method);
  // A choice the server no longer offers (the list moved while the form was open) cannot be sent.
  const chosenBank = bankOptions?.banks.find((bank) => bank._id === bankAccountId);
  const bankListTruncated = needsBank && bankOptions?.truncated === true;
  const noEligibleBank = needsBank && bankOptions !== undefined && !bankListTruncated && bankOptions.banks.length === 0;
  const ready = frozen || (method !== "" && Number.isFinite(paidAt));

  // While an attempt is unknown the breakdown shows what that attempt was sent with, not the live deal.
  const shown = unknownSent?.figures ?? { totalLabel, depositLabel, contributionLabel };

  const submit = async () => {
    let attempt = unknownSent;
    if (attempt === null) {
      if (method === "" || !Number.isFinite(paidAt)) return;
      if (needsBank && chosenBank === undefined) {
        setError(t("DirectPaymentBankRequired"));
        return;
      }
      const trimmed = reference.trim();
      attempt = {
        values: {
          method,
          ...(needsBank && chosenBank ? { bankAccountId: chosenBank._id } : {}),
          paidAt,
          reference: trimmed === "" ? undefined : trimmed,
          expectedAmountMinor: dueMinor,
        },
        figures: { totalLabel, depositLabel, contributionLabel },
      };
    }
    setError(null);
    setUnknownSent((await onConfirm(attempt.values)) === "UNKNOWN" ? attempt : null);
  };

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
            <bdi dir="ltr">{shown.totalLabel}</bdi>
          </p>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-sm">
            <dt className="text-muted-foreground">{t("RecordForwardDeposit")}</dt>
            <dd className="tabular-nums">
              <bdi dir="ltr">{shown.depositLabel}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("RecordForwardContribution")}</dt>
            <dd className="tabular-nums">
              <bdi dir="ltr">{shown.contributionLabel}</bdi>
            </dd>
          </dl>
        </div>

        <form
          id="record-forward-form"
          className="grid gap-3 sm:grid-cols-2"
          // `required` stays for assistive tech; submit() owns validation so the
          // refusal is the translated in-form alert, not a browser tooltip.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="record-forward-method">{t("DirectPaymentMethodLabel")}</Label>
            <select
              id="record-forward-method"
              className={selectClass}
              value={method}
              required
              disabled={submitting || frozen}
              onChange={(event) => {
                setMethod(event.target.value as ForwardPaymentMethod | "");
                setBankAccountId("");
                setError(null);
              }}
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
              disabled={submitting || frozen}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </div>
          {needsBank && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="record-forward-bank">{t("DirectPaymentBankLabel")}</Label>
              <select
                id="record-forward-bank"
                className={selectClass}
                value={chosenBank?._id ?? ""}
                disabled={submitting || frozen || bankOptions === undefined || noEligibleBank || bankListTruncated}
                required
                aria-invalid={error === t("DirectPaymentBankRequired")}
                onChange={(event) => {
                  setBankAccountId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">{t(bankOptions === undefined ? "CashDrawerLoadingBanks" : "DirectPaymentBankChoose")}</option>
                {(bankOptions?.banks ?? []).map((bank) => (
                  <option key={bank._id} value={bank._id}>
                    {bank.name} · {bank.currency}
                  </option>
                ))}
              </select>
              {noEligibleBank && (
                <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("DirectPaymentNoBank")}</p>
              )}
              {bankListTruncated && (
                <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("DirectPaymentTooManyBanks")}</p>
              )}
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-forward-reference">{t("ReceiptReferenceLabel")}</Label>
            <Input
              id="record-forward-reference"
              maxLength={MAX_REFERENCE_CHARS}
              value={reference}
              disabled={submitting || frozen}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs font-medium text-destructive sm:col-span-2">
              {error}
            </p>
          )}
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
