"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { usePrepaidReclassAccess } from "@/hooks/usePrepaidReclassAccess";
import { interpolate } from "@/lib/i18n/interpolate";
import { MoneySurfaceErrorBoundary } from "../MoneySurfaceErrorBoundary";
import { PrepaidReclassRequestDialog } from "./PrepaidReclassRequestDialog";
import { PrepaidReclassReviewDialog } from "./PrepaidReclassReviewDialog";
import { Figure, reclassCodeMessage, useMinorFormatter, useReclassDate, type ApprovedReclass, type ReclassSchedule } from "./reclassShared";

type OpeningScheduleRow = {
  _id: Id<"prepaidExpenseSchedules">;
  currency: string;
  monthsRemaining: number;
  sourceTitle?: string | null;
  expenseTitle?: string | null;
};

/**
 * The notes under an opening prepaid row's title in the prepaid tab: where it came from, that ordinary corrections do
 * not apply, and the SCRUM-961 reclassification state. A failed status read (for example before the backend is
 * deployed) degrades to one line instead of taking the tab down.
 */
export function OpeningPrepaidRowNotes({ schedule }: Readonly<{ schedule: OpeningScheduleRow }>) {
  const { t } = useLanguage();
  const view: ReclassSchedule = {
    _id: schedule._id, currency: schedule.currency, monthsRemaining: schedule.monthsRemaining,
    title: schedule.sourceTitle || schedule.expenseTitle || t("GeneralExpense"),
  };
  return (
    <>
      <span className="block text-xs text-muted-foreground">{t("OpeningPrepaidSource")}</span>
      <span className="block text-xs text-muted-foreground">{t("OpeningPrepaidCorrectionsUnavailable")}</span>
      <MoneySurfaceErrorBoundary key={schedule._id}
        fallback={<span className="block text-xs text-muted-foreground">{t("PrepaidReclassStatusUnavailable")}</span>}>
        <OpeningPrepaidReclassification schedule={view} />
      </MoneySurfaceErrorBoundary>
    </>
  );
}

/**
 * SCRUM-961: what this opening prepaid schedule offers for moving part of it into employee advances. The backend status
 * decides: eligible (the request action), pending (who must act and the review action), approved (the posted record) or
 * blocked (its reason, translated, and no action). Without finance and payroll management the status is not asked for:
 * the backend would only answer that the person lacks authority, and the request details are payroll-restricted.
 */
export function OpeningPrepaidReclassification({ schedule }: Readonly<{ schedule: ReclassSchedule }>) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const { canReclassify: allowed } = usePrepaidReclassAccess();
  const status = useQuery(
    api.openingPrepaidReclassification.prepaidReclassificationStatus,
    allowed && activeOrgId ? { orgId: activeOrgId, scheduleId: schedule._id } : "skip",
  );
  const format = useMinorFormatter(schedule.currency);
  const [open, setOpen] = useState(false);

  if (!allowed || !activeOrgId) return null;
  if (status === undefined) {
    return (
      <output className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t("PrepaidReclassStatusLoading")}
      </output>
    );
  }
  if (status.approved) return <ApprovedReclassSummary orgId={activeOrgId} schedule={schedule} approved={status.approved} />;
  if (status.pending) {
    const pending = status.pending;
    return (
      <div className="mt-1 space-y-1">
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {interpolate(t("PrepaidReclassPendingNotice"), { amount: format(pending.totalMinor) })}
        </p>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(true)}>
          {t("PrepaidReclassReview")}
        </Button>
        {open && <PrepaidReclassReviewDialog orgId={activeOrgId} schedule={schedule} pending={pending} onClose={() => setOpen(false)} />}
      </div>
    );
  }
  if (status.eligible) {
    return (
      <div className="mt-1">
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(true)}>
          {t("PrepaidReclassAction")}
        </Button>
        {open && <PrepaidReclassRequestDialog orgId={activeOrgId} schedule={schedule} onClose={() => setOpen(false)} />}
      </div>
    );
  }
  if (status.blockedReason) {
    return <span className="block text-xs text-muted-foreground">{reclassCodeMessage(status.blockedReason, t)}</span>;
  }
  return null;
}

/**
 * The posted change, all from the status: what moved, what expense was given back, who approved it and when, each
 * person's advance, and the journal entry. The journal number is shown as text the way the General Ledger shows it
 * (no screen deep-links to one entry); the advances link is offered only to people who can open the payroll page.
 */
function ApprovedReclassSummary({ orgId, schedule, approved }: Readonly<{
  orgId: Id<"organizations">;
  schedule: ReclassSchedule;
  approved: ApprovedReclass;
}>) {
  const { t } = useLanguage();
  const { canViewPayroll } = usePrepaidReclassAccess();
  const format = useMinorFormatter(schedule.currency);
  const formatDate = useReclassDate();

  return (
    <div className="mt-1 space-y-1 text-xs">
      <p className="text-foreground">{interpolate(t("PrepaidReclassApprovedSummary"), { amount: format(approved.totalMinor) })}</p>
      <p className="text-muted-foreground">{interpolate(t("PrepaidReclassApprovedTrueUp"), { amount: format(approved.trueUpMinor) })}</p>
      <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
        <Figure label={t("PrepaidReclassApprovedBy")} value={approved.approvedBy?.name || t("PrepaidReclassUnknownMember")} />
        <Figure label={t("PrepaidReclassApprovedOn")} value={formatDate(approved.approvedAt)} />
        {approved.journalNumber && (
          <Figure label={t("PrepaidReclassJournal")} value={<span dir="ltr" className="font-mono">{approved.journalNumber}</span>} />
        )}
        {(approved.lines ?? []).map((line) => (
          <Figure key={String(line.userId)} label={<bdi>{line.name || t("PrepaidReclassUnknownMember")}</bdi>} value={format(line.amountMinor)} />
        ))}
      </dl>
      {canViewPayroll && (
        <Link href={`/${orgId}/payroll`} className="text-primary underline-offset-4 hover:underline">{t("PrepaidReclassViewAdvances")}</Link>
      )}
    </div>
  );
}
