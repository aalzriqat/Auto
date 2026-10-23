"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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
import { DealCommissionLinesDialog } from "@/components/commissions/DealCommissionLinesDialog";
import { scaleForCurrency } from "@/convex/utils/money";
import { type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { useTableControls } from "@/hooks/useTableControls";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getErrorMessage, getLocalizedErrorMessage, isConvexError, GENERIC_ERROR_MESSAGE } from "@/lib/errors";
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

/** Minor units of a known currency, with that currency's own decimals (fils are not rounded away). */
function formatMinor(minor: number, currency: string) {
  const scale = scaleForCurrency(currency);
  return (minor / Math.pow(10, scale)).toLocaleString("en-US", { minimumFractionDigits: scale, maximumFractionDigits: scale });
}

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
function errorToast(error: unknown, fallback: string, t?: (key: string) => string): string {
  const message = t ? getLocalizedErrorMessage(error, t) : getErrorMessage(error);
  return message === GENERIC_ERROR_MESSAGE ? fallback : message;
}

export default function CommissionsPage() {
  return <RoleGuard permissions={["view:commissions"]}><CommissionsContent /></RoleGuard>;
}

function CommissionsContent() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const queue = useCommissionReviewQueue(activeOrgId);
  const { isManualMode, canManage, members, commissions, filtered, isAutoLoading,
    hasActiveFilter, sortKey, sortDir, toggleSort } = queue;
  const [linesSaleId, setLinesSaleId] = useState<Id<"sales"> | null>(null);

  const markPaid = useMutation(api.sales.markCommissionPaid);
  const commandId = useCommandIdentity();
  const setCommissionAmount = useMutation(api.sales.setCommissionAmount);
  const recalculateCommission = useMutation(api.sales.recalculateCommission);

  const [editingId, setEditingId] = useState<Id<"sales"> | null>(null);
  const [editingAmount, setEditingAmount] = useState("");
  const [commissionToPay, setCommissionToPay] = useState<CommissionSale | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [bankAccountId, setBankAccountId] = useState("");
  const [uncertainPayment, setUncertainPayment] = useState<{
    saleId: string; paymentMethod: PaymentMethod; bankAccountId: string; bankName: string | null;
  } | null>(null);
  const [isPayingCommission, setIsPayingCommission] = useState(false);
  const commissionBankOptions = useQuery(
    api.sales.listCommissionBankOptions,
    activeOrgId && commissionToPay && paymentMethod !== "CASH" ? { orgId: activeOrgId } : "skip"
  );
  const commissionRetry = commissionToPay && uncertainPayment?.saleId === commissionToPay._id
    ? uncertainPayment : null;

  async function handleConfirmMarkPaid() {
    if (!activeOrgId || !commissionToPay) return;
    const retry = commissionRetry;
    if (retry && (retry.paymentMethod !== paymentMethod || retry.bankAccountId !== bankAccountId)) {
      toast.error(t("CommissionRetrySameDetails" as any));
      return;
    }
    if (paymentMethod !== "CASH" && !retry &&
      (!bankAccountId || commissionBankOptions?.truncated ||
        !commissionBankOptions?.banks.some((bank) => bank._id === bankAccountId))) {
      toast.error(t("DirectPaymentBankRequired" as any));
      return;
    }
    setIsPayingCommission(true);
    try {
      // Paying a commission moves money. The identity is stable per sale for as
      // long as this payment is being attempted, and retired once it lands.
      const intent = `mark-commission-paid:${commissionToPay._id}`;
      await markPaid({
        orgId: activeOrgId,
        saleId: commissionToPay._id,
        paymentMethod,
        bankAccountId: paymentMethod === "CASH" ? undefined : bankAccountId as Id<"bankAccounts">,
        idempotencyKey: commandId.for(intent),
      });
      commandId.retire(intent);
      setUncertainPayment(null);
      toast.success(t("CommissionPaidSuccess" as any));
      setCommissionToPay(null);
      setPaymentMethod("CASH");
      setBankAccountId("");
    } catch (e) {
      if (isConvexError(e)) {
        commandId.retire(`mark-commission-paid:${commissionToPay._id}`);
        setUncertainPayment(null);
      } else {
        setUncertainPayment({
          saleId: commissionToPay._id, paymentMethod, bankAccountId,
          bankName: commissionBankOptions?.banks.find((bank) => bank._id === bankAccountId)?.name ?? null,
        });
      }
      toast.error(getLocalizedErrorMessage(e, t));
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
      toast.error(errorToast(e, t("CommissionUpdateFailed" as any), t));
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
      // The server distinguishes "paid amounts cannot be changed", "cancelled
      // sale", "hasn't posted to the ledger yet" and "no longer matches what
      // the ledger recognized" — each tells the manager something different
      // about what to do next. Collapsing them into one generic string sends
      // them to support instead.
      toast.error(errorToast(e, t("CommissionUpdateFailed" as any)));
    }
  }

  // An undecided commission opens with an empty field, not "0" — pre-filling a
  // zero invites confirming a decision nobody made.
  function startEditing(saleId: Id<"sales">, current: number | undefined) {
    setEditingId(saleId);
    setEditingAmount(current == null ? "" : String(current));
  }

  function startPayment(c: CommissionSale) {
    const retry = uncertainPayment?.saleId === c._id ? uncertainPayment : null;
    setCommissionToPay(c);
    setPaymentMethod(retry?.paymentMethod ?? "CASH");
    setBankAccountId(retry?.bankAccountId ?? "");
  }

  return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <TrendingUp className="h-6 w-6" /> {t("Commissions" as any)}
        </h1>

        <CommissionQueueOverview queue={queue} />

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
                    {isAutoLoading
                      ? t("Loading" as any)
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
                    <CommissionAmountCell c={c} canManage={canManage} editingId={editingId} editingAmount={editingAmount} onAmountChange={setEditingAmount} onSave={handleSaveCommission} onStartEditing={startEditing} onCancel={() => { setEditingId(null); setEditingAmount(""); }} />
                    <CommissionStatusCell c={c} />
                    {canManage && (
                      <TableCell className="text-end">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                        {c.commissionStatus !== "VOID" && (
                          <Button variant="ghost" size="sm" onClick={() => setLinesSaleId(c._id)}>
                            <ClipboardList className="h-3.5 w-3.5 me-1" /> {t("DealCommissionLinesAction" as any)}
                          </Button>
                        )}
                        <CommissionPaymentAction c={c} editingId={editingId} onRecalculate={handleRecalculate} onStartEditing={startEditing} onMarkPaid={startPayment} />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {activeOrgId && canManage && (
          <DealCommissionLinesDialog
            orgId={activeOrgId}
            saleId={linesSaleId}
            members={(members?.page ?? []).map((m: { userId: Id<"users">; userName: string }) => ({ userId: m.userId, name: m.userName }))}
            money={formatMinor}
            t={t as any}
            onOpenChange={(open) => { if (!open) setLinesSaleId(null); }}
          />
        )}
        <CommissionPaymentDialog
          commission={commissionToPay ? {
            salespersonName: commissionToPay.salespersonName,
            vehicleSummary: commissionToPay.vehicleSummary,
            amountLabel: formatCurrency(commissionToPay.commissionAmount ?? 0),
          } : null}
          open={commissionToPay !== null}
          isPaying={isPayingCommission}
          paymentMethod={paymentMethod}
          bankAccountId={bankAccountId}
          bankOptions={commissionBankOptions}
          uncertain={commissionRetry !== null}
          retryBankName={commissionRetry?.bankName ?? null}
          t={t as any}
          onPaymentMethodChange={(method) => { setPaymentMethod(method); setBankAccountId(""); }}
          onBankChange={setBankAccountId}
          onConfirm={handleConfirmMarkPaid}
          onOpenChange={(open) => {
            if (!open) {
              setCommissionToPay(null);
              setPaymentMethod("CASH");
              setBankAccountId("");
            }
          }}
        />
      </div>
  );
}

interface CommissionAmountCellProps {
  c: CommissionSale;
  canManage: boolean;
  editingId: Id<"sales"> | null;
  editingAmount: string;
  onAmountChange: (value: string) => void;
  onCancel: () => void;
  onSave: (saleId: Id<"sales">) => Promise<void>;
  onStartEditing: (saleId: Id<"sales">, current: number | undefined) => void;
}

function CommissionAmountCell({
  c,
  canManage,
  editingId,
  editingAmount,
  onAmountChange,
  onCancel,
  onSave,
  onStartEditing,
}: Readonly<CommissionAmountCellProps>) {
  const { t } = useLanguage();
  return (
    <TableCell className="text-end tabular-nums font-semibold">
      {c.missingPurchaseCost ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
          title={t("MissingPurchaseCostHint")}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("MissingPurchaseCost")}
        </span>
      ) : c.canSetAmount && canManage && editingId === c._id ? (
        <div className="flex items-center justify-end gap-1">
          <Input
            type="number"
            min="0"
            step="1"
            value={editingAmount}
            onChange={(e) => onAmountChange(e.target.value)}
            className="h-7 w-24 text-sm text-end"
            aria-label={t("CommissionAmount")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void onSave(c._id);
              if (e.key === "Escape") {
                onCancel();
              }
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => onSave(c._id)}
            aria-label={t("Save")}
          >
            <Check className="h-3.5 w-3.5 text-green-600" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => {
              onCancel();
            }}
            aria-label={t("Cancel")}
          >
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
              onClick={() => onStartEditing(c._id, c.commissionAmount)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={t("EditCommission")}
              aria-label={t("EditCommission")}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </TableCell>
  );
}

function CommissionStatusCell({ c }: Readonly<{ c: CommissionSale }>) {
  return <TableCell><CommissionStatusBadge c={c} /></TableCell>;
}

function CommissionStatusBadge({ c }: Readonly<{ c: CommissionSale }>) {
  const { t } = useLanguage();
  if (c.commissionStatus === "PAID" && c.commissionPaidAt) return ((
        <Badge
          variant="outline"
          className="text-green-600 border-green-600 text-xs whitespace-nowrap"
        >
          <CheckCircle2 className="h-3 w-3 me-1" />
          {t("Paid")} {new Date(c.commissionPaidAt).toLocaleDateString()}
          <span className="ms-1 text-muted-foreground">
            {t(`PaymentMethod_${c.commissionPaymentMethod ?? "CASH"}`)}
          </span>
        </Badge>
      ));
  if (c.commissionStatus === "NOT_SET") return ((
        <Badge
          variant="outline"
          className="text-muted-foreground text-xs whitespace-nowrap"
          title={t("CommissionNotSetHint")}
        >
          <CircleDashed className="h-3 w-3 me-1" />
          {t("CommissionNotSet")}
        </Badge>
      ));
  if (c.commissionStatus === "NO_COMMISSION") return ((
        <Badge
          variant="outline"
          className="text-muted-foreground text-xs whitespace-nowrap"
          title={t("NoCommissionOwedHint")}
        >
          <MinusCircle className="h-3 w-3 me-1" />
          {t("NoCommissionOwed")}
        </Badge>
      ));
  if (c.commissionStatus === "PENDING_SALE") return ((
        // Not reachable from the current listing rules, but the
        // default arm below is the orange "money owed" badge —
        // the worst place for an unhandled status to land.
        <Badge
          variant="outline"
          className="text-muted-foreground text-xs whitespace-nowrap"
          title={t("CommissionPendingSaleHint")}
        >
          <Clock className="h-3 w-3 me-1" />
          {t("CommissionPendingSale")}
        </Badge>
      ));
  if (c.commissionStatus === "VOID") return ((
        <Badge
          variant="outline"
          className="text-muted-foreground text-xs whitespace-nowrap line-through decoration-1"
          title={t("CommissionVoidHint")}
        >
          <Ban className="h-3 w-3 me-1" />
          {t("CommissionVoid")}
        </Badge>
      ));
  return ((
        <Badge
          variant="outline"
          className="text-orange-600 border-orange-300 text-xs whitespace-nowrap"
        >
          <Clock className="h-3 w-3 me-1" />
          {t("Unpaid")}
        </Badge>
      ));
}

interface CommissionPaymentActionProps {
  c: CommissionSale;
  editingId: Id<"sales"> | null;
  onRecalculate: (saleId: Id<"sales">) => Promise<void>;
  onStartEditing: (saleId: Id<"sales">, current: number | undefined) => void;
  onMarkPaid: (sale: CommissionSale) => void;
}

function CommissionPaymentAction({
  c,
  editingId,
  onRecalculate,
  onStartEditing,
  onMarkPaid,
}: Readonly<CommissionPaymentActionProps>) {
  const { t } = useLanguage();
  // Paid, cancelled and cost-incomplete rows have no settlement action.
  // The mutation remains the authority for all write decisions.
  if (c.commissionPaidAt || c.commissionStatus === "VOID" || c.missingPurchaseCost) return null;
  if (c.needsRecalculation) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-blue-600 border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30"
        title={t("RecalculateCommissionHint")}
        onClick={() => onRecalculate(c._id)}
      >
        <Undo2 className="h-3.5 w-3.5 me-1" /> {t("RecalculateCommission")}
      </Button>
    );
  }
  if ((c.commissionAmount ?? 0) <= 0) {
    if (!c.canSetAmount || editingId === c._id) return null;
    return (
      <Button variant="outline" size="sm" onClick={() => onStartEditing(c._id, c.commissionAmount)}>
        <Pencil className="h-3.5 w-3.5 me-1" /> {t("SetCommission")}
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="text-green-600 border-green-600 hover:bg-green-50"
      onClick={() => onMarkPaid(c)}
    >
      <Check className="h-3.5 w-3.5 me-1" /> {t("MarkPaid")}
    </Button>
  );
}

