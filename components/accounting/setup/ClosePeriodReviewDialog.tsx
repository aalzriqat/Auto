"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { DialogFooterActions, errorMessage } from "../AccountingTabShared";
import type { PeriodSummary, Translate } from "./types";
import { periodLabel } from "./types";

type ClosePeriodReviewDialogProps = {
  orgId: Id<"organizations">;
  period: PeriodSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  t: Translate;
};

/**
 * The only path to accountingPeriods.close(). Previously the frontend called
 * close() directly with no checklist fetch/display — an accountant could
 * close a period without ever seeing a genuine inventory/payable/deposit/
 * commission discrepancy. This fetches the checklist, shows every blocker and
 * warning, and requires each warning individually acknowledged (the backend
 * re-validates the exact warning text server-side, so this dialog can't be
 * bypassed by calling close() with a stale or fabricated list).
 */
export function ClosePeriodReviewDialog({
  orgId,
  period,
  open,
  onOpenChange,
  onClosed,
  t,
}: Readonly<ClosePeriodReviewDialogProps>) {
  const checklist = useQuery(
    api.accountingPeriods.closeChecklist,
    open && period ? { orgId, periodId: period._id } : "skip"
  );
  const closePeriod = useMutation(api.accountingPeriods.close);

  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [overrideReason, setOverrideReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAcknowledged(new Set());
      setOverrideReason("");
    }
  }, [open, period?._id]);

  if (!period) return null;

  const warnings = checklist?.warnings ?? [];
  const blockers = checklist?.blockers ?? [];
  const allWarningsAcknowledged = warnings.every((w) => acknowledged.has(w));
  const canSubmit =
    checklist !== undefined &&
    allWarningsAcknowledged &&
    (checklist.canClose || overrideReason.trim().length > 0);

  async function handleConfirm() {
    if (!checklist) return;
    setSubmitting(true);
    try {
      await closePeriod({
        orgId,
        periodId: period!._id,
        acknowledgedWarnings: warnings,
        overrideReason: checklist.canClose ? undefined : overrideReason.trim(),
      });
      toast.success(t("AccountingPeriodClosed"));
      onOpenChange(false);
      onClosed();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("ClosePeriodReviewTitle").replace("{period}", periodLabel(period))}</DialogTitle>
          <DialogDescription>{t("ClosePeriodReviewDesc")}</DialogDescription>
        </DialogHeader>

        {checklist === undefined ? (
          <p className="text-sm text-slate-500 py-4">{t("Loading")}</p>
        ) : (
          <div className="space-y-4">
            {blockers.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  {t("ClosePeriodBlockersLabel")}
                </div>
                <ul className="space-y-1.5">
                  {blockers.map((blocker) => (
                    <li key={blocker} className="text-sm text-red-800 leading-snug">
                      {blocker}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t("ClosePeriodWarningsLabel")}
                </div>
                <ul className="space-y-2">
                  {warnings.map((warning) => (
                    <li key={warning} className="flex items-start gap-2">
                      <Checkbox
                        checked={acknowledged.has(warning)}
                        onCheckedChange={(checked) => {
                          setAcknowledged((prev) => {
                            const next = new Set(prev);
                            if (checked === true) next.add(warning);
                            else next.delete(warning);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <span className="text-sm text-amber-900 leading-snug">{warning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {blockers.length === 0 && warnings.length === 0 && (
              <p className="text-sm text-emerald-700">{t("ClosePeriodNoIssues")}</p>
            )}

            {!checklist.canClose && (
              <div className="space-y-1.5">
                <Label>{t("ClosePeriodOverrideReasonLabel")}</Label>
                <Textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder={t("ClosePeriodOverrideReasonPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">{t("ClosePeriodOverrideOwnerOnlyHint")}</p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel")}
            confirmLabel={t("ClosePeriod")}
            onCancel={() => onOpenChange(false)}
            onConfirm={handleConfirm}
            submitting={submitting}
            disabled={!canSubmit}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
