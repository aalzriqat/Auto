"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { format } from "date-fns";
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  FileCheck2,
  HandCoins,
  Landmark,
  Plus,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "@/components/ui/sonner";

type ReceivableRow = Doc<"receivables"> & {
  customerName: string;
  vehicleLabel?: string;
};

type ChequeRow = Doc<"postDatedCheques"> & {
  customerName: string;
  vehicleLabel?: string;
  receivableTitle?: string;
};

type ApprovalRow = Doc<"collectionApprovalRequests"> & {
  receivableTitle: string;
  customerName: string;
  requestedByName: string;
};

const todayInput = new Date().toISOString().slice(0, 10);
const weekFromNowInput = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function dateInputToMs(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function formatDate(value: number) {
  return format(new Date(value), "MMM d, yyyy");
}

function statusBadgeClass(status: string) {
  if (["PAID", "CLEARED", "APPROVED", "SENT"].includes(status)) return "bg-emerald-100 text-emerald-800 hover:bg-emerald-100";
  if (["OVERDUE", "RETURNED", "REJECTED", "FAILED"].includes(status)) return "bg-rose-100 text-rose-800 hover:bg-rose-100";
  if (["PARTIALLY_PAID", "DEPOSITED", "RESCHEDULED", "SUBMITTED"].includes(status)) return "bg-amber-100 text-amber-800 hover:bg-amber-100";
  return "bg-slate-100 text-slate-700 hover:bg-slate-100";
}

function sourceLabel(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function collectionLabel(t: (key: string) => string, value: string) {
  const key = `CollectionLabel_${value}`;
  const translated = t(key);
  return translated === key ? sourceLabel(value) : translated;
}

export function CollectionsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission } = usePermissions();
  const canApprove = hasPermission("approve:requests");

  const [receivableStatus, setReceivableStatus] = useState<string>("ALL");
  const [chequeStatus, setChequeStatus] = useState<string>("ALL");
  const [reportDate, setReportDate] = useState(todayInput);
  const [chequeStart, setChequeStart] = useState(todayInput);
  const [chequeEnd, setChequeEnd] = useState(weekFromNowInput);
  const [receivableDialog, setReceivableDialog] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<ReceivableRow | null>(null);
  const [chequeTarget, setChequeTarget] = useState<ReceivableRow | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<{ receivable: ReceivableRow; type: "REFUND" | "RESCHEDULE" | "CANCEL_RECEIVABLE" } | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<ChequeRow | null>(null);
  const [returnTarget, setReturnTarget] = useState<ChequeRow | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  const summary = useQuery(api.collections.summary, activeOrgId ? { orgId: activeOrgId } : "skip");
  const { results: receivables, status: receivableLoadStatus, loadMore: loadMoreReceivables } = usePaginatedQuery(
    api.collections.listReceivables,
    activeOrgId
      ? {
          orgId: activeOrgId,
          status: receivableStatus === "ALL" ? undefined : receivableStatus as ReceivableRow["status"],
        }
      : "skip",
    { initialNumItems: 75 }
  );
  const { results: cheques, status: chequeLoadStatus, loadMore: loadMoreCheques } = usePaginatedQuery(
    api.collections.listCheques,
    activeOrgId
      ? {
          orgId: activeOrgId,
          status: chequeStatus === "ALL" ? undefined : chequeStatus as ChequeRow["status"],
        }
      : "skip",
    { initialNumItems: 75 }
  );
  const { results: payments, status: paymentLoadStatus, loadMore: loadMorePayments } = usePaginatedQuery(
    api.collections.listPayments,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 75 }
  );
  const dailyReport = useQuery(
    api.collections.dailyCollectionList,
    activeOrgId ? { orgId: activeOrgId, businessDate: dateInputToMs(reportDate) } : "skip"
  );
  const chequeReport = useQuery(
    api.collections.upcomingChequeReport,
    activeOrgId ? { orgId: activeOrgId, startDate: dateInputToMs(chequeStart), endDate: dateInputToMs(chequeEnd) } : "skip"
  );
  const aging = useQuery(api.collections.agingReport, activeOrgId ? { orgId: activeOrgId } : "skip");
  const approvals = useQuery(
    api.collections.listApprovals,
    activeOrgId && canApprove ? { orgId: activeOrgId, status: "PENDING" } : "skip"
  );
  const reconciliations = useQuery(api.collections.listReconciliations, activeOrgId ? { orgId: activeOrgId } : "skip");

  const depositCheque = useMutation(api.collections.depositCheque);
  const clearCheque = useMutation(api.collections.clearCheque);
  const respondApproval = useMutation(api.collections.respondToApproval);
  const reviewReconciliation = useMutation(api.collections.reviewCashierReconciliation);

  if (!activeOrgId) return null;

  async function runChequeAction(action: "deposit" | "clear", cheque: ChequeRow) {
    try {
      if (action === "deposit") {
        await depositCheque({ orgId: activeOrgId!, chequeId: cheque._id });
        toast.success(t("CollectionToastChequeDeposited" as any));
      } else {
        await clearCheque({ orgId: activeOrgId!, chequeId: cheque._id });
        toast.success(t("CollectionToastChequeCleared" as any));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function decideApproval(row: ApprovalRow, status: "APPROVED" | "REJECTED") {
    try {
      await respondApproval({ orgId: activeOrgId!, requestId: row._id, status });
      toast.success(status === "APPROVED" ? t("CollectionToastRequestApproved" as any) : t("CollectionToastRequestRejected" as any));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function decideReconciliation(id: Id<"cashierReconciliations">, status: "APPROVED" | "REJECTED") {
    try {
      await reviewReconciliation({ orgId: activeOrgId!, reconciliationId: id, status });
      toast.success(status === "APPROVED" ? t("CollectionToastReconciliationApproved" as any) : t("CollectionToastReconciliationRejected" as any));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="h-full p-6 space-y-6">
      <div className="grid gap-3 md:grid-cols-5">
        <Metric icon={Landmark} label={t("CollectionOutstanding" as any)} value={formatCurrency(summary?.totalOutstanding ?? 0)} />
        <Metric icon={AlertTriangle} label={t("CollectionOverdue" as any)} value={formatCurrency(summary?.overdueOutstanding ?? 0)} tone="danger" />
        <Metric icon={CalendarClock} label={t("CollectionDueToday" as any)} value={formatCurrency(summary?.dueToday ?? 0)} />
        <Metric icon={HandCoins} label={t("CollectionCollectedToday" as any)} value={formatCurrency(summary?.collectedToday ?? 0)} tone="success" />
        <Metric icon={FileCheck2} label={t("CollectionUpcomingCheques" as any)} value={formatCurrency(summary?.upcomingChequeTotal ?? 0)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t("CollectionsTitle" as any)}</h2>
          <p className="text-sm text-slate-500">{t("CollectionsDesc" as any)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setReconcileOpen(true)}>
            <ShieldCheck className="me-2 h-4 w-4" />
            {t("ReconcileCashier" as any)}
          </Button>
          <Button onClick={() => setReceivableDialog(true)}>
            <Plus className="me-2 h-4 w-4" />
            {t("NewReceivable" as any)}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="receivables" className="space-y-4">
        <TabsList className="bg-slate-50 border border-slate-200">
          <TabsTrigger value="receivables">{t("Receivables" as any)}</TabsTrigger>
          <TabsTrigger value="cheques">{t("Cheques" as any)}</TabsTrigger>
          <TabsTrigger value="payments">{t("Payments" as any)}</TabsTrigger>
          <TabsTrigger value="reports">{t("Reports" as any)}</TabsTrigger>
          {canApprove && <TabsTrigger value="approvals">{t("Approvals" as any)}</TabsTrigger>}
        </TabsList>

        <TabsContent value="receivables" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={receivableStatus} onValueChange={setReceivableStatus}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["ALL", "OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED", "PAID", "CANCELLED", "REFUNDED"].map((status) => (
                  <SelectItem key={status} value={status}>{collectionLabel(t, status)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>{t("Due" as any)}</TableHead>
                  <TableHead>{t("Customer" as any)}</TableHead>
                  <TableHead>{t("Source" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead className="text-right">{t("Original" as any)}</TableHead>
                  <TableHead className="text-right">{t("CollectionOutstanding" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!receivables ? (
                  <EmptyRow colSpan={7} label={t("LoadingReceivables" as any)} />
                ) : receivables.length === 0 ? (
                  <EmptyRow colSpan={7} label={t("NoReceivablesFound" as any)} />
                ) : (
                  receivables.map((row) => (
                    <TableRow key={row._id}>
                      <TableCell className="font-medium">{formatDate(row.dueDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.customerName}</div>
                        <div className="text-xs text-slate-500">{row.vehicleLabel || row.title}</div>
                      </TableCell>
                      <TableCell>{collectionLabel(t, row.sourceType)}</TableCell>
                      <TableCell><StatusBadge status={row.status} /></TableCell>
                      <TableCell className="text-right">{formatCurrency(row.originalAmount)}</TableCell>
                      <TableCell className="text-right font-semibold">{formatCurrency(row.outstandingAmount)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => setPaymentTarget(row)} disabled={row.outstandingAmount <= 0}>
                            <Banknote className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setChequeTarget(row)} disabled={row.outstandingAmount <= 0}>
                            <FileCheck2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setApprovalTarget({ receivable: row, type: "RESCHEDULE" })}>
                            <CalendarClock className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setApprovalTarget({ receivable: row, type: "REFUND" })}>
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {receivableLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMoreReceivables(75)}>{t("LoadMore" as any)}</Button>}
        </TabsContent>

        <TabsContent value="cheques" className="space-y-3">
          <Select value={chequeStatus} onValueChange={setChequeStatus}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["ALL", "HELD", "DEPOSITED", "CLEARED", "RETURNED", "REPLACED", "CANCELLED"].map((status) => (
                <SelectItem key={status} value={status}>{collectionLabel(t, status)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>{t("ChequeDate" as any)}</TableHead>
                  <TableHead>{t("Customer" as any)}</TableHead>
                  <TableHead>{t("Bank" as any)}</TableHead>
                  <TableHead>{t("Number" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead className="text-right">{t("Amount" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!cheques ? (
                  <EmptyRow colSpan={7} label={t("LoadingCheques" as any)} />
                ) : cheques.length === 0 ? (
                  <EmptyRow colSpan={7} label={t("NoChequesFound" as any)} />
                ) : (
                  cheques.map((cheque) => (
                    <TableRow key={cheque._id}>
                      <TableCell className="font-medium">{formatDate(cheque.chequeDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{cheque.customerName}</div>
                        <div className="text-xs text-slate-500">{cheque.receivableTitle || cheque.vehicleLabel || "-"}</div>
                      </TableCell>
                      <TableCell>{cheque.bank}</TableCell>
                      <TableCell>{cheque.chequeNumber}</TableCell>
                      <TableCell><StatusBadge status={cheque.status} /></TableCell>
                      <TableCell className="text-right font-semibold">{formatCurrency(cheque.amount)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" disabled={cheque.status !== "HELD"} onClick={() => runChequeAction("deposit", cheque)}>{t("Deposit" as any)}</Button>
                          <Button size="sm" variant="outline" disabled={cheque.status !== "HELD" && cheque.status !== "DEPOSITED"} onClick={() => runChequeAction("clear", cheque)}>{t("Clear" as any)}</Button>
                          <Button size="sm" variant="outline" disabled={["CLEARED", "REPLACED", "CANCELLED"].includes(cheque.status)} onClick={() => setReturnTarget(cheque)}>{t("Return" as any)}</Button>
                          <Button size="sm" variant="outline" disabled={["CLEARED", "CANCELLED"].includes(cheque.status)} onClick={() => setReplaceTarget(cheque)}>{t("Replace" as any)}</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {chequeLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMoreCheques(75)}>{t("LoadMore" as any)}</Button>}
        </TabsContent>

        <TabsContent value="payments" className="space-y-3">
          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>{t("Date" as any)}</TableHead>
                  <TableHead>{t("Customer" as any)}</TableHead>
                  <TableHead>{t("Method" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead>{t("Reference" as any)}</TableHead>
                  <TableHead className="text-right">{t("Amount" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!payments ? (
                  <EmptyRow colSpan={6} label={t("LoadingPayments" as any)} />
                ) : payments.length === 0 ? (
                  <EmptyRow colSpan={6} label={t("NoPaymentsRecorded" as any)} />
                ) : (
                  payments.map((payment) => (
                    <TableRow key={payment._id}>
                      <TableCell className="font-medium">{formatDate(payment.paymentDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{payment.customerName}</div>
                        <div className="text-xs text-slate-500">{payment.receivableTitle || payment.vehicleLabel || "-"}</div>
                      </TableCell>
                      <TableCell>{collectionLabel(t, payment.method)}</TableCell>
                      <TableCell><StatusBadge status={payment.status} /></TableCell>
                      <TableCell className="text-slate-500">{payment.reference || "-"}</TableCell>
                      <TableCell className={`text-right font-semibold ${payment.direction === "IN" ? "text-emerald-600" : "text-rose-600"}`}>
                        {payment.direction === "IN" ? "+" : "-"}{formatCurrency(payment.amount)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {paymentLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMorePayments(75)}>{t("LoadMore" as any)}</Button>}
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ReportPanel title={t("DailyCollectionList" as any)}>
              <div className="flex items-end gap-2">
                <Input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="max-w-[180px]" />
                <div className="text-sm font-semibold text-slate-700">{formatCurrency(dailyReport?.total ?? 0)}</div>
              </div>
              <MethodTotals totals={dailyReport?.totalsByMethod ?? {}} />
            </ReportPanel>

            <ReportPanel title={t("UpcomingChequeReport" as any)}>
              <div className="flex flex-wrap items-end gap-2">
                <Input type="date" value={chequeStart} onChange={(event) => setChequeStart(event.target.value)} className="max-w-[180px]" />
                <Input type="date" value={chequeEnd} onChange={(event) => setChequeEnd(event.target.value)} className="max-w-[180px]" />
                <div className="text-sm font-semibold text-slate-700">{formatCurrency(chequeReport?.total ?? 0)}</div>
              </div>
              <div className="max-h-48 overflow-y-auto text-sm">
                {(chequeReport?.rows ?? []).slice(0, 8).map((cheque) => (
                  <div key={cheque._id} className="flex justify-between border-b border-slate-100 py-2">
                    <span>{cheque.customerName} · {cheque.bank} #{cheque.chequeNumber}</span>
                    <span className="font-medium">{formatCurrency(cheque.amount)}</span>
                  </div>
                ))}
              </div>
            </ReportPanel>
          </div>

          <ReportPanel title={t("OverdueReceivablesAging" as any)}>
            <div className="grid gap-3 md:grid-cols-5">
              {[
                [t("Current" as any), aging?.current],
                ["1-30", aging?.days1To30],
                ["31-60", aging?.days31To60],
                ["61-90", aging?.days61To90],
                ["90+", aging?.over90],
              ].map(([label, bucket]) => (
                <div key={label as string} className="rounded-md border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">{label as string}</p>
                  <p className="text-lg font-semibold">{formatCurrency((bucket as { amount: number } | undefined)?.amount ?? 0)}</p>
                  <p className="text-xs text-slate-500">{t("CollectionItemCount" as any).replace("{count}", String((bucket as { count: number } | undefined)?.count ?? 0))}</p>
                </div>
              ))}
            </div>
          </ReportPanel>

          <ReportPanel title={t("CashierReconciliations" as any)}>
            <div className="rounded-md border border-slate-200 overflow-x-auto">
              <Table>
                <TableHeader className="bg-slate-50">
                  <TableRow>
                    <TableHead>{t("Date" as any)}</TableHead>
                    <TableHead>{t("Cashier" as any)}</TableHead>
                    <TableHead>{t("Status" as any)}</TableHead>
                    <TableHead className="text-right">{t("Expected" as any)}</TableHead>
                    <TableHead className="text-right">{t("Counted" as any)}</TableHead>
                    <TableHead className="text-right">{t("Difference" as any)}</TableHead>
                    {canApprove && <TableHead className="text-right">{t("Review" as any)}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!reconciliations || reconciliations.length === 0 ? (
                    <EmptyRow colSpan={canApprove ? 7 : 6} label={t("NoReconciliationsYet" as any)} />
                  ) : (
                    reconciliations.map((row) => (
                      <TableRow key={row._id}>
                        <TableCell>{formatDate(row.businessDate)}</TableCell>
                        <TableCell>{row.cashierName}</TableCell>
                        <TableCell><StatusBadge status={row.status} /></TableCell>
                        <TableCell className="text-right">{formatCurrency(row.expectedCash)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.countedCash)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.difference)}</TableCell>
                        {canApprove && (
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="outline" disabled={row.status !== "SUBMITTED"} onClick={() => decideReconciliation(row._id, "APPROVED")}>{t("Approve" as any)}</Button>
                              <Button size="sm" variant="outline" disabled={row.status !== "SUBMITTED"} onClick={() => decideReconciliation(row._id, "REJECTED")}>{t("Reject" as any)}</Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </ReportPanel>
        </TabsContent>

        {canApprove && (
          <TabsContent value="approvals">
            <div className="rounded-md border border-slate-200 overflow-x-auto">
              <Table>
                <TableHeader className="bg-slate-50">
                  <TableRow>
                    <TableHead>{t("Customer" as any)}</TableHead>
                    <TableHead>{t("Receivable" as any)}</TableHead>
                    <TableHead>{t("TypeLabel" as any)}</TableHead>
                    <TableHead>{t("RequestedBy" as any)}</TableHead>
                    <TableHead className="text-right">{t("Amount" as any)}</TableHead>
                    <TableHead className="text-right">{t("Decision" as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!approvals || approvals.length === 0 ? (
                    <EmptyRow colSpan={6} label={t("NoPendingCollectionApprovals" as any)} />
                  ) : (
                    approvals.map((row) => (
                      <TableRow key={row._id}>
                        <TableCell className="font-medium">{row.customerName}</TableCell>
                        <TableCell>{row.receivableTitle}</TableCell>
                        <TableCell>{collectionLabel(t, row.requestType)}</TableCell>
                        <TableCell>{row.requestedByName}</TableCell>
                        <TableCell className="text-right">{row.requestedAmount ? formatCurrency(row.requestedAmount) : "-"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => decideApproval(row, "APPROVED")}>{t("Approve" as any)}</Button>
                            <Button size="sm" variant="outline" onClick={() => decideApproval(row, "REJECTED")}>{t("Reject" as any)}</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        )}
      </Tabs>

      <ReceivableDialog open={receivableDialog} onOpenChange={setReceivableDialog} />
      <PaymentDialog receivable={paymentTarget} onOpenChange={(open) => !open && setPaymentTarget(null)} />
      <ChequeDialog receivable={chequeTarget} onOpenChange={(open) => !open && setChequeTarget(null)} />
      <ApprovalRequestDialog target={approvalTarget} onOpenChange={(open) => !open && setApprovalTarget(null)} />
      <ReplaceChequeDialog cheque={replaceTarget} onOpenChange={(open) => !open && setReplaceTarget(null)} />
      <ReturnChequeDialog cheque={returnTarget} onOpenChange={(open) => !open && setReturnTarget(null)} />
      <ReconciliationDialog open={reconcileOpen} onOpenChange={setReconcileOpen} />
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-emerald-600" : tone === "danger" ? "text-rose-600" : "text-slate-700";
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={`mt-2 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  return <Badge variant="outline" className={statusBadgeClass(status)}>{collectionLabel(t, status)}</Badge>;
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-slate-500">{label}</TableCell>
    </TableRow>
  );
}

function ReportPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function MethodTotals({ totals }: { totals: Record<string, number> }) {
  const formatCurrency = useCurrencyFormatter();
  const { t } = useLanguage();
  const entries = Object.entries(totals);
  if (entries.length === 0) return <p className="text-sm text-slate-500">{t("NoCollectionsForDate" as any)}</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {entries.map(([method, amount]) => (
        <div key={method} className="flex justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
          <span>{collectionLabel(t, method)}</span>
          <span className="font-medium">{formatCurrency(amount)}</span>
        </div>
      ))}
    </div>
  );
}

function useCustomerVehicleOptions() {
  const { activeOrgId } = useOrg();
  const { results: customers } = usePaginatedQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });
  const { results: vehicles } = usePaginatedQuery(api.vehicles.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });

  const customerOptions = useMemo(
    () => (customers ?? []).map((customer) => ({
      value: customer._id,
      label: `${customer.firstName} ${customer.lastName}`.trim(),
      subLabel: customer.phone || customer.whatsapp || customer.email || undefined,
    })),
    [customers]
  );

  const vehicleOptions = useMemo(
    () => (vehicles ?? []).map((vehicle) => ({
      value: vehicle._id,
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      subLabel: vehicle.vin,
    })),
    [vehicles]
  );

  return { customerOptions, vehicleOptions };
}

function ReceivableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const createReceivable = useMutation(api.collections.createReceivable);
  const createInstallmentPlan = useMutation(api.collections.createInstallmentPlan);
  const { customerOptions, vehicleOptions } = useCustomerVehicleOptions();
  const [mode, setMode] = useState<"single" | "plan">("single");
  const [customerId, setCustomerId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("INTERNAL_INSTALLMENT");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayInput);
  const [installmentCount, setInstallmentCount] = useState("12");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !customerId) return;
    setSubmitting(true);
    try {
      const common = {
        orgId: activeOrgId,
        customerId: customerId as Id<"customers">,
        vehicleId: vehicleId ? vehicleId as Id<"vehicles"> : undefined,
        title: title.trim(),
        notes: notes || undefined,
      };
      if (mode === "single") {
        await createReceivable({
          ...common,
          amount: Number(amount),
          dueDate: dateInputToMs(dueDate),
          sourceType: sourceType as Doc<"receivables">["sourceType"],
        });
      } else {
        await createInstallmentPlan({
          ...common,
          totalAmount: Number(amount),
          installmentCount: Number(installmentCount),
          firstDueDate: dateInputToMs(dueDate),
          sourceType: sourceType as Doc<"receivables">["sourceType"],
        });
      }
      toast.success(t("CollectionToastReceivableSaved" as any));
      onOpenChange(false);
      setTitle("");
      setAmount("");
      setNotes("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("NewReceivable" as any)}</DialogTitle>
          <DialogDescription>{t("NewReceivableDesc" as any)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select value={mode} onValueChange={(value) => setMode(value as "single" | "plan")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{t("SingleReceivable" as any)}</SelectItem>
              <SelectItem value="plan">{t("InstallmentPlan" as any)}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceType} onValueChange={setSourceType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["CUSTOMER_DEPOSIT", "RESERVATION_PAYMENT", "INTERNAL_INSTALLMENT", "BANK_FINANCED_BALANCE", "BANK_TRANSFER", "PAYMENT_LINK", "CHEQUE", "OTHER"].map((source) => (
                <SelectItem key={source} value={source}>{collectionLabel(t, source)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SearchableSelect value={customerId} onValueChange={setCustomerId} options={customerOptions} placeholder={t("Customer" as any)} searchPlaceholder={t("SearchCustomersPlaceholder" as any)} />
          <SearchableSelect value={vehicleId} onValueChange={(value) => setVehicleId(value === "none" ? "" : value)} options={vehicleOptions} placeholder={t("Vehicle" as any)} noneLabel={t("NoVehicle" as any)} searchPlaceholder={t("SearchVehiclesPlaceholder" as any)} />
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("Title" as any)} />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={mode === "single" ? t("Amount" as any) : t("TotalAmount" as any)} />
          <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          {mode === "plan" && <Input type="number" min="1" max="120" value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)} placeholder={t("Installments" as any)} />}
          <Textarea className="sm:col-span-2" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("NotesLabel" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !customerId || !title || !amount}>{submitting ? t("Saving" as any) : t("Save" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentDialog({ receivable, onOpenChange }: { receivable: ReceivableRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const recordPayment = useMutation(api.collections.recordPayment);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [paymentDate, setPaymentDate] = useState(todayInput);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  async function submit() {
    if (!activeOrgId || !receivable) return;
    setSubmitting(true);
    try {
      idempotencyKeyRef.current ??= `collection-payment:${crypto.randomUUID()}`;
      await recordPayment({
        orgId: activeOrgId,
        receivableId: receivable._id,
        amount: Number(amount),
        method: method as Doc<"collectionPayments">["method"],
        paymentDate: dateInputToMs(paymentDate),
        reference: reference || undefined,
        notes: notes || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(t("CollectionToastPaymentRecorded" as any));
      idempotencyKeyRef.current = null;
      onOpenChange(false);
      setAmount("");
      setReference("");
      setNotes("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!receivable} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("RecordPayment" as any)}</DialogTitle>
          <DialogDescription>{receivable?.customerName} · {receivable ? collectionLabel(t, receivable.sourceType) : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={`${t("AmountDue" as any)} ${receivable?.outstandingAmount ?? ""}`} />
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["CASH", "BANK_TRANSFER", "PAYMENT_LINK", "CARD", "OTHER"].map((value) => (
                <SelectItem key={value} value={value}>{collectionLabel(t, value)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
          <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder={t("Reference" as any)} />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("NotesLabel" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !amount}>{submitting ? t("Saving" as any) : t("Record" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChequeDialog({ receivable, onOpenChange }: { receivable: ReceivableRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const registerCheque = useMutation(api.collections.registerCheque);
  const [bank, setBank] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeDate, setChequeDate] = useState(todayInput);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !receivable) return;
    setSubmitting(true);
    try {
      await registerCheque({
        orgId: activeOrgId,
        receivableId: receivable._id,
        customerId: receivable.customerId,
        vehicleId: receivable.vehicleId,
        saleId: receivable.saleId,
        bank,
        chequeNumber,
        chequeDate: dateInputToMs(chequeDate),
        amount: Number(amount),
        notes: notes || undefined,
      });
      toast.success(t("CollectionToastChequeRegistered" as any));
      onOpenChange(false);
      setBank("");
      setChequeNumber("");
      setAmount("");
      setNotes("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!receivable} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("RegisterPostDatedCheque" as any)}</DialogTitle>
          <DialogDescription>{receivable?.customerName}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input value={bank} onChange={(event) => setBank(event.target.value)} placeholder={t("Bank" as any)} />
          <Input value={chequeNumber} onChange={(event) => setChequeNumber(event.target.value)} placeholder={t("ChequeNumber" as any)} />
          <Input type="date" value={chequeDate} onChange={(event) => setChequeDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("Amount" as any)} />
          <Textarea className="sm:col-span-2" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("NotesLabel" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !bank || !chequeNumber || !amount}>{submitting ? t("Saving" as any) : t("Register" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalRequestDialog({ target, onOpenChange }: { target: { receivable: ReceivableRow; type: "REFUND" | "RESCHEDULE" | "CANCEL_RECEIVABLE" } | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const requestApproval = useMutation(api.collections.requestApproval);
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayInput);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !target) return;
    setSubmitting(true);
    try {
      await requestApproval({
        orgId: activeOrgId,
        receivableId: target.receivable._id,
        requestType: target.type,
        requestedAmount: target.type === "REFUND" ? Number(amount) : undefined,
        requestedDueDate: target.type === "RESCHEDULE" ? dateInputToMs(dueDate) : undefined,
        reason,
      });
      toast.success(t("CollectionToastApprovalSubmitted" as any));
      onOpenChange(false);
      setAmount("");
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? collectionLabel(t, target.type) : t("ApprovalRequest" as any)}</DialogTitle>
          <DialogDescription>{target?.receivable.customerName} · {target?.receivable.title}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {target?.type === "REFUND" && <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("RefundAmount" as any)} />}
          {target?.type === "RESCHEDULE" && <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />}
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Reason" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !reason || (target?.type === "REFUND" && !amount)}>{submitting ? t("Submitting" as any) : t("Submit" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnChequeDialog({ cheque, onOpenChange }: { cheque: ChequeRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const returnCheque = useMutation(api.collections.returnCheque);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !cheque) return;
    setSubmitting(true);
    try {
      await returnCheque({ orgId: activeOrgId, chequeId: cheque._id, returnReason: reason || undefined });
      toast.success(t("CollectionToastChequeReturned" as any));
      onOpenChange(false);
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!cheque} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ReturnCheque" as any)}</DialogTitle>
          <DialogDescription>{cheque?.bank} #{cheque?.chequeNumber}</DialogDescription>
        </DialogHeader>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("ReturnReason" as any)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? t("Saving" as any) : t("Return" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceChequeDialog({ cheque, onOpenChange }: { cheque: ChequeRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const replaceCheque = useMutation(api.collections.replaceCheque);
  const [bank, setBank] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeDate, setChequeDate] = useState(todayInput);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !cheque) return;
    setSubmitting(true);
    try {
      await replaceCheque({
        orgId: activeOrgId,
        chequeId: cheque._id,
        bank,
        chequeNumber,
        chequeDate: dateInputToMs(chequeDate),
        amount: Number(amount),
      });
      toast.success(t("CollectionToastReplacementChequeRegistered" as any));
      onOpenChange(false);
      setBank("");
      setChequeNumber("");
      setAmount("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!cheque} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ReplacementCheque" as any)}</DialogTitle>
          <DialogDescription>{cheque?.bank} #{cheque?.chequeNumber}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input value={bank} onChange={(event) => setBank(event.target.value)} placeholder={t("Bank" as any)} />
          <Input value={chequeNumber} onChange={(event) => setChequeNumber(event.target.value)} placeholder={t("ChequeNumber" as any)} />
          <Input type="date" value={chequeDate} onChange={(event) => setChequeDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("Amount" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !bank || !chequeNumber || !amount}>{submitting ? t("Saving" as any) : t("Replace" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReconciliationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const submitReconciliation = useMutation(api.collections.submitCashierReconciliation);
  const [businessDate, setBusinessDate] = useState(todayInput);
  const [countedCash, setCountedCash] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const draft = useQuery(
    api.collections.getReconciliationDraft,
    activeOrgId && open ? { orgId: activeOrgId, businessDate: dateInputToMs(businessDate) } : "skip"
  );
  const formatCurrency = useCurrencyFormatter();

  async function submit() {
    if (!activeOrgId) return;
    setSubmitting(true);
    try {
      idempotencyKeyRef.current ??= `cashier-reconciliation:${crypto.randomUUID()}`;
      await submitReconciliation({
        orgId: activeOrgId,
        businessDate: dateInputToMs(businessDate),
        countedCash: Number(countedCash),
        notes: notes || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(t("CollectionToastReconciliationSubmitted" as any));
      idempotencyKeyRef.current = null;
      onOpenChange(false);
      setCountedCash("");
      setNotes("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("CashierReconciliation" as any)}</DialogTitle>
          <DialogDescription>{draft ? t("CashierReconciliationDraftDesc" as any).replace("{count}", String(draft.paymentCount)).replace("{amount}", formatCurrency(draft.expectedCash)) : t("LoadingExpectedCash" as any)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} placeholder={t("CountedCash" as any)} />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("NotesLabel" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !countedCash}>{submitting ? t("Submitting" as any) : t("Submit" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
