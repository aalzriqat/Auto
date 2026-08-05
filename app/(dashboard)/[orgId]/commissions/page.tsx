"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
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
import { TrendingUp, CheckCircle2, Clock, DollarSign, Check, Undo2, Pencil, X, AlertTriangle, CircleDashed, MinusCircle, ClipboardList, Ban, UserMinus } from "lucide-react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { CommissionPaymentDialog } from "@/components/commissions/CommissionPaymentDialog";
import { type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { useTableControls } from "@/hooks/useTableControls";
import { getErrorMessage, GENERIC_ERROR_MESSAGE } from "@/lib/errors";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

type CommissionStatus = "NOT_SET" | "NO_COMMISSION" | "UNPAID" | "PAID" | "VOID" | "PENDING_SALE";

type CommissionSale = Doc<"sales"> & {
  vehicleSummary: string;
  customerName: string;
  salespersonName: string;
  paidByName: string | null;
  missingPurchaseCost?: boolean;
  needsRecalculation?: boolean;
  commissionStatus: CommissionStatus;
  canSetAmount: boolean;
  salespersonOffboarded: boolean;
};

type StatusFilter = "all" | "paid" | "unpaid" | "not_set";

/**
 * Rows fetched per page. The server reads this many sale DOCUMENTS and returns
 * only the ones that belong on this page, so a page can come back short — or
 * empty — while more remain. That is deliberate: it makes the read cost of one
 * request fixed instead of proportional to how long the dealership has traded.
 */
const PAGE_SIZE = 100;

/** Sorting the Status column: most in need of attention first. */
const STATUS_SORT_RANK: Record<CommissionStatus, number> = {
  NOT_SET: 0,
  UNPAID: 1,
  PENDING_SALE: 2,
  NO_COMMISSION: 3,
  PAID: 4,
  VOID: 5,
};

function formatCurrency(amount: number) {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * The server's own words when it has something specific to say ("this
 * commission is already recorded in the ledger", "a cancelled sale cannot be
 * given a commission"), and the caller's translated string when it does not.
 * `getErrorMessage` falls back to an English sentence for unexpected failures,
 * which would be the one untranslated line on an Arabic screen.
 */
function errorToast(error: unknown, fallback: string): string {
  const message = getErrorMessage(error);
  return message === GENERIC_ERROR_MESSAGE ? fallback : message;
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
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");

  const {
    results: loadedCommissions,
    status: pageStatus,
    loadMore,
  } = usePaginatedQuery(
    api.sales.listCommissionsPaginated,
    activeOrgId ? {
      orgId: activeOrgId,
      salespersonId: filterSalesperson !== "all" ? (filterSalesperson as Id<"users">) : undefined,
      paidStatus: filterStatus !== "all" ? filterStatus : undefined,
    } : "skip",
    { initialNumItems: PAGE_SIZE }
  );
  const isLoadingFirstPage = pageStatus === "LoadingFirstPage";
  const commissions = isLoadingFirstPage ? undefined : loadedCommissions;
  // Everything below the cards is summed over the rows that have been loaded.
  // While more remain, the totals are a running subtotal, not the year's
  // figures — a currency amount that quietly means something narrower than its
  // label is worse than one that admits it.
  const hasMore = pageStatus === "CanLoadMore" || pageStatus === "LoadingMore";

  const {
    search,
    setSearch,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedCommissions,
    autoLoadCapped,
    isAutoLoading,
  } = useTableControls({
    data: commissions,
    // The server pages by documents read, not by matches found, so a filtered
    // page routinely comes back short or empty while matching rows sit further
    // back. Without this the review queue would report "nothing to review" over
    // real work — the closed loop this whole page exists to open, in a new
    // disguise. Searching already exhausts for exactly the same reason.
    //
    // Both server-side filters count. Leaving the salesperson filter out left
    // the per-rep view unable to reach its own older rows: the hook was not
    // walking, and the page thought it was, so no control was offered either.
    pagination: {
      status: pageStatus,
      loadMore,
      pagesMayBeEmpty: true,
      exhaustWhen: filterStatus !== "all" || filterSalesperson !== "all",
      resetKey: `${filterStatus}|${filterSalesperson}`,
    },
    searchFields: (c: CommissionSale) => [c.salespersonName, c.vehicleSummary, c.customerName],
    sortAccessors: {
      saleDate: (c: CommissionSale) => c.saleDate,
      salePrice: (c: CommissionSale) => c.salePrice,
      commissionAmount: (c: CommissionSale) => c.commissionAmount ?? 0,
      // Five distinct states, ordered by how much they want attention — a
      // paid/unpaid boolean would sort a cancelled sale next to money owed.
      status: (c: CommissionSale) => STATUS_SORT_RANK[c.commissionStatus] ?? 99,
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

  // A cancelled sale keeps its commission amount as history, but the accrual
  // behind it was reversed — so it is not earned, not paid and not pending.
  // Counting it here is what makes this page disagree with the Commission
  // Payable reconciliation, which has always excluded it.
  const settleable = filtered.filter((c: CommissionSale) => c.commissionStatus !== "VOID");
  const totalEarned = settleable.reduce((s: number, c: CommissionSale) => s + (c.commissionAmount ?? 0), 0);
  const totalPaid = settleable
    .filter((c: CommissionSale) => c.commissionStatus === "PAID")
    .reduce((s: number, c: CommissionSale) => s + (c.commissionAmount ?? 0), 0);
  const totalPending = totalEarned - totalPaid;
  // Only rows that actually carry a decided commission belong in the "deals with
  // commission" count — undecided ones contribute nothing and would inflate it.
  const decidedCount = settleable.filter((c: CommissionSale) => (c.commissionAmount ?? 0) > 0).length;
  const paidCount = settleable.filter((c: CommissionSale) => c.commissionStatus === "PAID").length;
  const unpaidCount = settleable.filter((c: CommissionSale) => c.commissionStatus === "UNPAID").length;
  const notSetCount = filtered.filter((c: CommissionSale) => c.commissionStatus === "NOT_SET").length;
  const hasActiveFilter =
    filterStatus !== "all" || filterSalesperson !== "all" || search.trim().length > 0;
  // The count is only a fact once every page has been read; until then it is
  // "how many are on the pages we happen to have", which is not the same claim.
  const queueCountIsComplete = pageStatus === "Exhausted" && !hasActiveFilter;

  // Group by salesperson for summary
  const bySalesperson = useMemo(() => {
    const map = new Map<string, { name: string; earned: number; paid: number; count: number }>();
    for (const c of settleable) {
      const existing = map.get(c.salespersonId) ?? { name: c.salespersonName, earned: 0, paid: 0, count: 0 };
      existing.earned += c.commissionAmount ?? 0;
      if (c.commissionPaidAt) existing.paid += c.commissionAmount ?? 0;
      existing.count++;
      map.set(c.salespersonId, existing);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
    // `settleable` is derived from `filtered` on every render, so `filtered` is
    // the real dependency — keying on the derived array would rebuild the map
    // each render and defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  async function handleConfirmMarkPaid() {
    if (!activeOrgId || !commissionToPay) return;
    setIsPayingCommission(true);
    try {
      await markPaid({ orgId: activeOrgId, saleId: commissionToPay._id, paymentMethod });
      toast.success(t("CommissionPaidSuccess" as any));
      setCommissionToPay(null);
      setPaymentMethod("CASH");
    } catch (e) {
      toast.error(errorToast(e, t("CommissionPaymentFailed" as any)));
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
      // `e.message` here is Convex's transport wrapper — it carries the request
      // id, the stack and the convex/ source path straight to the screen.
      // getErrorMessage strips all of that.
      toast.error(errorToast(e, t("CommissionUpdateFailed" as any)));
    }
  }

  async function handleSaveCommission(saleId: Id<"sales">) {
    if (!activeOrgId) return;
    const amount = parseFloat(editingAmount);
    // Previously this returned silently, so an empty or negative entry looked
    // like a save that simply did nothing. Say why instead.
    if (isNaN(amount) || amount < 0) {
      toast.error(t("CommissionUpdateFailed" as any));
      return;
    }
    try {
      await setCommissionAmount({ orgId: activeOrgId, saleId, commissionAmount: amount });
      toast.success(t("CommissionUpdated" as any));
      setEditingId(null);
      setEditingAmount("");
    } catch (e) {
      // The server distinguishes "already recorded in the ledger", "paid
      // amounts cannot be changed" and "cancelled sale" — each tells the
      // manager something different about what to do next. Collapsing them
      // into one generic string sends them to support instead.
      toast.error(errorToast(e, t("CommissionUpdateFailed" as any)));
    }
  }

  // An undecided commission opens with an empty field, not "0" — pre-filling a
  // zero invites confirming a decision nobody made.
  function startEditing(saleId: Id<"sales">, current: number | undefined) {
    setEditingId(saleId);
    setEditingAmount(current == null ? "" : String(current));
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
              <p className="text-xs text-muted-foreground mt-1">{decidedCount} {t("DealsWithCommission" as any)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("PaidOut" as any)}</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(totalPaid)}</p>
              <p className="text-xs text-muted-foreground mt-1">{paidCount} {t("Paid" as any)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("PendingPayout" as any)}</CardTitle>
              <Clock className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-orange-600">{formatCurrency(totalPending)}</p>
              {/* Only rows that actually owe money. Counting every unsettled row
                  here would report undecided and deliberately-zero sales as
                  outstanding obligations that no payout will ever include. */}
              <p className="text-xs text-muted-foreground mt-1">{unpaidCount} {t("Unpaid" as any)}</p>
            </CardContent>
          </Card>
        </div>

        {/* The entry point into the manual workflow. Before this existed a sale
            with no commission was simply absent from the page, so the first
            amount could never be entered — the queue has to announce itself.

            It must not announce itself from the loaded rows alone: in the very
            state this page is designed for — a manager who has decided every
            recent sale — the count on page one is zero while older undecided
            sales remain, and a count-gated banner would disappear exactly when
            it is still needed. So in MANUAL mode the way in is always offered,
            and the number appears only once it is actually known. */}
        {canManage && isManualMode && filterStatus !== "not_set" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-s-4 border-s-primary bg-muted/40 px-4 py-3">
            <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm">
              {queueCountIsComplete ? (
                <>
                  <span className="font-semibold tabular-nums">{notSetCount}</span>{" "}
                  {t("CommissionsAwaitingReview" as any)}
                </>
              ) : (
                t("ReviewUndecidedCommissions" as any)
              )}
            </p>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-sm"
              onClick={() => setFilterStatus("not_set")}
            >
              {t("ReviewCommissions" as any)}
            </Button>
          </div>
        )}

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
          <Select value={filterStatus} onValueChange={v => setFilterStatus(v as StatusFilter)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder={t("AllStatus" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("AllStatus" as any)}</SelectItem>
              <SelectItem value="not_set">{t("CommissionNotSet" as any)}</SelectItem>
              <SelectItem value="unpaid">{t("Unpaid" as any)}</SelectItem>
              <SelectItem value="paid">{t("Paid" as any)}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* The totals above sum only what has been loaded. While older sales
            remain unfetched they are a running subtotal, not the whole ledger —
            an unqualified currency figure would be quietly wrong. */}
        {hasMore && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p>
              {autoLoadCapped
                ? t("CommissionListPartial" as any)
                : t("CommissionListTruncated" as any)}
            </p>
            {/* A manual button beside an automatic walk reads as a stalled UI,
                so it only appears once the automatic walk has stopped. */}
            {!isAutoLoading && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-sm text-amber-900 dark:text-amber-200"
                disabled={pageStatus !== "CanLoadMore"}
                onClick={() => loadMore(PAGE_SIZE)}
              >
                {pageStatus === "LoadingMore" ? t("Loading" as any) : t("LoadMore" as any)}
              </Button>
            )}
          </div>
        )}

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
                    {/* "Nothing matches" is a claim about the whole dataset, so
                        it must not be made while pages are still unread — that
                        would put a definitive denial directly above a banner
                        offering to load more. With a filter on, nothing is
                        wrong; the filter simply excluded everything. With no
                        filter in MANUAL mode there are no completed sales yet.
                        The original copy ("set a commission rate on team
                        members") only makes sense in an automatic mode —
                        MANUAL has no rates by definition. */}
                    {isAutoLoading || (hasMore && !autoLoadCapped)
                      ? t("Loading" as any)
                      : autoLoadCapped
                        ? t("NoMatchesInLoadedRows" as any)
                        : hasActiveFilter
                          ? t("NoCommissionRecordsForFilter" as any)
                          : isManualMode
                            ? t("NoCompletedSalesYet" as any)
                            : t("NoCommissionRecords" as any)}
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
                    <TableCell className="font-medium">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {c.salespersonName}
                        {/* Payroll skips offboarded members entirely, so an
                            amount entered here would sit "pending" forever with
                            no run ever picking it up and no error anywhere. */}
                        {c.salespersonOffboarded && c.commissionStatus === "UNPAID" && (
                          <Badge
                            variant="outline"
                            className="text-amber-700 border-amber-400 dark:text-amber-300 dark:border-amber-700 text-[10px] font-normal"
                            title={t("SalespersonOffboardedHint" as any)}
                          >
                            <UserMinus className="h-3 w-3 me-1" />
                            {t("SalespersonOffboarded" as any)}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
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
                      ) : c.canSetAmount && canManage && editingId === c._id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={editingAmount}
                            onChange={(e) => setEditingAmount(e.target.value)}
                            className="h-7 w-24 text-sm text-end"
                            aria-label={t("CommissionAmount" as any)}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveCommission(c._id);
                              if (e.key === "Escape") { setEditingId(null); setEditingAmount(""); }
                            }}
                          />
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleSaveCommission(c._id)} aria-label={t("Save" as any)}>
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditingId(null); setEditingAmount(""); }} aria-label={t("Cancel" as any)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          {/* An undecided commission is not zero. Showing "0"
                              here reads as a real decision that was never made. */}
                          {c.commissionAmount == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(c.commissionAmount)
                          )}
                          {/* An undecided row already carries a full "Set
                              commission" button in Actions; a pencil beside the
                              dash would be a second control for the same thing. */}
                          {c.canSetAmount && canManage && c.commissionAmount != null && (
                            <button
                              onClick={() => startEditing(c._id, c.commissionAmount)}
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title={t("EditCommission" as any)}
                              aria-label={t("EditCommission" as any)}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Orange is reserved for money actually owed. An
                          undecided or deliberately-zero row owes nothing yet, so
                          both stay neutral — otherwise the page reads as a
                          backlog of debt that does not exist. */}
                      {c.commissionStatus === "PAID" && c.commissionPaidAt ? (
                        <Badge variant="outline" className="text-green-600 border-green-600 text-xs whitespace-nowrap">
                          <CheckCircle2 className="h-3 w-3 me-1" />
                          {t("Paid" as any)} {new Date(c.commissionPaidAt).toLocaleDateString()}
                          <span className="ms-1 text-muted-foreground">
                            {t(`PaymentMethod_${c.commissionPaymentMethod ?? "CASH"}` as any)}
                          </span>
                        </Badge>
                      ) : c.commissionStatus === "NOT_SET" ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground text-xs whitespace-nowrap"
                          title={t("CommissionNotSetHint" as any)}
                        >
                          <CircleDashed className="h-3 w-3 me-1" />
                          {t("CommissionNotSet" as any)}
                        </Badge>
                      ) : c.commissionStatus === "NO_COMMISSION" ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground text-xs whitespace-nowrap"
                          title={t("NoCommissionOwedHint" as any)}
                        >
                          <MinusCircle className="h-3 w-3 me-1" />
                          {t("NoCommissionOwed" as any)}
                        </Badge>
                      ) : c.commissionStatus === "PENDING_SALE" ? (
                        // Not reachable from the current listing rules, but the
                        // default arm below is the orange "money owed" badge —
                        // the worst place for an unhandled status to land.
                        <Badge
                          variant="outline"
                          className="text-muted-foreground text-xs whitespace-nowrap"
                          title={t("CommissionPendingSaleHint" as any)}
                        >
                          <Clock className="h-3 w-3 me-1" />
                          {t("CommissionPendingSale" as any)}
                        </Badge>
                      ) : c.commissionStatus === "VOID" ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground text-xs whitespace-nowrap line-through decoration-1"
                          title={t("CommissionVoidHint" as any)}
                        >
                          <Ban className="h-3 w-3 me-1" />
                          {t("CommissionVoid" as any)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs whitespace-nowrap">
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
                        ) : c.commissionStatus === "VOID" ? (
                          // Nothing to settle on a cancelled sale — its accrual
                          // is already reversed and every mutation refuses it.
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
                        ) : (c.commissionAmount ?? 0) <= 0 ? (
                          // Nothing to pay yet. Offering "Mark paid" here would
                          // only produce a server rejection, so the action that
                          // is actually available is the one that's shown.
                          c.canSetAmount && editingId !== c._id ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => startEditing(c._id, c.commissionAmount)}
                            >
                              <Pencil className="h-3.5 w-3.5 me-1" /> {t("SetCommission" as any)}
                            </Button>
                          ) : null
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
