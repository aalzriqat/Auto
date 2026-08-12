"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Gauge, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { dateInputToUtcMs, todayDateInput } from "@/lib/dateInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Who valued the vehicle. A dealer's own estimate is not offered here. */
export type AppraisalProviderType = "FINANCE_COMPANY" | "INDEPENDENT";

/**
 * Records the appraisal the vehicle was valued at.
 *
 * It exists on this screen because the stage rail blocks on it: sending the
 * quotation moves the appraisal dimension to PENDING, so `APPRAISAL` becomes the
 * deal's live blocker immediately after step one — and until now nothing in the
 * product could clear it. A rail that says "waiting on the appraisal" beside a
 * workflow that carries on regardless is two authorities on one screen.
 *
 * `DEALER_ESTIMATE` is deliberately absent. The server refuses it as the basis
 * of an approved purchase amount — it is the dealership's own opinion, not the
 * finance company's — so offering it here would put a choice on the screen that
 * cannot do the job the screen is asking for.
 */
type RecordAppraisalDialogProps = {
  open: boolean;
  submitting: boolean;
  /** The server's refusal, rendered in the form — see the quotation dialog. */
  error: string | null;
  /** 10^scale for the deal's own pinned currency — never the org's. */
  factor: number;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    appraisalAmountMinor: number;
    providerType: AppraisalProviderType;
    providerName?: string;
    appraisedAt: number;
    notes?: string;
  }) => void;
};

export function RecordAppraisalDialog({
  open,
  submitting,
  error,
  factor,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordAppraisalDialogProps>) {
  const [amount, setAmount] = useState("");
  const [providerType, setProviderType] = useState<AppraisalProviderType>("FINANCE_COMPANY");
  const [providerName, setProviderName] = useState("");
  const [appraisedOn, setAppraisedOn] = useState(todayDateInput());

  // Reset on the closed -> open TRANSITION only, as in the sibling dialogs.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setAmount("");
    setProviderType("FINANCE_COMPANY");
    setProviderName("");
    setAppraisedOn(todayDateInput());
  }, [open]);

  const parsed = Number(amount);
  const entered = amount.trim() !== "";
  const amountInvalid = entered && !(parsed > 0);
  const enteredMinor = entered && parsed > 0 ? Math.round(parsed * factor) : null;
  const canSubmit = enteredMinor !== null && appraisedOn !== "" && !submitting;

  const providers: Array<{ value: AppraisalProviderType; label: string }> = [
    { value: "FINANCE_COMPANY", label: t("AppraisalByFinanceCompany") },
    { value: "INDEPENDENT", label: t("AppraisalByIndependent") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RecordAppraisalTitle")}</DialogTitle>
          <DialogDescription>{t("RecordAppraisalDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="appraisal-amount">{t("AppraisalAmountLabel")}</Label>
            <Input
              id="appraisal-amount"
              inputMode="decimal"
              value={amount}
              aria-invalid={amountInvalid}
              onChange={(event) => setAmount(event.target.value)}
              className="tabular-nums"
            />
            {amountInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("AppraisalAmountInvalid")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t("AppraisalProviderLabel")}</Label>
            {/* Same button-radio pattern as the approval dialog, for the same
                reason: this project carries no radix radio primitive. */}
            <div role="radiogroup" aria-label={t("AppraisalProviderLabel")} className="flex gap-2">
              {providers.map((provider) => {
                const selected = providerType === provider.value;
                return (
                  <button
                    key={provider.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setProviderType(provider.value)}
                    className={cn(
                      "flex flex-1 items-center gap-2 rounded-md border p-2.5 text-start text-sm transition-colors",
                      selected ? "border-primary bg-primary/[0.06]" : "hover:bg-muted/60"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-primary bg-primary text-primary-foreground" : ""
                      )}
                      aria-hidden
                    >
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    {provider.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="appraisal-provider-name">{t("AppraisalProviderNameLabel")}</Label>
              <Input
                id="appraisal-provider-name"
                value={providerName}
                onChange={(event) => setProviderName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appraisal-date">{t("AppraisalDateLabel")}</Label>
              <Input
                id="appraisal-date"
                type="date"
                value={appraisedOn}
                max={todayDateInput()}
                onChange={(event) => setAppraisedOn(event.target.value)}
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                appraisalAmountMinor: enteredMinor!,
                providerType,
                providerName: providerName.trim() || undefined,
                // TODAY as the current instant rather than UTC midnight: only
                // this side knows the operator's local day, and east of UTC a
                // midnight stamp is still in the future for the first hours of
                // the morning. A backdated day arrives exactly as entered.
                appraisedAt:
                  appraisedOn === todayDateInput() ? Date.now() : dateInputToUtcMs(appraisedOn),
              })
            }
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Gauge className="h-4 w-4 me-2" />
            )}
            {t("RecordAppraisalAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
