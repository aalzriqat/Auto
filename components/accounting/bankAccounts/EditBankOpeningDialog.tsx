"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dateInputToUtcMs, msToDateInput } from "@/lib/dateInput";
import { minorToAmountInput, parseSignedOpeningMoneyMinor } from "./editBankOpeningInput";
import type { BankAccountSummary, Translate } from "./types";

export type EditBankOpeningInput = {
  bankAccountId: BankAccountSummary["_id"];
  openingBalanceMinor: number;
  openingBalanceDate: number;
};

type EditBankOpeningDialogProps = {
  /** The bank being edited; null keeps the dialog closed. */
  account: BankAccountSummary | null;
  saving: boolean;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditBankOpeningInput) => void;
};

/** ECMAScript time value limit; the server refuses anything beyond it. */
const MAX_TIME_VALUE_MS = 8.64e15;

function EditForm({ account, saving, t, onOpenChange, onSave }: Readonly<EditBankOpeningDialogProps & { account: BankAccountSummary }>) {
  const [amount, setAmount] = useState(minorToAmountInput(account.openingBalanceMinor, account.currency) ?? "");
  const [date, setDate] = useState(
    Number.isFinite(account.openingBalanceDate) && Math.abs(account.openingBalanceDate) <= MAX_TIME_VALUE_MS
      ? msToDateInput(account.openingBalanceDate)
      : "",
  );

  const minor = parseSignedOpeningMoneyMinor(amount, account.currency);
  const dateMs = dateInputToUtcMs(date);
  const dateValid = Number.isSafeInteger(dateMs) && Math.abs(dateMs) <= MAX_TIME_VALUE_MS;
  const amountError = minor === null ? t("StatedOpeningInvalidAmount") : null;
  const dateError = dateValid ? null : t("StatedOpeningInvalidDate");
  const canSave = !saving && minor !== null && dateValid;

  function submit() {
    if (!canSave || minor === null) return;
    onSave({ bankAccountId: account._id, openingBalanceMinor: minor, openingBalanceDate: dateMs });
  }

  return (
    <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("EditBankOpening")}</DialogTitle>
        <DialogDescription>{t("StatedOpeningHelp")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <p className="text-muted-foreground">{t("BankAccountName")}</p>
            <p className="font-medium text-foreground">{account.name}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">{t("Currency")}</p>
            <p className="font-medium text-foreground"><bdi dir="ltr">{account.currency}</bdi></p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stated-opening-amount">{t("StatedOpeningBalance")}</Label>
          <Input
            id="stated-opening-amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={amountError !== null}
            onChange={(e) => setAmount(e.target.value)}
          />
          {amountError && <p role="alert" className="text-sm text-destructive">{amountError}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stated-opening-date">{t("OpeningBalanceDate")}</Label>
          <Input
            id="stated-opening-date"
            type="date"
            value={date}
            aria-invalid={dateError !== null}
            onChange={(e) => setDate(e.target.value)}
          />
          {dateError && <p role="alert" className="text-sm text-destructive">{dateError}</p>}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("Cancel")}
        </Button>
        <Button onClick={submit} disabled={!canSave}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("Save")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function EditBankOpeningDialog(props: Readonly<EditBankOpeningDialogProps>) {
  const { account, onOpenChange } = props;
  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      {/* Keyed by bank so the form re-seeds from the current stored values each time it opens. */}
      {account && <EditForm key={account._id} {...props} account={account} />}
    </Dialog>
  );
}
