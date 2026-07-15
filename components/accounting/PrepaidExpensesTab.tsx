"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";
import { RotateCcw, History, Wrench, PlayCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  type CurrencyFormatter,
} from "./AccountingTabShared";
import { prepaidCorrectionSchema, type PrepaidCorrectionFormValues } from "./prepaidCorrection.schema";

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
  openFailureCount: number;
  termMonths: number;
  monthsRecognized: number;
  monthsRemaining: number;
  startYearMonth: string;
  lastRecognizedYearMonth?: string;
  status: "ACTIVE" | "FULLY_AMORTIZED" | "CANCELLED";
  createdAt: number;
};

function ScheduleStatusBadge({ t, schedule }: Readonly<{ t: (key: any) => string; schedule: ScheduleRow }>) {
  if (schedule.openFailureCount > 0) {
    return <Badge variant="outline" className="bg-rose-500/10 text-rose-600 border-rose-500/20">{t("PrepaidGlStatus_FAILED")}</Badge>;
  }
  if (schedule.pendingMinor > 0) {
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

export function PrepaidExpensesTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);

  const schedules = useQuery(
    api.prepaidExpenses.listSchedules,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  ) as ScheduleRow[] | undefined;

  const runAmortizationNow = useMutation(api.prepaidExpenses.runAmortizationNow);
  const retryAmortizationFailure = useMutation(api.prepaidExpenses.retryAmortizationFailure);
  const { submitting: runningNow, submitWithFeedback: runWithFeedback } = useAccountingSubmit();
  const [retryingId, setRetryingId] = useState<Id<"prepaidExpenseSchedules"> | null>(null);
  const [correctSchedule, setCorrectSchedule] = useState<ScheduleRow | null>(null);
  const [historySchedule, setHistorySchedule] = useState<ScheduleRow | null>(null);
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();

  async function handleRunNow() {
    if (!activeOrgId) return;
    await runWithFeedback(async () => {
      const result = await runAmortizationNow({ orgId: activeOrgId });
      toast.success(
        t("PrepaidRunNowResult" as any)
          .replace("{posted}", String(result.monthsPosted))
          .replace("{total}", String(result.scheduleCount))
      );
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

  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);

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
              schedules.map((schedule) => (
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
                    {formatCurrency(schedule.totalMinor / factor, scale)}
                  </TableCell>
                  <TableCell className="text-right text-slate-700">
                    {formatCurrency(schedule.recognizedMinor / factor, scale)}
                  </TableCell>
                  <TableCell className="text-right text-slate-500">
                    {formatCurrency(schedule.remainingMinor / factor, scale)}
                  </TableCell>
                  <TableCell>
                    <ScheduleStatusBadge t={t as any} schedule={schedule} />
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
              ))
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>

      {activeOrgId && correctSchedule && (
        <CorrectScheduleDialog
          schedule={correctSchedule}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
          onOpenChange={(open) => !open && setCorrectSchedule(null)}
        />
      )}

      {activeOrgId && historySchedule && (
        <ScheduleCorrectionsDialog
          schedule={historySchedule}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
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
  factor,
  scale,
  formatCurrency,
  onOpenChange,
}: Readonly<{
  schedule: ScheduleRow;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
  const correct = useMutation(api.prepaidExpenses.correctSchedule);
  const { submitting, submitWithFeedback } = useAccountingSubmit();
  // This dialog is only ever mounted while a schedule is selected for
  // correction (conditionally rendered by the parent), so a fresh key is
  // minted per open — a retry within one open (e.g. a network blip) replays
  // idempotently, and a deliberate second open gets its own key.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const form = useForm<PrepaidCorrectionFormValues>({
    resolver: zodResolver(prepaidCorrectionSchema),
    defaultValues: {
      refundAmount: 0,
      refundPaymentMethod: "BANK_TRANSFER",
      writeOffAmount: 0,
      changeTerm: false,
      newTermMonths: schedule.termMonths,
      reason: "",
    },
  });
  const changeTerm = form.watch("changeTerm");
  const refundAmount = form.watch("refundAmount") || 0;

  async function onSubmit(values: PrepaidCorrectionFormValues) {
    await submitWithFeedback(async () => {
      await correct({
        orgId,
        scheduleId: schedule._id,
        refundMinor: Math.round(values.refundAmount * factor),
        refundPaymentMethod: values.refundAmount > 0 ? values.refundPaymentMethod : undefined,
        writeOffMinor: Math.round(values.writeOffAmount * factor),
        newTermMonths: values.changeTerm ? values.newTermMonths : undefined,
        reason: values.reason.trim(),
        idempotencyKey,
      });
      toast.success(t("PrepaidScheduleCorrected" as any));
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
              value={formatCurrency(schedule.remainingMinor / factor, scale)}
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
                confirmLabel={t("ConfirmCorrection" as any)}
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
  factor,
  scale,
  formatCurrency,
  onOpenChange,
}: Readonly<{
  schedule: ScheduleRow;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
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
                    {t("RefundAmountLabel" as any)}: {formatCurrency(correction.refundMinor / factor, scale)}
                  </p>
                )}
                {correction.writeOffMinor > 0 && (
                  <p>
                    {t("WriteOffAmountLabel" as any)}: {formatCurrency(correction.writeOffMinor / factor, scale)}
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
