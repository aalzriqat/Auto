"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-1018 - asked before any first-payment form opens: where did the customer pay?
 *
 * The two answers are recorded by two different, existing commands. Money paid at
 * the showroom is a deposit receipt (it posts the cash); money paid to the finance
 * company is evidence only. Both count toward the first-payment proof, so recording
 * showroom cash as finance-company evidence would prove a payment the books never
 * received. Each answer is a button named by its place and described by what it
 * records; the showroom answer is withdrawn, with the reason, when the deposit
 * action is not offered to this caller on this deal.
 */
export function FirstPaymentWherePaidDialog({
  open,
  onOpenChange,
  onShowroom,
  onFinanceCompany,
  t,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `undefined` when "Record deposit" is not offered (or not enabled) on this deal. */
  onShowroom?: () => void;
  onFinanceCompany: () => void;
  t: (key: string) => string;
}>) {
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("FirstPaymentWherePaidTitle")}</DialogTitle>
          <DialogDescription>{t("FirstPaymentWherePaidDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <WherePaidChoice
            id={`${id}-showroom`}
            label={t("FirstPaymentPaidShowroom")}
            help={t(onShowroom ? "FirstPaymentPaidShowroomHelp" : "FirstPaymentPaidShowroomUnavailable")}
            onSelect={onShowroom}
          />
          <WherePaidChoice
            id={`${id}-finance-company`}
            label={t("FirstPaymentPaidFinanceCompany")}
            help={t("FirstPaymentPaidFinanceCompanyHelp")}
            onSelect={onFinanceCompany}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WherePaidChoice({ id, label, help, onSelect }: Readonly<{
  id: string;
  label: string;
  help: string;
  onSelect?: () => void;
}>) {
  // A withdrawn choice keeps its reason OUTSIDE the button, so the disabled
  // button's faded opacity never fades the sentence that explains it.
  const helpText = <span id={`${id}-help`} className="text-xs font-normal text-muted-foreground">{help}</span>;
  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant="outline"
        className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-4 py-3 text-start"
        disabled={!onSelect}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onClick={onSelect}
      >
        <span id={`${id}-label`} className="font-semibold">{label}</span>
        {onSelect && helpText}
      </Button>
      {!onSelect && <p className="px-1">{helpText}</p>}
    </div>
  );
}
