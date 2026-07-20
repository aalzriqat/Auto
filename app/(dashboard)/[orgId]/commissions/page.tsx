"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { TrendingUp, CheckCircle2, Clock, DollarSign, Check, Undo2, Pencil, X, AlertTriangle } from "lucide-react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { CommissionPaymentDialog } from "@/components/commissions/CommissionPaymentDialog";
import { type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

type CommissionSale = Doc<"sales"> & {
  vehicleSummary: string;
  customerName: string;
  salespersonName: string;
  paidByName: string | null;
  missingPurchaseCost?: boolean;
  needsRecalculation?: boolean;
};

function formatCurrency(amount: number) {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function CommissionsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const orgSettings = useOrgSettings();
  const isManualMode = orgSettings?.commissionMode === "MANUAL";

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const canManage = myMembership?.permissions.includes("manage:commissions") ?? false;

  const members = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId, paginationOpts: { numItems: 100, cursor: null } } : "skip");

  const [filterSalesperson, setFilterSalesperson] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "paid" | "unpaid">("all");

  const commissions = useQuery(
    api.sales.listCommissions,
    activeOrgId ? {
      orgId: activeOrgId,
      salespersonId: filterSalesperson !== "all" ? (filterSalesperson as Id<"users">) : undefined,
      paidStatus: filterStatus !== "all" ? filterStatus : undefined,
    } : "skip"
  );

  const {
    search,
    setSearch,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedCommissions,
  } = useTableControls({
    data: commissions,
    searchFields: (c: CommissionSale) => [c.salespersonName, c.vehicleSummary, c.customerName],
    sortAccessors: {
      saleDate: (c: CommissionSale) => c.saleDate,
      salePrice: (c: CommissionSale) => c.salePrice,
      commissionAmount: (c: CommissionSale) => c.commissionAmount ?? 0,
      status: (c: CommissionSale) => (c.commissionPaidAt ? 1 : 0),
    },
  });

  const markPaid = useMutation(api.sales.markCommissionPaid);
  const setCommissionAmount = useMutation(api.sales.setCommissionAmount);
  const recalculateCommission = useMutation(api.sales.recalculateCommission);

  const [editingId, setEditingId] = useState<Id<"sales"> | null>(null);
  const [editingAmount, setEditingAmount] = useState("");
  const [commissionToPay, setCommissionToPay] = useState<CommissionSale | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [isPayingCommission, setIsPayingCommission] = useState(false);

  const filtered = sortedCommissions ?? [];

  const totalEarned = filtered.reduce((s: number, c: CommissionSale) => s + (c.commissionAmount ?? 0), 0);
  const totalPaid = filtered.filter((c: CommissionSale) => c.commissionPaidAt).reduce((s: number, c: CommissionSale) => s + (c.commissionAmount ?? 0), 0);
  const totalPending = totalEarned - totalPaid;

  // Group by salesperson for summary
  const bySalesperson = useMemo(() => {
    const map = new Map<string, { name: string; earned: number; paid: number; count: number }>();
    for (const c of filtered) {
      const existing = map.get(c.salespersonId) ?? { name: c.salespersonName, earned: 0, paid: 0, count: 0 };
      existing.earned += c.commissionAmount ?? 0;
      if (c.commissionPaidAt) existing.paid += c.commissionAmount ?? 0;
      existing.count++;
      map.set(c.salespersonId, existing);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
  }, [filtered]);

  async function handleConfirmMarkPaid() {
    if (!activeOrgId || !commissionToPay) return;
    setIsPayingCommission(true);
    try {
      await markPaid({ orgId: activeOrgId, saleId: commissionToPay._id, paymentMethod });
      toast.success(t("CommissionPaidSuccess" as any));
      setCommissionToPay(null);
      setPaymentMethod("CASH");
    } catch {
      toast.error(t("CommissionPaymentFailed" as any));
    } finally {
      setIsPayingCommission(false);
    }
  }

  async function handleRecalculate(saleId: Id<"sales">) {
    if (!activeOrgId) return;
    try {
      await recalculateCommission({ orgId: activeOrgId, saleId });
      toast.success(t("CommissionRecalculated" as any));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveCommission(saleId: Id<"sales">) {
    if (!activeOrgId) return;
    const amount = parseFloat(editingAmount);
    if (isNaN(amount) || amount < 0) return;
    try {
      await setCommissionAmount({ orgId: activeOrgId, saleId, commissionAmount: amount });
      toast.success(t("CommissionUpdated" as any));
      setEditingId(null);
      setEditingAmount("");
    } catch {
      toast.error(t("CommissionUpdateFailed" as any));
    }
  }

  function startEditing(saleId: Id<"sales">, current: number) {
    setEditingId(saleId);
    setEditingAmount(String(current));
  }

  return (
    <RoleGuard permissions={["view:commissions"]}>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <TrendingUp className="h-6 w-6" /> {t("Commissions" as any)}
        </h1>

        {/* Summary Cards */}
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("TotalEarned" as any)}</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatCurrency(totalEarned)}</p>
              <p className="text-xs text-muted-foreground mt-1">{filtered.length} {t("DealsWithCommission" as any)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("PaidOut" as any)}</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(totalPaid)}</p>
              <p className="text-xs text-muted-foreground mt-1">{filtered.filter((c: CommissionSale) => c.commissionPaidAt).length} {t("Paid" as any)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("PendingPayout" as any)}</CardTitle>
              <Clock className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-orange-600">{formatCurrency(totalPending)}</p>
              <p className="text-xs text-muted-foreground mt-1">{filtered.filter((c: CommissionSale) => !c.commissionPaidAt).length} {t("Unpaid" as any)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Salesperson summary strip */}
        {canManage && bySalesperson.length > 1 && (
          <div className="flex flex-wrap gap-3">
            {bySalesperson.map(sp => (
              <div key={sp.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <span className="font-medium">{sp.name}</span>
                <span className="text-muted-foreground">·</span>
                <span>{sp.count} deals</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-green-600 font-medium">{formatCurrency(sp.paid)} paid</span>
                {sp.earned - sp.paid > 0 && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-orange-600">{formatCurrency(sp.earned - sp.paid)} pending</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Input
              placeholder={t("Search" as any)}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="ps-3"
            />
          </div>
          {canManage && (
            <SearchableSelect
              value={filterSalesperson}
              onValueChange={setFilterSalesperson}
              className="w-[180px]"
              placeholder={t("AllSalespeople" as any)}
              options={[
                { value: "all", label: t("AllSalespeople" as any) },
                ...(members?.page.map((m: { userId: string; userName: string }) => ({ value: m.userId, label: m.userName })) ?? []),
              ]}
            />
          )}
          <Select value={filterStatus} onValueChange={v => setFilterStatus(v as any)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder={t("AllStatus" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("AllStatus" as any)}</SelectItem>
              <SelectItem value="unpaid">{t("Unpaid" as any)}</SelectItem>
              <SelectItem value="paid">{t("Paid" as any)}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Commission table */}
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Salesperson" as any)}</TableHead>
                <TableHead>{t("Vehicle" as any)}</TableHead>
                <TableHead>{t("Customer" as any)}</TableHead>
                <SortableColumnHeader label={t("SaleDate" as any)} sortKey="saleDate" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableColumnHeader className="text-end" label={t("SalePrice" as any)} sortKey="salePrice" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableColumnHeader className="text-end" label={t("CommissionAmount" as any)} sortKey="commissionAmount" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableColumnHeader label={t("Status" as any)} sortKey="status" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                {canManage && <TableHead className="text-end">{t("Actions" as any)}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!commissions ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 8 : 7} className="text-center py-8 text-muted-foreground">
                    {t("Loading" as any)}
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 8 : 7} className="text-center py-8 text-muted-foreground">
                    {t("NoCommissionRecords" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((c: CommissionSale) => (
                  <TableRow
                    key={c._id}
                    className={
                      c.missingPurchaseCost
                        ? "bg-amber-50 dark:bg-amber-950/20"
                        : c.needsRecalculation
                          ? "bg-blue-50 dark:bg-blue-950/20"
                          : undefined
                    }
                  >
                    <TableCell className="font-medium">{c.salespersonName}</TableCell>
                    <TableCell>{c.vehicleSummary}</TableCell>
                    <TableCell>{c.customerName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(c.saleDate).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(c.salePrice)}</TableCell>
                    <TableCell className="text-end tabular-nums font-semibold">
                      {c.missingPurchaseCost ? (
                        <span
                          className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                          title={t("MissingPurchaseCostHint" as any)}
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {t("MissingPurchaseCost" as any)}
                        </span>
                      ) : isManualMode && canManage && editingId === c._id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={editingAmount}
                            onChange={(e) => setEditingAmount(e.target.value)}
                            className="h-7 w-24 text-sm text-end"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveCommission(c._id);
                              if (e.key === "Escape") { setEditingId(null); setEditingAmount(""); }
                            }}
                          />
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleSaveCommission(c._id)}>
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditingId(null); setEditingAmount(""); }}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          {formatCurrency(c.commissionAmount ?? 0)}
                          {isManualMode && canManage && !c.commissionPaidAt && (
                            <button
                              onClick={() => startEditing(c._id, c.commissionAmount ?? 0)}
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title={t("EditCommission" as any)}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.commissionPaidAt ? (
                        <Badge variant="outline" className="text-green-600 border-green-600 text-xs">
                          <CheckCircle2 className="h-3 w-3 me-1" />
                          {t("Paid" as any)} {new Date(c.commissionPaidAt).toLocaleDateString()}
                          <span className="ms-1 text-muted-foreground">
                            {t(`PaymentMethod_${c.commissionPaymentMethod ?? "CASH"}` as any)}
                          </span>
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs">
                          <Clock className="h-3 w-3 me-1" />
                          {t("Unpaid" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-end">
                        {c.commissionPaidAt ? (
                          // Paid commissions are locked server-side (reversing a
                          // paid commission needs an accounting reversal, not a
                          // flag flip) — so no Revert action is offered here.
                          null
                        ) : c.missingPurchaseCost ? null : c.needsRecalculation ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-blue-600 border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                            title={t("RecalculateCommissionHint" as any)}
                            onClick={() => handleRecalculate(c._id)}
                          >
                            <Undo2 className="h-3.5 w-3.5 me-1" /> {t("RecalculateCommission" as any)}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-green-600 border-green-600 hover:bg-green-50"
                            onClick={() => { setCommissionToPay(c); setPaymentMethod("CASH"); }}
                          >
                            <Check className="h-3.5 w-3.5 me-1" /> {t("MarkPaid" as any)}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <CommissionPaymentDialog
          commission={commissionToPay ? {
            salespersonName: commissionToPay.salespersonName,
            vehicleSummary: commissionToPay.vehicleSummary,
            amountLabel: formatCurrency(commissionToPay.commissionAmount ?? 0),
          } : null}
          open={commissionToPay !== null}
          isPaying={isPayingCommission}
          paymentMethod={paymentMethod}
          t={t as any}
          onPaymentMethodChange={setPaymentMethod}
          onConfirm={handleConfirmMarkPaid}
          onOpenChange={(open) => {
            if (!open) {
              setCommissionToPay(null);
              setPaymentMethod("CASH");
            }
          }}
        />
      </div>
    </RoleGuard>
  );
}
