"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatExactMinorAmount, moneyDisplayLabel, moneyDisplayScale, parseTypedAmount } from "@/lib/moneyDisplay";
import { useAccountingSubmit } from "./AccountingTabShared";

type Scope = { orgId: Id<"organizations">; scheduleId: Id<"prepaidExpenseSchedules"> };

export function OpeningPrepaidBasisDialog({ orgId, scheduleId, onClose }: Scope & { onClose: () => void }) {
  const { t, locale } = useLanguage();
  const review = useQuery(api.openingPrepaidReview.basisReview, { orgId, scheduleId });
  const request = useMutation(api.openingPrepaidCorrections.requestBasisChange);
  const approve = useMutation(api.openingPrepaidCorrections.approveBasisChange);
  const requestReversal = useMutation(api.openingPrepaidCorrections.requestBasisReversal);
  const approveReversal = useMutation(api.openingPrepaidCorrections.approveBasisReversal);
  const { submitting, submitWithFeedback } = useAccountingSubmit();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [chosenOffset, setChosenOffset] = useState("");
  const id = useId();
  const scale = review ? moneyDisplayScale(review.currency) : null;
  const amountMinor = scale === null ? null : parseTypedAmount(amount, scale).minor;
  const offset = review?.offsets.find(account => account.id === chosenOffset) ?? review?.offsets[0];
  const inRequest = review?.action === "REQUEST" || review?.action === "REQUEST_REVERSAL";
  const actionLabel = review?.action === "REQUEST" ? t("OpeningPrepaidBasisAsk")
    : review?.action === "APPROVE" ? t("OpeningPrepaidBasisApprove")
    : review?.action === "REQUEST_REVERSAL" ? t("OpeningPrepaidBasisUndo")
    : review?.action === "APPROVE_REVERSAL" ? t("OpeningPrepaidBasisUndoApprove") : null;
  const renderAmount = (minor: number) => review ? (
    <bdi>{formatExactMinorAmount(minor, review.currency)} {moneyDisplayLabel(review.currency, locale === "ar" ? "ar" : "en")}</bdi>
  ) : null;

  async function submit() {
    if (!review || submitting) return;
    await submitWithFeedback(async () => {
      const scope = { orgId, scheduleId };
      const version = review.change?.version;
      const explanation = reason.trim();
      if (review.action === "REQUEST" && offset && amountMinor && explanation) {
        await request({ ...scope, offsetAccountId: offset.id, correctedTotalMinor: amountMinor, reason: explanation });
      } else if (version !== undefined && review.action === "APPROVE") {
        await approve({ ...scope, version });
      } else if (version !== undefined && review.action === "REQUEST_REVERSAL" && explanation) {
        await requestReversal({ ...scope, version, reason: explanation });
      } else if (version !== undefined && review.action === "APPROVE_REVERSAL") {
        await approveReversal({ ...scope, version });
      } else return;
      toast.success(t("OpeningPrepaidBasisSaved"));
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("OpeningPrepaidBasisReview")}</DialogTitle>
          <DialogDescription>{t("OpeningPrepaidBasisInstructions")}</DialogDescription>
        </DialogHeader>
        {!review ? <p role="status">{review === undefined ? t("LoadingPrepaidSchedules") : t("FigureUnavailable")}</p> : (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>{t("OpeningPrepaidBasisOriginal")}</dt><dd>{renderAmount(review.originalTotalMinor)}</dd>
              <dt>{t("OpeningPrepaidBasisCurrent")}</dt><dd>{renderAmount(review.currentTotalMinor)}</dd>
              {review.change && <>
                <dt>{t("OpeningPrepaidBasisProposed")}</dt><dd>{renderAmount(review.change.correctedTotalMinor)}</dd>
                <dt>{t("OpeningPrepaidBasisOffset")}</dt><dd>{review.change.offsetLabel}</dd>
                <dt>{t("OpeningPrepaidBasisReason")}</dt><dd className="break-words">{review.change.reason}</dd>
                {review.change.reversalReason && <>
                  <dt>{t("OpeningPrepaidBasisUndoReason")}</dt><dd className="break-words">{review.change.reversalReason}</dd>
                </>}
              </>}
            </dl>
            {review.action === "REQUEST" && <>
              <div className="space-y-1">
                <Label htmlFor={`${id}-offset`}>{t("OpeningPrepaidBasisOffset")}</Label>
                <select id={`${id}-offset`} className="w-full rounded-md border bg-background p-2" value={offset?.id ?? ""}
                  onChange={event => setChosenOffset(event.currentTarget.value)}>
                  {review.offsets.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-amount`}>{t("OpeningPrepaidBasisProposed")}</Label>
                <Input id={`${id}-amount`} inputMode="decimal" dir="ltr" value={amount} onChange={event => setAmount(event.currentTarget.value)} />
              </div>
            </>}
            {inRequest && <div className="space-y-1">
              <Label htmlFor={`${id}-reason`}>{t(review.action === "REQUEST_REVERSAL" ? "OpeningPrepaidBasisUndoReason" : "OpeningPrepaidBasisReason")}</Label>
              <Textarea id={`${id}-reason`} maxLength={500} value={reason} onChange={event => setReason(event.currentTarget.value)} />
            </div>}
            {actionLabel ? <DialogFooter>
              <Button type="submit" disabled={submitting || (inRequest && !reason.trim()) ||
                (review.action === "REQUEST" && (!offset || !amountMinor || amountMinor < 0 || amountMinor === review.currentTotalMinor))}>
                {actionLabel}
              </Button>
            </DialogFooter> : <p role="status" className="text-sm text-muted-foreground">{t("OpeningPrepaidBasisWaiting")}</p>}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
