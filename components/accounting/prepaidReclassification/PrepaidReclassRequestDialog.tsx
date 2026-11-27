"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { getCodedErrorMessage } from "@/lib/errors";
import { interpolate } from "@/lib/i18n/interpolate";
import { DialogFooterActions } from "../AccountingTabShared";
import { parseKnownCurrencyMinor } from "../setup/openingMoneyInput";
import { Figure, ReclassFigureRows, reclassCodeMessage, useMinorFormatter, useReclassMembers, type ReclassSchedule } from "./reclassShared";

type DraftLine = { key: number; userId: string; amount: string };

/** Matches the backend limits; the backend still decides (it refuses more lines or a longer reason). */
const MAX_LINES = 50;
const REASON_MAX = 500;
const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive";

/**
 * SCRUM-961: ask for part of an opening prepaid schedule to be moved into employee advances, one line per person. The
 * person types who and how much plus a reason. The dialog adds up those lines only to ask the backend for its preview;
 * the true-up, the new totals, the months left and the monthly amounts are the backend's. Nothing is posted here: a second
 * authorised person approves the stored request.
 */
export function PrepaidReclassRequestDialog({ orgId, schedule, onClose }: Readonly<{
  orgId: Id<"organizations">;
  schedule: ReclassSchedule;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const format = useMinorFormatter(schedule.currency);
  const { members, loading, allowed, myUserId } = useReclassMembers(orgId);
  const request = useMutation(api.openingPrepaidReclassification.requestPrepaidReclassification);
  const nextKey = useRef(2);
  const [lines, setLines] = useState<DraftLine[]>([{ key: 1, userId: "", amount: "" }]);
  const [reason, setReason] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  const parsed = lines.map((line) => ({ userId: line.userId, amountMinor: parseKnownCurrencyMinor(line.amount, schedule.currency) }));
  const lineValid = (line: (typeof parsed)[number]) => line.userId !== "" && line.amountMinor !== null && line.amountMinor > 0;
  const distinct = new Set(parsed.map((line) => line.userId)).size === parsed.length;
  const sum = parsed.reduce((total, line) => total + (line.amountMinor ?? 0), 0);
  // The person's own lines summed only to ask for the preview; the backend recomputes and validates the total.
  const totalMinor = parsed.length > 0 && distinct && parsed.every(lineValid) && Number.isSafeInteger(sum) ? sum : null;
  const reasonValid = reason.trim().length > 0;
  const preview = useQuery(
    api.openingPrepaidReclassification.previewPrepaidReclassification,
    totalMinor !== null ? { orgId, scheduleId: schedule._id, totalMinor } : "skip",
  );
  const blockedByPreview = totalMinor !== null && preview?.ok !== true;

  const updateLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const addLine = () => {
    setLines((current) => [...current, { key: nextKey.current, userId: "", amount: "" }]);
    nextKey.current += 1;
  };
  const removeLine = (key: number) => setLines((current) => current.filter((line) => line.key !== key));

  async function submit() {
    if (busy) return;
    setShowErrors(true);
    if (totalMinor === null || !reasonValid || preview?.ok !== true) return;
    setBusy(true);
    setRefusal(null);
    try {
      await request({
        orgId, scheduleId: schedule._id, reason: reason.trim(),
        lines: parsed.map((line) => ({ userId: line.userId as Id<"users">, amountMinor: line.amountMinor ?? 0 })),
      });
      toast.success(t("PrepaidReclassRequested"));
      onClose();
    } catch (error) {
      // A coded refusal in the user's language; anything else is the generic refusal, never the raw error.
      setRefusal(getCodedErrorMessage(error, t) ?? reclassCodeMessage(null, t));
    } finally {
      setBusy(false);
    }
  }

  const linesErrorId = `${ids}-lines-error`;
  const reasonErrorId = `${ids}-reason-error`;
  const reasonHintId = `${ids}-reason-hint`;
  const previewTitleId = `${ids}-preview-title`;
  const showLinesError = showErrors && totalMinor === null;
  const showReasonError = showErrors && !reasonValid;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("PrepaidReclassAction")}</DialogTitle>
          <DialogDescription>
            <bdi>{schedule.title}</bdi> — {t("PrepaidReclassHelp")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {!allowed && <p className="text-muted-foreground">{t("PrepaidReclassNoMemberAccess")}</p>}
          {loading && <p className="text-muted-foreground">{t("PrepaidReclassMembersLoading")}</p>}
          <ol className="space-y-3">
            {lines.map((line, index) => {
              const n = index + 1;
              const invalid = showLinesError && !lineValid(parsed[index]);
              const takenElsewhere = new Set(lines.filter((other) => other.key !== line.key).map((other) => other.userId));
              const options = members.filter((member) => member.userId !== myUserId && !takenElsewhere.has(member.userId));
              return (
                <li key={line.key} className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_auto]">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${ids}-employee-${line.key}`}>{interpolate(t("PrepaidReclassEmployeeN"), { n })}</Label>
                    <select id={`${ids}-employee-${line.key}`} className={SELECT_CLASS} value={line.userId} disabled={busy}
                      aria-invalid={invalid} aria-describedby={invalid ? linesErrorId : undefined}
                      onChange={(event) => updateLine(line.key, { userId: event.target.value })}>
                      <option value="">{t("PrepaidReclassSelectEmployee")}</option>
                      {options.map((member) => <option key={member.userId} value={member.userId}>{member.userName || t("PrepaidReclassUnknownMember")}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${ids}-amount-${line.key}`}>{interpolate(t("PrepaidReclassAmountN"), { n })}</Label>
                    <Input id={`${ids}-amount-${line.key}`} inputMode="decimal" autoComplete="off" dir="ltr" className="text-end tabular-nums"
                      value={line.amount} disabled={busy} aria-invalid={invalid} aria-describedby={invalid ? linesErrorId : undefined}
                      onChange={(event) => updateLine(line.key, { amount: event.target.value })} />
                  </div>
                  {lines.length > 1 ? (
                    <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={interpolate(t("PrepaidReclassRemoveLineN"), { n })}
                      onClick={() => removeLine(line.key)}>
                      <X className="h-4 w-4" />
                    </Button>
                  ) : <span aria-hidden className="hidden sm:block sm:w-10" />}
                </li>
              );
            })}
          </ol>
          {showLinesError && <p id={linesErrorId} role="alert" className="text-xs text-destructive">{t("PrepaidReclassLinesRequired")}</p>}
          <Button type="button" variant="outline" size="sm" disabled={busy || lines.length >= MAX_LINES} onClick={addLine}>
            {t("PrepaidReclassAddLine")}
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-reason`}>{t("PrepaidReclassReason")}</Label>
            <Textarea id={`${ids}-reason`} value={reason} maxLength={REASON_MAX} disabled={busy} aria-invalid={showReasonError}
              aria-describedby={showReasonError ? `${reasonHintId} ${reasonErrorId}` : reasonHintId}
              onChange={(event) => setReason(event.target.value)} />
            <p id={reasonHintId} className="text-xs text-muted-foreground">{t("PrepaidReclassReasonHint")}</p>
            {showReasonError && <p id={reasonErrorId} role="alert" className="text-xs text-destructive">{t("PrepaidReclassReasonRequired")}</p>}
          </div>

          <section aria-labelledby={previewTitleId} className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <h3 id={previewTitleId} className="font-medium text-foreground">{t("PrepaidReclassPreviewTitle")}</h3>
            {totalMinor === null ? (
              <p className="text-muted-foreground">{t("PrepaidReclassPreviewEmpty")}</p>
            ) : preview === undefined ? (
              <p role="status" className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("PrepaidReclassPreviewLoading")}
              </p>
            ) : !preview.ok ? (
              <p role="alert" className="text-destructive">{reclassCodeMessage(preview.code, t)}</p>
            ) : (
              <>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
                  <Figure label={t("PrepaidReclassMoved")} value={format(totalMinor)} />
                  <ReclassFigureRows figures={preview} format={format} />
                </dl>
                <p className="text-xs text-muted-foreground">{t("PrepaidReclassNoCash")}</p>
              </>
            )}
          </section>

          {refusal && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">{refusal}</p>}
        </div>

        <DialogFooter className="gap-2">
          <DialogFooterActions
            cancelLabel={t("Cancel")}
            confirmLabel={t("PrepaidReclassSubmit")}
            onCancel={onClose}
            onConfirm={() => void submit()}
            submitting={busy}
            disabled={blockedByPreview}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
