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
import type { PeriodFormState, Translate } from "./types";

type CreateAccountingPeriodDialogProps = {
  open: boolean;
  periodForm: PeriodFormState;
  submitting: boolean;
  disabled: boolean;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onFormChange: (state: PeriodFormState) => void;
  onSubmit: () => void;
};

type PeriodFieldProps = {
  label: string;
  type: "date" | "number";
  value: string;
  min?: number;
  max?: number;
  onChange: (value: string) => void;
};

function PeriodField({ label, type, value, min, max, onChange }: Readonly<PeriodFieldProps>) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function CreateAccountingPeriodDialog({
  open,
  periodForm,
  submitting,
  disabled,
  t,
  onOpenChange,
  onFormChange,
  onSubmit,
}: Readonly<CreateAccountingPeriodDialogProps>) {
  function updatePeriodForm(patch: Partial<PeriodFormState>) {
    onFormChange({ ...periodForm, ...patch });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Plus className="h-4 w-4" />
          {t("CreatePeriod")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("CreateAccountingPeriod")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <PeriodField
            label={t("FiscalYear")}
            type="number"
            value={periodForm.fiscalYear}
            onChange={(fiscalYear) => updatePeriodForm({ fiscalYear })}
          />
          <PeriodField
            label={t("PeriodNumber")}
            type="number"
            min={1}
            max={13}
            value={periodForm.periodNumber}
            onChange={(periodNumber) => updatePeriodForm({ periodNumber })}
          />
          <PeriodField
            label={t("StartDate")}
            type="date"
            value={periodForm.startDate}
            onChange={(startDate) => updatePeriodForm({ startDate })}
          />
          <PeriodField
            label={t("EndDate")}
            type="date"
            value={periodForm.endDate}
            onChange={(endDate) => updatePeriodForm({ endDate })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={periodForm.openImmediately}
            onCheckedChange={(checked) => updatePeriodForm({ openImmediately: checked === true })}
          />
          {t("OpenImmediately")}
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("CreatePeriod")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
