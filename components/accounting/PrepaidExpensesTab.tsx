"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";
import { RotateCcw, History, Wrench, PlayCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AccountingEmptyRow,
  AccountingTableFrame,
  AmountSummary,
  DialogFooterActions,
  LoadingAccountingState,
  PaymentMethodSelect,
  errorMessage,
  scaleForCurrency,
  useAccountingSubmit,
} from "./AccountingTabShared";
import { prepaidCorrectionSchema, type PrepaidCorrectionFormValues } from "./prepaidCorrection.schema";

/**
 * "YYYY-MM-DD" -> UTC midnight.
 *
 * Deliberately NOT AccountingTabShared's dateInputToMs, which parses at LOCAL
 * midnight. Every date in the ledger is bucketed by its UTC month
 * (expenseAmortization.ts) and accounting periods are bounded with Date.UTC, so
 * for a user east of UTC a local-midnight parse of the 1st resolves into the
 * previous month — and, with annual periods, the previous period. A date the
 * accountant picked to control which month a correction lands in is the last
 * place that can be off by one. (The shared helper has the same latent issue for
 * claims and bank accounts; left alone here rather than changed underneath two
 * other features from this PR.)
 */
function dateInputToUtcMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * The accountant's LOCAL calendar today as "YYYY-MM-DD" — deliberately not
 * AccountingTabShared's `todayInput`, which is the UTC date. A user ahead of UTC
 * in the first hours of their day has a local date that is already "tomorrow" in
 * UTC; keying the picker's default and max off the UTC date would stop them
 * selecting their own today. The server allows a day of grace to match.
 */
function localTodayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Each prepaid schedule carries its own currency (set at creation, independent
// of the org's CURRENT currency — see hooks/useCurrencyFormatter.ts), so every
// formatter in this file takes the amount's currency explicitly rather than
// defaulting to the org's, and factor/scale are always derived from the
// SCHEDULE's own currency, never a single tab-wide one.
type CurrencyFormatterInCurrency = (amount: number, currency: string, fractionDigits?: number) => string;

type ScheduleRow = {
  _id: Id<"prepaidExpenseSchedules">;
  expenseId: Id<"expenses">;
  expenseTitle?: string;
  expenseVendor?: string;
  currency: string;
  totalMinor: number;
  recognizedMinor: number;
  remainingMinor: number;
  dueMinor: number;
  postedMinor: number;
  pendingMinor: number;
  failedMinor: number;
  pendingCorrectionMinor: number;
  failedCorrectionMinor: number;
  openFailureCount: number;
  termMonths: number;
  monthsRecognized: number;
  monthsRemaining: number;
  startYearMonth: string;
  lastRecognizedYearMonth?: string;
  status: "ACTIVE" | "FULLY_AMORTIZED" | "CANCELLED";
  createdAt: number;
};

type RunAmortizationNowResult = {
  posted: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; monthsPosted: number }>;
  blocked: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; reason: string }>;
  failed: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; error: string }>;
  upToDateCount: number;
  scheduleCount: number;
};

/** FAILED > PENDING > DUE > CANCELLED/COMPLETE > UP TO DATE — a correction's queued or dead-lettered posting is exactly as urgent as amortization's own, so it carries the same weight in this precedence. */
function ScheduleStatusBadge({ t, schedule }: Readonly<{ t: (key: any) => string; schedule: ScheduleRow }>) {
  if (schedule.openFailureCount > 0 || schedule.failedMinor > 0 || schedule.failedCorrectionMinor > 0) {
    return <Badge variant="outline" className="bg-rose-500/10 text-rose-600 border-rose-500/20">{t("PrepaidGlStatus_FAILED")}</Badge>;
  }
  if (schedule.pendingMinor > 0 || schedule.pendingCorrectionMinor > 0) {
    return <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">{t("PrepaidGlStatus_PENDING")}</Badge>;
  }
  if (schedule.status === "ACTIVE" && schedule.dueMinor > schedule.recognizedMinor) {
    return <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20">{t("PrepaidGlStatus_DUE")}</Badge>;
  }
  if (schedule.status === "CANCELLED") {
    return <Badge variant="outline" className="bg-slate-500/10 text-slate-500 border-slate-500/20">{t("PrepaidGlStatus_CANCELLED")}</Badge>;
  }
  if (schedule.status === "FULLY_AMORTIZED") {
    return <Badge variant="outline" className="bg-slate-500/10 text-slate-500 border-slate-500/20">{t("PrepaidGlStatus_COMPLETE")}</Badge>;
  }
  return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">{t("PrepaidGlStatus_UPTODATE")}</Badge>;
}

