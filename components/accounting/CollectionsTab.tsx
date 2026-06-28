"use client";

import { useMemo, useState } from "react";
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

export function CollectionsTab() {
  const { activeOrgId } = useOrg();
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
        toast.success("Cheque marked deposited.");
      } else {
        await clearCheque({ orgId: activeOrgId!, chequeId: cheque._id });
        toast.success("Cheque cleared and payment posted.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function decideApproval(row: ApprovalRow, status: "APPROVED" | "REJECTED") {
    try {
      await respondApproval({ orgId: activeOrgId!, requestId: row._id, status });
      toast.success(`Request ${status.toLowerCase()}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function decideReconciliation(id: Id<"cashierReconciliations">, status: "APPROVED" | "REJECTED") {
    try {
      await reviewReconciliation({ orgId: activeOrgId!, reconciliationId: id, status });
      toast.success(`Reconciliation ${status.toLowerCase()}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="h-full p-6 space-y-6">
      <div className="grid gap-3 md:grid-cols-5">
        <Metric icon={Landmark} label="Outstanding" value={formatCurrency(summary?.totalOutstanding ?? 0)} />
        <Metric icon={AlertTriangle} label="Overdue" value={formatCurrency(summary?.overdueOutstanding ?? 0)} tone="danger" />
        <Metric icon={CalendarClock} label="Due Today" value={formatCurrency(summary?.dueToday ?? 0)} />
        <Metric icon={HandCoins} label="Collected Today" value={formatCurrency(summary?.collectedToday ?? 0)} tone="success" />
        <Metric icon={FileCheck2} label="Upcoming Cheques" value={formatCurrency(summary?.upcomingChequeTotal ?? 0)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Receivables & Collections</h2>
          <p className="text-sm text-slate-500">Deposits, installments, cheques, cashier closing, and aging.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setReconcileOpen(true)}>
            <ShieldCheck className="me-2 h-4 w-4" />
            Reconcile Cashier
          </Button>
          <Button onClick={() => setReceivableDialog(true)}>
            <Plus className="me-2 h-4 w-4" />
            New Receivable
          </Button>
        </div>
      </div>

      <Tabs defaultValue="receivables" className="space-y-4">
        <TabsList className="bg-slate-50 border border-slate-200">
          <TabsTrigger value="receivables">Receivables</TabsTrigger>
          <TabsTrigger value="cheques">Cheques</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          {canApprove && <TabsTrigger value="approvals">Approvals</TabsTrigger>}
        </TabsList>

        <TabsContent value="receivables" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={receivableStatus} onValueChange={setReceivableStatus}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["ALL", "OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED", "PAID", "CANCELLED", "REFUNDED"].map((status) => (
                  <SelectItem key={status} value={status}>{sourceLabel(status)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>Due</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Original</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!receivables ? (
                  <EmptyRow colSpan={7} label="Loading receivables..." />
                ) : receivables.length === 0 ? (
                  <EmptyRow colSpan={7} label="No receivables found." />
                ) : (
                  receivables.map((row) => (
                    <TableRow key={row._id}>
                      <TableCell className="font-medium">{formatDate(row.dueDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.customerName}</div>
                        <div className="text-xs text-slate-500">{row.vehicleLabel || row.title}</div>
                      </TableCell>
                      <TableCell>{sourceLabel(row.sourceType)}</TableCell>
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
          {receivableLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMoreReceivables(75)}>Load more</Button>}
        </TabsContent>

        <TabsContent value="cheques" className="space-y-3">
          <Select value={chequeStatus} onValueChange={setChequeStatus}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["ALL", "HELD", "DEPOSITED", "CLEARED", "RETURNED", "REPLACED", "CANCELLED"].map((status) => (
                <SelectItem key={status} value={status}>{sourceLabel(status)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>Cheque Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!cheques ? (
                  <EmptyRow colSpan={7} label="Loading cheques..." />
                ) : cheques.length === 0 ? (
                  <EmptyRow colSpan={7} label="No cheques found." />
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
                          <Button size="sm" variant="outline" disabled={cheque.status !== "HELD"} onClick={() => runChequeAction("deposit", cheque)}>Deposit</Button>
                          <Button size="sm" variant="outline" disabled={cheque.status !== "HELD" && cheque.status !== "DEPOSITED"} onClick={() => runChequeAction("clear", cheque)}>Clear</Button>
                          <Button size="sm" variant="outline" disabled={["CLEARED", "REPLACED", "CANCELLED"].includes(cheque.status)} onClick={() => setReturnTarget(cheque)}>Return</Button>
                          <Button size="sm" variant="outline" disabled={["CLEARED", "CANCELLED"].includes(cheque.status)} onClick={() => setReplaceTarget(cheque)}>Replace</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {chequeLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMoreCheques(75)}>Load more</Button>}
        </TabsContent>

        <TabsContent value="payments" className="space-y-3">
          <div className="rounded-md border border-slate-200 overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!payments ? (
                  <EmptyRow colSpan={6} label="Loading payments..." />
                ) : payments.length === 0 ? (
                  <EmptyRow colSpan={6} label="No payments recorded." />
                ) : (
                  payments.map((payment) => (
                    <TableRow key={payment._id}>
                      <TableCell className="font-medium">{formatDate(payment.paymentDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{payment.customerName}</div>
                        <div className="text-xs text-slate-500">{payment.receivableTitle || payment.vehicleLabel || "-"}</div>
                      </TableCell>
                      <TableCell>{sourceLabel(payment.method)}</TableCell>
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
          {paymentLoadStatus === "CanLoadMore" && <Button variant="outline" onClick={() => loadMorePayments(75)}>Load more</Button>}
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ReportPanel title="Daily Collection List">
              <div className="flex items-end gap-2">
                <Input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="max-w-[180px]" />
                <div className="text-sm font-semibold text-slate-700">{formatCurrency(dailyReport?.total ?? 0)}</div>
              </div>
              <MethodTotals totals={dailyReport?.totalsByMethod ?? {}} />
            </ReportPanel>

            <ReportPanel title="Upcoming Cheque Report">
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

          <ReportPanel title="Overdue Receivables Aging">
            <div className="grid gap-3 md:grid-cols-5">
              {[
                ["Current", aging?.current],
                ["1-30", aging?.days1To30],
                ["31-60", aging?.days31To60],
                ["61-90", aging?.days61To90],
                ["90+", aging?.over90],
              ].map(([label, bucket]) => (
                <div key={label as string} className="rounded-md border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">{label as string}</p>
                  <p className="text-lg font-semibold">{formatCurrency((bucket as { amount: number } | undefined)?.amount ?? 0)}</p>
                  <p className="text-xs text-slate-500">{(bucket as { count: number } | undefined)?.count ?? 0} item(s)</p>
                </div>
              ))}
            </div>
          </ReportPanel>

          <ReportPanel title="Cashier Reconciliations">
            <div className="rounded-md border border-slate-200 overflow-x-auto">
              <Table>
                <TableHeader className="bg-slate-50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Cashier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                    {canApprove && <TableHead className="text-right">Review</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!reconciliations || reconciliations.length === 0 ? (
                    <EmptyRow colSpan={canApprove ? 7 : 6} label="No reconciliations yet." />
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
                              <Button size="sm" variant="outline" disabled={row.status !== "SUBMITTED"} onClick={() => decideReconciliation(row._id, "APPROVED")}>Approve</Button>
                              <Button size="sm" variant="outline" disabled={row.status !== "SUBMITTED"} onClick={() => decideReconciliation(row._id, "REJECTED")}>Reject</Button>
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
                    <TableHead>Customer</TableHead>
                    <TableHead>Receivable</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Requested By</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!approvals || approvals.length === 0 ? (
                    <EmptyRow colSpan={6} label="No pending collection approvals." />
                  ) : (
                    approvals.map((row) => (
                      <TableRow key={row._id}>
                        <TableCell className="font-medium">{row.customerName}</TableCell>
                        <TableCell>{row.receivableTitle}</TableCell>
                        <TableCell>{sourceLabel(row.requestType)}</TableCell>
                        <TableCell>{row.requestedByName}</TableCell>
                        <TableCell className="text-right">{row.requestedAmount ? formatCurrency(row.requestedAmount) : "-"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => decideApproval(row, "APPROVED")}>Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => decideApproval(row, "REJECTED")}>Reject</Button>
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
  return <Badge variant="outline" className={statusBadgeClass(status)}>{sourceLabel(status)}</Badge>;
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
  const entries = Object.entries(totals);
  if (entries.length === 0) return <p className="text-sm text-slate-500">No collections for this date.</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {entries.map(([method, amount]) => (
        <div key={method} className="flex justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
          <span>{sourceLabel(method)}</span>
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
      toast.success("Receivable saved.");
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
          <DialogTitle>New Receivable</DialogTitle>
          <DialogDescription>Create a one-off balance or a full installment plan.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select value={mode} onValueChange={(value) => setMode(value as "single" | "plan")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="single">Single receivable</SelectItem>
              <SelectItem value="plan">Installment plan</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceType} onValueChange={setSourceType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["CUSTOMER_DEPOSIT", "RESERVATION_PAYMENT", "INTERNAL_INSTALLMENT", "BANK_FINANCED_BALANCE", "BANK_TRANSFER", "PAYMENT_LINK", "CHEQUE", "OTHER"].map((source) => (
                <SelectItem key={source} value={source}>{sourceLabel(source)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SearchableSelect value={customerId} onValueChange={setCustomerId} options={customerOptions} placeholder="Customer" searchPlaceholder="Search customers" />
          <SearchableSelect value={vehicleId} onValueChange={(value) => setVehicleId(value === "none" ? "" : value)} options={vehicleOptions} placeholder="Vehicle" noneLabel="No vehicle" searchPlaceholder="Search vehicles" />
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={mode === "single" ? "Amount" : "Total amount"} />
          <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          {mode === "plan" && <Input type="number" min="1" max="120" value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)} placeholder="Installments" />}
          <Textarea className="sm:col-span-2" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !customerId || !title || !amount}>{submitting ? "Saving..." : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentDialog({ receivable, onOpenChange }: { receivable: ReceivableRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const recordPayment = useMutation(api.collections.recordPayment);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [paymentDate, setPaymentDate] = useState(todayInput);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !receivable) return;
    setSubmitting(true);
    try {
      await recordPayment({
        orgId: activeOrgId,
        receivableId: receivable._id,
        amount: Number(amount),
        method: method as Doc<"collectionPayments">["method"],
        paymentDate: dateInputToMs(paymentDate),
        reference: reference || undefined,
        notes: notes || undefined,
      });
      toast.success("Payment recorded.");
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
          <DialogTitle>Record Payment</DialogTitle>
          <DialogDescription>{receivable?.customerName} · {receivable ? sourceLabel(receivable.sourceType) : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={`Amount due ${receivable?.outstandingAmount ?? ""}`} />
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["CASH", "BANK_TRANSFER", "PAYMENT_LINK", "CARD", "OTHER"].map((value) => (
                <SelectItem key={value} value={value}>{sourceLabel(value)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
          <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Reference" />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !amount}>{submitting ? "Saving..." : "Record"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChequeDialog({ receivable, onOpenChange }: { receivable: ReceivableRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
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
      toast.success("Cheque registered.");
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
          <DialogTitle>Register Post-Dated Cheque</DialogTitle>
          <DialogDescription>{receivable?.customerName}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input value={bank} onChange={(event) => setBank(event.target.value)} placeholder="Bank" />
          <Input value={chequeNumber} onChange={(event) => setChequeNumber(event.target.value)} placeholder="Cheque number" />
          <Input type="date" value={chequeDate} onChange={(event) => setChequeDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount" />
          <Textarea className="sm:col-span-2" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !bank || !chequeNumber || !amount}>{submitting ? "Saving..." : "Register"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalRequestDialog({ target, onOpenChange }: { target: { receivable: ReceivableRow; type: "REFUND" | "RESCHEDULE" | "CANCEL_RECEIVABLE" } | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
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
      toast.success("Approval request submitted.");
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
          <DialogTitle>{target ? sourceLabel(target.type) : "Approval Request"}</DialogTitle>
          <DialogDescription>{target?.receivable.customerName} · {target?.receivable.title}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {target?.type === "REFUND" && <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Refund amount" />}
          {target?.type === "RESCHEDULE" && <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />}
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !reason || (target?.type === "REFUND" && !amount)}>{submitting ? "Submitting..." : "Submit"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnChequeDialog({ cheque, onOpenChange }: { cheque: ChequeRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const returnCheque = useMutation(api.collections.returnCheque);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !cheque) return;
    setSubmitting(true);
    try {
      await returnCheque({ orgId: activeOrgId, chequeId: cheque._id, returnReason: reason || undefined });
      toast.success("Cheque returned.");
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
          <DialogTitle>Return Cheque</DialogTitle>
          <DialogDescription>{cheque?.bank} #{cheque?.chequeNumber}</DialogDescription>
        </DialogHeader>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Return reason" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? "Saving..." : "Return"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceChequeDialog({ cheque, onOpenChange }: { cheque: ChequeRow | null; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
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
      toast.success("Replacement cheque registered.");
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
          <DialogTitle>Replacement Cheque</DialogTitle>
          <DialogDescription>{cheque?.bank} #{cheque?.chequeNumber}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input value={bank} onChange={(event) => setBank(event.target.value)} placeholder="Bank" />
          <Input value={chequeNumber} onChange={(event) => setChequeNumber(event.target.value)} placeholder="Cheque number" />
          <Input type="date" value={chequeDate} onChange={(event) => setChequeDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !bank || !chequeNumber || !amount}>{submitting ? "Saving..." : "Replace"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReconciliationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { activeOrgId } = useOrg();
  const submitReconciliation = useMutation(api.collections.submitCashierReconciliation);
  const [businessDate, setBusinessDate] = useState(todayInput);
  const [countedCash, setCountedCash] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const draft = useQuery(
    api.collections.getReconciliationDraft,
    activeOrgId && open ? { orgId: activeOrgId, businessDate: dateInputToMs(businessDate) } : "skip"
  );
  const formatCurrency = useCurrencyFormatter();

  async function submit() {
    if (!activeOrgId) return;
    setSubmitting(true);
    try {
      await submitReconciliation({
        orgId: activeOrgId,
        businessDate: dateInputToMs(businessDate),
        countedCash: Number(countedCash),
        notes: notes || undefined,
      });
      toast.success("Cashier reconciliation submitted.");
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
          <DialogTitle>Cashier Reconciliation</DialogTitle>
          <DialogDescription>{draft ? `${draft.paymentCount} cash payment(s), expected ${formatCurrency(draft.expectedCash)}` : "Loading expected cash..."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
          <Input type="number" min="0" step="0.01" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} placeholder="Counted cash" />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !countedCash}>{submitting ? "Submitting..." : "Submit"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
