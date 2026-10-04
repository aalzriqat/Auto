"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { getLocalizedErrorMessage } from "@/lib/errors";

type CorrectionType =
  | "PRIOR_PERIOD_RESTATEMENT"
  | "SUPPLIER_INVOICE_ERROR"
  | "VENDOR_CREDIT"
  | "CASH_REFUND";

/**
 * SCRUM-650 — correct the purchase cost of a vehicle whose acquisition has
 * already posted. The server decides what is allowed (the context query returns
 * the permitted correction types); this dialog only presents that decision and
 * never offers a type the server would refuse. Nothing is queued: the
 * correction posts now or is refused with a reason.
 *
 * The mutation is state-guarded (a retry re-reads the corrected cost and is
 * refused as "no change"), so no command identity is needed here.
 */
export function CorrectAcquisitionCostDialog({
  vehicle,
  open,
  onOpenChange,
}: Readonly<{
  vehicle: Doc<"vehicles">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const tx = t as (key: any) => string;
  const correct = useMutation(api.vehicles.correctAcquisitionCost);
  const context = useQuery(
    api.vehicles.getAcquisitionCostCorrectionContext,
    open && activeOrgId ? { orgId: activeOrgId, vehicleId: vehicle._id } : "skip"
  );

  const [newCost, setNewCost] = useState("");
  const [type, setType] = useState<CorrectionType | undefined>(undefined);
  const [method, setMethod] = useState<PaymentMethod | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // A fresh open is a fresh intent: never carry a half-typed correction across vehicles.
  useEffect(() => {
    if (open) {
      setNewCost("");
      setType(undefined);
      setMethod(undefined);
      setReason("");
      setBusy(false);
    }
  }, [open, vehicle._id]);

  const allowedTypes = (context?.allowedTypes ?? []) as CorrectionType[];
  const currentCost = context?.currentCost ?? 0;
  const parsed = newCost.trim() === "" ? NaN : Number(newCost);
  const amountValid = Number.isFinite(parsed) && parsed >= 0;
  const unchanged = amountValid && parsed === currentCost;
  const needsMethod = type === "CASH_REFUND";
  const canSubmit =
    !busy &&
    context?.eligible === true &&
    amountValid &&
    !unchanged &&
    type !== undefined &&
    (!needsMethod || method !== undefined) &&
    reason.trim().length > 0;

  const submit = async () => {
    if (!activeOrgId || !canSubmit || type === undefined) return;
    setBusy(true);
    try {
      await correct({
        orgId: activeOrgId,
        vehicleId: vehicle._id,
        newCost: parsed,
        reason: reason.trim(),
        correctionType: type,
        ...(needsMethod ? { paymentMethod: method } : {}),
      });
      toast.success(tx("CostCorrectionDone"));
      onOpenChange(false);
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t as (key: string) => string));
      setBusy(false);
    }
  };

  const blocked = context && !context.eligible ? context.blockedReason : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tx("CostCorrectionAction")}</DialogTitle>
          <DialogDescription>{tx("CostCorrectionDescription")}</DialogDescription>
        </DialogHeader>

        {context === undefined ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <span className="sr-only">{tx("CostCorrectionLoading")}</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : blocked ? (
          <p role="alert" className="rounded-md border p-3 text-sm">
            {tx(`CostCorrectionBlocked${blocked}`)}
          </p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{tx("CostCorrectionCurrentCost")}</dt>
              <dd className="text-end font-medium tabular-nums">
                {currentCost.toLocaleString()} {context.currency}
              </dd>
              {context.originalPaymentMethod && (
                <>
                  <dt className="text-muted-foreground">{tx("CostCorrectionOriginalMethod")}</dt>
                  <dd className="text-end">{tx(`PaymentMethod_${context.originalPaymentMethod}`)}</dd>
                </>
              )}
            </dl>
            {context.payable && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {tx("CostCorrectionPayable")
                  .replace("{due}", context.payable.amountDue.toLocaleString())
                  .replace("{paid}", context.payable.amountPaid.toLocaleString())}
              </p>
            )}

            {allowedTypes.length === 0 ? (
              <p role="alert" className="text-sm">{tx("CostCorrectionNoTypes")}</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="cost-correction-new">{tx("CostCorrectionNewCost")}</Label>
                  <Input
                    id="cost-correction-new"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    dir="ltr"
                    className="text-start tabular-nums"
                    value={newCost}
                    onChange={(event) => setNewCost(event.target.value)}
                  />
                  {unchanged && (
                    <p className="text-xs text-destructive">{tx("CostCorrectionNoChangeLocal")}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>{tx("CostCorrectionTypeLabel")}</Label>
                  <Select value={type} onValueChange={(value) => setType(value as CorrectionType)}>
                    <SelectTrigger aria-label={tx("CostCorrectionTypeLabel")}>
                      <SelectValue placeholder={tx("CostCorrectionTypePlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {allowedTypes.map((allowed) => (
                        <SelectItem key={allowed} value={allowed}>
                          {tx(`CostCorrectionType${allowed}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {needsMethod && (
                  <div className="space-y-1.5">
                    <Label>{tx("CostCorrectionPaymentMethod")}</Label>
                    <PaymentMethodSelect
                      t={tx}
                      value={method}
                      onValueChange={setMethod}
                      ariaLabel={tx("CostCorrectionPaymentMethod")}
                      placeholder={tx("CostCorrectionPaymentMethodPlaceholder")}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="cost-correction-reason">{tx("CostCorrectionReason")}</Label>
                  <Textarea
                    id="cost-correction-reason"
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{tx("CostCorrectionReasonHint")}</p>
                </div>
              </>
            )}

            {(context.corrections?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">{tx("CostCorrectionHistory")}</p>
                <ul className="divide-y rounded-md border text-xs">
                  {(context.corrections ?? []).map((row) => (
                    <li
                      key={`${row.createdAt}-${row.newCost}`}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-2 py-1.5"
                    >
                      <span className="tabular-nums" dir="ltr">
                        {row.previousCost.toLocaleString()} → {row.newCost.toLocaleString()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.reason}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {format(new Date(row.createdAt), "yyyy-MM-dd")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {tx("Cancel")}
          </Button>
          {context?.eligible === true && allowedTypes.length > 0 && (
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? tx("CostCorrectionSubmitting") : tx("CostCorrectionSubmit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