/** Click-to-open detail behind the badge: posted/pending/failed amortization, pending/failed corrections, and any unresolved failure messages — plus a redrive action when something's queued or dead-lettered. */
function ScheduleStatusPopover({
  schedule,
  orgId,
  canManage,
  formatCurrency,
}: Readonly<{
  schedule: ScheduleRow;
  orgId: Id<"organizations">;
  canManage: boolean;
  formatCurrency: CurrencyFormatterInCurrency;
}>) {
  const { t } = useLanguage();
  const scale = scaleForCurrency(schedule.currency);
  const factor = Math.pow(10, scale);
  const [open, setOpen] = useState(false);
  const failures = useQuery(
    api.prepaidExpenses.listOpenFailures,
    open ? { orgId, scheduleId: schedule._id } : "skip"
  ) as Doc<"prepaidAmortizationFailures">[] | undefined;
  const redrive = useMutation(api.prepaidExpenses.redriveScheduleEvents);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const hasQueuedWork =
    schedule.pendingMinor > 0 || schedule.failedMinor > 0 || schedule.pendingCorrectionMinor > 0 || schedule.failedCorrectionMinor > 0;

  async function handleRedrive() {
    await submitWithFeedback(async () => {
      const result = await redrive({ orgId, scheduleId: schedule._id });
      if (result.posted === 0 && result.failed === 0) {
        toast.success(t("PrepaidRedriveNothingToDo" as any));
      } else {
        toast.success(
          t("PrepaidRedriveSuccess" as any)
            .replace("{posted}", String(result.posted))
            .replace("{failed}", String(result.failed))
        );
      }
    });
  }

  const fmt = (minor: number) => formatCurrency(minor / factor, schedule.currency, scale);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="cursor-pointer">
          <ScheduleStatusBadge t={t as any} schedule={schedule} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-sm" align="start">
        <p className="font-medium text-slate-900">{t("GlStatusDetails" as any)}</p>
        <div className="space-y-1 text-slate-600">
          <div className="flex justify-between"><span>{t("PostedAmortizationLabel" as any)}</span><span>{fmt(schedule.postedMinor)}</span></div>
          <div className="flex justify-between"><span>{t("PendingAmortizationLabel" as any)}</span><span>{fmt(schedule.pendingMinor)}</span></div>
          <div className="flex justify-between"><span>{t("FailedAmortizationLabel" as any)}</span><span>{fmt(schedule.failedMinor)}</span></div>
          <div className="flex justify-between"><span>{t("PendingCorrectionLabel" as any)}</span><span>{fmt(schedule.pendingCorrectionMinor)}</span></div>
          <div className="flex justify-between"><span>{t("FailedCorrectionLabel" as any)}</span><span>{fmt(schedule.failedCorrectionMinor)}</span></div>
        </div>

        {schedule.openFailureCount > 0 && (
          <div className="border-t pt-2 space-y-1">
            <p className="font-medium text-rose-600">{t("UnresolvedFailuresLabel" as any)}</p>
            {failures === undefined ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              failures.map((f) => (
                <p key={f._id} className="text-xs text-slate-500">
                  {f.yearMonth}: {f.errorMessage}
                </p>
              ))
            )}
          </div>
        )}

        {canManage && hasQueuedWork && (
          <Button size="sm" variant="outline" className="gap-2 w-full" disabled={submitting} onClick={handleRedrive}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {t("RedriveSchedule" as any)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RunNowResultsDialog({
  result,
  onOpenChange,
}: Readonly<{
  result: RunAmortizationNowResult;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("RunNowResultsTitle" as any)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {result.posted.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-emerald-600">{t("RunNowPostedSection" as any)}</p>
              {result.posted.map((r) => (
                <div key={r.scheduleId} className="flex justify-between text-slate-600">
                  <span>{r.title}</span>
                  <span>{t("RunNowMonthsPosted" as any).replace("{count}", String(r.monthsPosted))}</span>
                </div>
              ))}
            </div>
          )}
          {result.blocked.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-amber-600">{t("RunNowBlockedSection" as any)}</p>
              {result.blocked.map((r) => (
                <div key={r.scheduleId} className="text-slate-600">
                  <span className="font-medium">{r.title}</span>: {r.reason}
                </div>
              ))}
            </div>
          )}
          {result.failed.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-rose-600">{t("RunNowFailedSection" as any)}</p>
              {result.failed.map((r) => (
                <div key={r.scheduleId} className="text-slate-600">
                  <span className="font-medium">{r.title}</span>: {r.error}
                </div>
              ))}
            </div>
          )}
          {result.upToDateCount > 0 && (
            <p className="text-slate-500">{t("RunNowUpToDateCount" as any).replace("{count}", String(result.upToDateCount))}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Close" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ReconciliationResult = {
  currencies: string[];
  isReconciled: boolean;
  byCurrency: Record<
    string,
    { glBalanceMinor: number; subledgerBalanceMinor: number; discrepancyMinor: number; isReconciled: boolean }
  >;
};

/** GL Prepaid Expenses balance vs the subledger's own remaining total, per currency — a founder shouldn't have to be the one who notices these have drifted apart. */
function PrepaidReconciliationCard({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t } = useLanguage();
  const recon = useQuery(api.accountingReports.prepaidExpensesReconciliation, { orgId }) as
    | ReconciliationResult
    | undefined;
  const formatCurrency = useCurrencyFormatterInCurrency();

  if (!recon || recon.currencies.length === 0) return null;

  return (
    <div className="rounded-md border border-slate-200 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">{t("PrepaidReconciliationTitle" as any)}</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {recon.currencies.map((currency) => {
          const row = recon.byCurrency[currency];
          const scale = scaleForCurrency(currency);
          const factor = Math.pow(10, scale);
          return (
            <div
              key={currency}
              className={`rounded-md border p-3 text-sm space-y-1 ${
                row.isReconciled ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5"
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="font-medium text-slate-900">{currency}</span>
                <Badge
                  variant="outline"
                  className={row.isReconciled ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" : "bg-rose-500/10 text-rose-600 border-rose-500/20"}
                >
                  {t(row.isReconciled ? "PrepaidReconciliationOk" as any : "PrepaidReconciliationMismatch" as any)}
                </Badge>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>{t("PrepaidReconciliationGlLabel" as any)}</span>
                <span>{formatCurrency(row.glBalanceMinor / factor, currency, scale)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>{t("PrepaidReconciliationSubledgerLabel" as any)}</span>
                <span>{formatCurrency(row.subledgerBalanceMinor / factor, currency, scale)}</span>
              </div>
              {!row.isReconciled && (
                <div className="flex justify-between text-rose-600 font-medium">
                  <span>{t("PrepaidReconciliationDeltaLabel" as any)}</span>
                  <span>{formatCurrency(row.discrepancyMinor / factor, currency, scale)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type PendingCorrectionRequest = {
  _id: Id<"prepaidCorrectionRequests">;
  scheduleId: Id<"prepaidExpenseSchedules">;
  refundMinor: number;
  refundTaxMinor?: number;
  writeOffMinor: number;
  newTermMonths: number;
  reason: string;
  reference?: string;
  requestedBy: Id<"users">;
  requestedByName: string;
  expenseTitle: string;
  currency: string;
  createdAt: number;
};

/** Maker-checker queue for non-owner write-offs — approve/reject for anyone with MANAGE_FINANCE other than the requester (server-enforced; the approve button is also disabled client-side for the requester's own requests). */
function PendingCorrectionRequestsPanel({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t } = useLanguage();
  const { membership } = usePermissions();
  const requests = useQuery(api.prepaidExpenses.listPendingCorrectionRequests, { orgId }) as
    | PendingCorrectionRequest[]
    | undefined;
  const approve = useMutation(api.prepaidExpenses.approveCorrectionRequest);
  const reject = useMutation(api.prepaidExpenses.rejectCorrectionRequest);
  const [actingId, setActingId] = useState<Id<"prepaidCorrectionRequests"> | null>(null);
  const formatCurrency = useCurrencyFormatterInCurrency();

  if (!requests || requests.length === 0) return null;

  async function handleDecision(request: PendingCorrectionRequest, decision: "approve" | "reject") {
    setActingId(request._id);
    try {
      if (decision === "approve") {
        await approve({ orgId, requestId: request._id });
        toast.success(t("PrepaidCorrectionApproved" as any));
      } else {
        await reject({ orgId, requestId: request._id });
        toast.success(t("PrepaidCorrectionRejected" as any));
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-amber-700">{t("PendingCorrectionRequestsTitle" as any)}</h3>
      {requests.map((request) => {
        const scale = scaleForCurrency(request.currency);
        const factor = Math.pow(10, scale);
        const isOwnRequest = membership?.userId === request.requestedBy;
        return (
          <div key={request._id} className="rounded-md border border-slate-200 bg-white p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="font-medium">{request.expenseTitle}</span>
              <span className="text-slate-500">{format(new Date(request.createdAt), "MMM d, yyyy")}</span>
            </div>
            {request.refundMinor > 0 && (
              <p>
                {t("RefundAmountLabel" as any)}: {formatCurrency(request.refundMinor / factor, request.currency, scale)}
                {!!request.refundTaxMinor && request.refundTaxMinor > 0 && (
                  <> ({t("RefundVatLabel" as any)}: {formatCurrency(request.refundTaxMinor / factor, request.currency, scale)})</>
                )}
              </p>
            )}
            {request.reference && (
              <p className="text-slate-500">
                {t("RefundReferenceLabel" as any)}: {request.reference}
              </p>
            )}
            {request.writeOffMinor > 0 && (
              <p>
                {t("WriteOffAmountLabel" as any)}: {formatCurrency(request.writeOffMinor / factor, request.currency, scale)}
              </p>
            )}
            <p>
              {t("PrepaidTermLabel" as any)}: {request.newTermMonths} {t("Months" as any)}
            </p>
            <p className="text-slate-500">
              {t("RequestedByLabel" as any)}: {request.requestedByName}
            </p>
            <p className="text-slate-700">{request.reason}</p>
            {isOwnRequest && <p className="text-xs text-amber-600">{t("PrepaidCorrectionOwnRequestNotice" as any)}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={actingId === request._id}
                onClick={() => handleDecision(request, "reject")}
              >
                {t("Reject" as any)}
              </Button>
              <Button size="sm" disabled={actingId === request._id || isOwnRequest} onClick={() => handleDecision(request, "approve")}>
                {t("Approve" as any)}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PrepaidExpensesTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);

  const schedules = useQuery(
    api.prepaidExpenses.listSchedules,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  ) as ScheduleRow[] | undefined;

  // An action, not a mutation — it orchestrates one mutation call per
  // schedule so a single schedule's failure can't roll back or block the
  // others (see runAmortizationNow's own doc comment in prepaidExpenses.ts).
  const runAmortizationNow = useAction(api.prepaidExpenses.runAmortizationNow);
  const retryAmortizationFailure = useMutation(api.prepaidExpenses.retryAmortizationFailure);
  const { submitting: runningNow, submitWithFeedback: runWithFeedback } = useAccountingSubmit();
  const [retryingId, setRetryingId] = useState<Id<"prepaidExpenseSchedules"> | null>(null);
  const [correctSchedule, setCorrectSchedule] = useState<ScheduleRow | null>(null);
  const [historySchedule, setHistorySchedule] = useState<ScheduleRow | null>(null);
  const [runNowResult, setRunNowResult] = useState<RunAmortizationNowResult | null>(null);
  const formatCurrency = useCurrencyFormatterInCurrency();

  async function handleRunNow() {
    if (!activeOrgId) return;
    await runWithFeedback(async () => {
      const result = await runAmortizationNow({ orgId: activeOrgId });
      if (result.blocked.length === 0 && result.failed.length === 0) {
        const monthsPosted = result.posted.reduce((sum, r) => sum + r.monthsPosted, 0);
        toast.success(
          t("PrepaidRunNowResult" as any)
            .replace("{posted}", String(monthsPosted))
            .replace("{total}", String(result.scheduleCount))
        );
      } else {
        setRunNowResult(result);
      }
    });
  }

  async function handleRetry(schedule: ScheduleRow) {
    if (!activeOrgId) return;
    setRetryingId(schedule._id);
    try {
      await retryAmortizationFailure({ orgId: activeOrgId, scheduleId: schedule._id });
      toast.success(t("PrepaidRetrySuccess" as any));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRetryingId(null);
    }
  }

  if (!activeOrgId || schedules === undefined) {
    return <LoadingAccountingState label={t("LoadingPrepaidSchedules" as any)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="mb-2 flex justify-between items-center gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t("PrepaidExpenses" as any)}</h2>
          <p className="text-sm text-slate-500">{t("PrepaidExpensesDesc" as any)}</p>
        </div>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={handleRunNow} disabled={runningNow}>
            {runningNow ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            {t("RunAmortizationNow" as any)}
          </Button>
        )}
      </div>

      {activeOrgId && <PrepaidReconciliationCard orgId={activeOrgId} />}

      {activeOrgId && canManage && <PendingCorrectionRequestsPanel orgId={activeOrgId} />}

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Expense" as any)}</TableHead>
              <TableHead>{t("PrepaidTermLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("PrepaidTotalLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("PrepaidRecognizedLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("PrepaidRemainingLabel" as any)}</TableHead>
              <TableHead>{t("GlStatusLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.length === 0 ? (
              <AccountingEmptyRow colSpan={7} label={t("NoPrepaidSchedulesFound" as any)} />
            ) : (
              schedules.map((schedule) => {
                const scale = scaleForCurrency(schedule.currency);
                const factor = Math.pow(10, scale);
                return (
                <TableRow key={schedule._id}>
                  <TableCell className="font-medium">
                    {schedule.expenseTitle ?? t("GeneralExpense" as any)}
                    {schedule.expenseVendor && (
                      <span className="block text-xs text-slate-500">{schedule.expenseVendor}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-slate-600">
                    {schedule.startYearMonth} · {schedule.monthsRecognized}/{schedule.termMonths} {t("Months" as any)}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900">
                    {formatCurrency(schedule.totalMinor / factor, schedule.currency, scale)}
                  </TableCell>
                  <TableCell className="text-right text-slate-700">
                    {formatCurrency(schedule.recognizedMinor / factor, schedule.currency, scale)}
                  </TableCell>
                  <TableCell className="text-right text-slate-500">
                    {formatCurrency(schedule.remainingMinor / factor, schedule.currency, scale)}
                  </TableCell>
                  <TableCell>
                    {activeOrgId && (
                      <ScheduleStatusPopover
                        schedule={schedule}
                        orgId={activeOrgId}
                        canManage={canManage}
                        formatCurrency={formatCurrency}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {schedule.openFailureCount > 0 && canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("RetryAmortization" as any)}
                          disabled={retryingId === schedule._id}
                          onClick={() => handleRetry(schedule)}
                        >
                          {retryingId === schedule._id ? (
                            <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
                          ) : (
                            <RotateCcw className="w-4 h-4 text-rose-600" />
                          )}
                        </Button>
                      )}
                      {schedule.status === "ACTIVE" && canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("CorrectSchedule" as any)}
                          onClick={() => setCorrectSchedule(schedule)}
                        >
                          <Wrench className="w-4 h-4 text-slate-500" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("ViewCorrections" as any)}
                        onClick={() => setHistorySchedule(schedule)}
                      >
                        <History className="w-4 h-4 text-slate-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>

      {runNowResult && (
        <RunNowResultsDialog result={runNowResult} onOpenChange={(open) => !open && setRunNowResult(null)} />
      )}

      {activeOrgId && correctSchedule && (
        <CorrectScheduleDialog
          schedule={correctSchedule}
          orgId={activeOrgId}
          formatCurrency={formatCurrency}
          onOpenChange={(open) => !open && setCorrectSchedule(null)}
        />
      )}

      {activeOrgId && historySchedule && (
        <ScheduleCorrectionsDialog
          schedule={historySchedule}
          orgId={activeOrgId}
          formatCurrency={formatCurrency}
          onOpenChange={(open) => !open && setHistorySchedule(null)}
        />
      )}
    </div>
  );
}

function CorrectScheduleDialog({
  schedule,
  orgId,
  formatCurrency,
  onOpenChange,
}: Readonly<{
  schedule: ScheduleRow;
  orgId: Id<"organizations">;
  formatCurrency: CurrencyFormatterInCurrency;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
  const { isOwner } = usePermissions();
  const scale = scaleForCurrency(schedule.currency);
  const factor = Math.pow(10, scale);
  const correct = useMutation(api.prepaidExpenses.correctSchedule);
  const { submitting, submitWithFeedback } = useAccountingSubmit();
  // This dialog is only ever mounted while a schedule is selected for
  // correction (conditionally rendered by the parent), so a fresh key is
  // minted per open — a retry within one open (e.g. a network blip) replays
  // idempotently, and a deliberate second open gets its own key.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  // Stable across the dialog's life so the default, the max, and the "did they
  // change it?" check below all agree on the same "today".
  const today = useMemo(() => localTodayInput(), []);
  const remainingRefundableTaxMinor = useQuery(api.prepaidExpenses.getRemainingRefundableTaxMinor, {
    orgId, scheduleId: schedule._id,
  });

  const form = useForm<PrepaidCorrectionFormValues>({
    resolver: zodResolver(prepaidCorrectionSchema),
    defaultValues: {
      refundAmount: 0,
      refundTaxAmount: 0,
      refundPaymentMethod: "BANK_TRANSFER",
      reference: "",
      writeOffAmount: 0,
      changeTerm: false,
      newTermMonths: schedule.termMonths,
      reason: "",
      accountingDate: today,
    },
  });
  const changeTerm = form.watch("changeTerm");
  const refundAmount = form.watch("refundAmount") || 0;
  const writeOffAmount = form.watch("writeOffAmount") || 0;
  const needsApproval = writeOffAmount > 0 && !isOwner;

  async function onSubmit(values: PrepaidCorrectionFormValues) {
    await submitWithFeedback(async () => {
      const result = await correct({
        orgId,
        scheduleId: schedule._id,
        refundMinor: Math.round(values.refundAmount * factor),
        refundTaxMinor: values.refundAmount > 0 ? Math.round(values.refundTaxAmount * factor) : undefined,
        refundPaymentMethod: values.refundAmount > 0 ? values.refundPaymentMethod : undefined,
        reference: values.refundAmount > 0 ? values.reference?.trim() || undefined : undefined,
        writeOffMinor: Math.round(values.writeOffAmount * factor),
        newTermMonths: values.changeTerm ? values.newTermMonths : undefined,
        reason: values.reason.trim(),
        // Only sent when the accountant actually backdated it. Today is the
        // default, and the default has to keep behaving exactly as it always
        // has — the server applies its stricter rules (must land in an open
        // period) only to a date someone deliberately chose, so defaulting to
        // "send today, always" would start rejecting corrections in orgs whose
        // current period was never opened, which used to queue quietly.
        accountingDate:
          values.accountingDate && values.accountingDate !== today
            ? dateInputToUtcMs(values.accountingDate)
            : undefined,
        idempotencyKey,
      });
      toast.success(t(result.status === "PENDING" ? "PrepaidCorrectionSubmittedForApproval" as any : "PrepaidScheduleCorrected" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("CorrectSchedule" as any)}</DialogTitle>
          <DialogDescription>
            {schedule.expenseTitle} — {t("CorrectScheduleDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <AmountSummary
              label={t("PrepaidRemainingLabel" as any)}
              value={formatCurrency(schedule.remainingMinor / factor, schedule.currency, scale)}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="refundAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("RefundAmountLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="writeOffAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("WriteOffAmountLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {(refundAmount > 0 || writeOffAmount > 0) && (
              <FormField
                control={form.control}
                name="accountingDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("CorrectionAccountingDateLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="date" max={today} {...field} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">{t("CorrectionAccountingDateHint" as any)}</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {needsApproval && (
              <p className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
                {t("PrepaidCorrectionRequiresApprovalNotice" as any)}
              </p>
            )}

            {refundAmount > 0 && (
              <FormField
                control={form.control}
                name="refundPaymentMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("RefundPaymentMethodLabel" as any)}</FormLabel>
                    <FormControl>
                      <PaymentMethodSelect
                        t={t as any}
                        // defaultValues below always seeds a real value, so this
                        // fallback is unreachable at runtime — kept only because
                        // the field's zod type stays optional (refundPaymentMethod
                        // is only required when refundAmount > 0).
                        value={field.value ?? "BANK_TRANSFER"}
                        onValueChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {refundAmount > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="refundTaxAmount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("RefundVatLabel" as any)}</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} step={1 / factor} {...field} />
                      </FormControl>
                      {remainingRefundableTaxMinor !== undefined && (
                        <p className="text-xs text-slate-500">
                          {t("RefundVatCapHint" as any).replace(
                            "{amount}",
                            formatCurrency(remainingRefundableTaxMinor / factor, schedule.currency, scale)
                          )}
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="reference"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("RefundReferenceLabel" as any)}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="changeTerm"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="!mt-0">{t("ChangeTermLabel" as any)}</FormLabel>
                </FormItem>
              )}
            />

            {changeTerm && (
              <FormField
                control={form.control}
                name="newTermMonths"
                render={({ field }) => (
                  <FormItem className="max-w-[180px]">
                    <FormLabel>{t("NewTermMonthsLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("CorrectionReasonLabel" as any)}</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t(needsApproval ? "SubmitForApproval" as any : "ConfirmCorrection" as any)}
                onCancel={() => onOpenChange(false)}
                onConfirm={form.handleSubmit(onSubmit)}
                submitting={submitting}
              />
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleCorrectionsDialog({
  schedule,
  orgId,
  formatCurrency,
  onOpenChange,
}: Readonly<{
  schedule: ScheduleRow;
  orgId: Id<"organizations">;
  formatCurrency: CurrencyFormatterInCurrency;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
  const scale = scaleForCurrency(schedule.currency);
  const factor = Math.pow(10, scale);
  const corrections = useQuery(api.prepaidExpenses.listCorrections, {
    orgId,
    scheduleId: schedule._id,
  }) as Doc<"prepaidScheduleCorrections">[] | undefined;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("CorrectionHistory" as any)}</DialogTitle>
          <DialogDescription>{schedule.expenseTitle}</DialogDescription>
        </DialogHeader>

        {corrections === undefined ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : corrections.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">{t("NoCorrectionsFound" as any)}</p>
        ) : (
          <div className="space-y-3">
            {corrections.map((correction) => (
              <div key={correction._id} className="rounded-md border border-slate-200 p-3 text-sm space-y-1">
                <div className="flex justify-between text-slate-500">
                  <span>{format(new Date(correction.createdAt), "MMM d, yyyy")}</span>
                  {correction.previousTermMonths !== correction.newTermMonths && (
                    <span>
                      {t("PrepaidTermLabel" as any)}: {correction.previousTermMonths} → {correction.newTermMonths}
                    </span>
                  )}
                </div>
                {correction.refundMinor > 0 && (
                  <p>
                    {t("RefundAmountLabel" as any)}: {formatCurrency(correction.refundMinor / factor, schedule.currency, scale)}
                    {!!correction.refundTaxMinor && correction.refundTaxMinor > 0 && (
                      <> ({t("RefundVatLabel" as any)}: {formatCurrency(correction.refundTaxMinor / factor, schedule.currency, scale)})</>
                    )}
                  </p>
                )}
                {correction.reference && (
                  <p className="text-slate-500">
                    {t("RefundReferenceLabel" as any)}: {correction.reference}
                  </p>
                )}
                {correction.writeOffMinor > 0 && (
                  <p>
                    {t("WriteOffAmountLabel" as any)}: {formatCurrency(correction.writeOffMinor / factor, schedule.currency, scale)}
                  </p>
                )}
                <p className="text-slate-700">{correction.reason}</p>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
