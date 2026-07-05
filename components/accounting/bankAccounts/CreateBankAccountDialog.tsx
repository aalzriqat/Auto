"use client";

import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateBankAccountFormState, Translate } from "./types";

type CreateBankAccountDialogProps = {
  open: boolean;
  form: CreateBankAccountFormState;
  submitting: boolean;
  disabled: boolean;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onFormChange: (state: CreateBankAccountFormState) => void;
  onSubmit: () => void;
};

export function CreateBankAccountDialog({
  open,
  form,
  submitting,
  disabled,
  t,
  onOpenChange,
  onFormChange,
  onSubmit,
}: Readonly<CreateBankAccountDialogProps>) {
  function update(patch: Partial<CreateBankAccountFormState>) {
    onFormChange({ ...form, ...patch });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Plus className="h-4 w-4" />
          {t("CreateBankAccount" as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("CreateBankAccount" as any)}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("BankAccountName" as any)}</Label>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Main Operating Account" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("BankName" as any)} ({t("Optional" as any)})</Label>
            <Input value={form.bankName} onChange={(e) => update({ bankName: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("Currency" as any)}</Label>
            <Input value={form.currency} onChange={(e) => update({ currency: e.target.value.toUpperCase() })} maxLength={3} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("Iban" as any)} ({t("Optional" as any)})</Label>
            <Input value={form.iban} onChange={(e) => update({ iban: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("AccountNumber" as any)} ({t("Optional" as any)})</Label>
            <Input value={form.accountNumber} onChange={(e) => update({ accountNumber: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("OpeningBalance" as any)}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.openingBalance}
              onChange={(e) => update({ openingBalance: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("OpeningBalanceDate" as any)}</Label>
            <Input
              type="date"
              value={form.openingBalanceDate}
              onChange={(e) => update({ openingBalanceDate: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("Notes" as any)} ({t("Optional" as any)})</Label>
            <Input value={form.notes} onChange={(e) => update({ notes: e.target.value })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.isReconciliationTarget}
            onCheckedChange={(checked) => update({ isReconciliationTarget: checked === true })}
          />
          {t("SetAsReconciliationTarget" as any)}
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel" as any)}
          </Button>
          <Button onClick={onSubmit} disabled={submitting || !form.name.trim()}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("CreateBankAccount" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
