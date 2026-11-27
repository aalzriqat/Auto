"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { getCodedErrorMessage } from "@/lib/errors";
import { AccountingTableFrame } from "../AccountingTabShared";
import {
  Figure, ReclassFigureRows, reclassCodeMessage, useMinorFormatter, useReclassDate, type PendingReclass, type ReclassSchedule,
} from "./reclassShared";

const NOTICE_CLASS =
  "rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";

/**
 * SCRUM-961: the second person's decision on a pending request. Everything shown is the backend's: who asked and when,
 * the reason, each person's amount, and the figures the change would post. Approve sends the total and the true-up shown
 * here as the figures the approver accepted; the backend re-derives both and refuses (`PREPAID_RECLASS_FIGURES`) when
 * either changed, so nothing posts on figures nobody saw. When the backend cannot confirm the figures it says why and
 * approval is unavailable. The backend also refuses the requester, a beneficiary and a closed period; the screen only
 * reports those refusals in the user's language.
 */
export function PrepaidReclassReviewDialog({ orgId, schedule, pending, onClose }: Readonly<{
  orgId: Id<"organizations">;
  schedule: ReclassSchedule;
  pending: PendingReclass;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const format = useMinorFormatter(schedule.currency);
  const formatDate = useReclassDate();
  const approve = useMutation(api.openingPrepaidReclassification.approvePrepaidReclassification);
  const dismiss = useMutation(api.openingPrepaidReclassification.dismissPrepaidReclassification);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const figures = pending.figures?.ok === true ? pending.figures : null;
  const canApprove = !pending.requestedByMe && figures !== null;

  async function decide(kind: "approve" | "dismiss") {
    if (busy) return;
    if (kind === "approve" && (pending.requestedByMe || figures === null)) return;
    setBusy(true);
    setRefusal(null);
    try {
      if (kind === "approve" && figures !== null) {
        // Exactly the figures on screen: the total moved and the expense given back shown above.
        await approve({
          orgId, reclassificationId: pending.reclassificationId,
          expectedTotalMinor: pending.totalMinor, expectedTrueUpMinor: figures.trueUpMinor,
        });
        toast.success(t("PrepaidReclassApproved"));
      } else {
        await dismiss({ orgId, reclassificationId: pending.reclassificationId });
        toast.success(t("PrepaidReclassDismissed"));
      }
      onClose();
    } catch (error) {
      setRefusal(getCodedErrorMessage(error, t) ?? reclassCodeMessage(null, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("PrepaidReclassReviewTitle")}</DialogTitle>
          <DialogDescription><bdi>{schedule.title}</bdi></DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {pending.requestedByMe && <p className={NOTICE_CLASS}>{t("PrepaidReclassRequestedByYou")}</p>}

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
            <Figure label={t("PrepaidReclassRequestedBy")} value={pending.requestedBy?.name || t("PrepaidReclassUnknownMember")} />
            <Figure label={t("PrepaidReclassRequestedOn")} value={formatDate(pending.requestedAt)} />
          </dl>

          <div className="space-y-1">
            <p className="text-muted-foreground">{t("PrepaidReclassReason")}</p>
            <p className="whitespace-pre-wrap break-words text-foreground"><bdi>{pending.reason}</bdi></p>
          </div>

          <AccountingTableFrame>
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>{t("TeamMember")}</TableHead>
                  <TableHead className="text-end">{t("Amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pending.lines ?? []).map((line) => (
                  <TableRow key={String(line.userId)}>
                    <TableCell><bdi>{line.name || t("PrepaidReclassUnknownMember")}</bdi></TableCell>
                    <TableCell className="text-end tabular-nums"><bdi>{format(line.amountMinor)}</bdi></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AccountingTableFrame>

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
            <Figure label={t("PrepaidReclassTotal")} value={format(pending.totalMinor)} />
            {figures && <ReclassFigureRows figures={figures} format={format} />}
          </dl>
          {pending.figures?.ok === false && (
            <p className={NOTICE_CLASS}>{reclassCodeMessage(pending.figures.code, t)} {t("PrepaidReclassCannotApprove")}</p>
          )}

          <p className="text-xs text-muted-foreground">{t("PrepaidReclassNoCash")} {t("PrepaidReclassApproveNote")}</p>
          {refusal && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">{refusal}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("dismiss")}>
            {t("PrepaidReclassDismiss")}
          </Button>
          <Button type="button" className="gap-2" disabled={busy || !canApprove} onClick={() => void decide("approve")}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t("PrepaidReclassApprove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