/** Read-side queue state and loaded-row summaries; only mounted beneath RoleGuard. */
function useCommissionReviewQueue(activeOrgId: Id<"organizations"> | null) {
  // SCRUM-778: the mode in force, resolved on the server (an unset mode is
  // AUTO_MEMBER) and readable by commission reviewers who cannot view settings.
  // `undefined` is loading and `null` is no access — no queue banner for either.
  // A null read is deliberately treated as "not MANUAL": a caller who cannot read the mode
  // must not be shown a manual work queue that may not match the org's real mode.
  const commissionMode = useQuery(api.orgSettings.getCommissionMode, activeOrgId ? { orgId: activeOrgId } : "skip");
  const isManualMode = commissionMode === "MANUAL";

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

  return { isManualMode, canManage, members, filterSalesperson, setFilterSalesperson, filterStatus, setFilterStatus,
    pageStatus, loadMore, commissions, hasMore, search, setSearch, sortKey, sortDir, toggleSort, isAutoLoading,
    filtered, totalEarned, totalPaid, totalPending, decidedCount, paidCount, unpaidCount, notSetCount,
    hasActiveFilter, queueCountIsComplete, bySalesperson };
}

/** Summary, filters and pagination notices all describe the same loaded queue. */
function CommissionQueueOverview({ queue }: Readonly<{ queue: ReturnType<typeof useCommissionReviewQueue> }>) {
  const { t } = useLanguage();
  const { totalEarned, totalPaid, totalPending, decidedCount, paidCount, unpaidCount, canManage, isManualMode,
    filterStatus, setFilterStatus, queueCountIsComplete, notSetCount, bySalesperson, search, setSearch,
    filterSalesperson, setFilterSalesperson, members, hasMore, isAutoLoading, pageStatus, loadMore } = queue;
  return <>
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
            <p>{t("CommissionListTruncated" as any)}</p>
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

  </>;
}
