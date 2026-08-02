"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Clock, Plus, Trash2, Wallet } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fromMinorUnits, scaleForCurrency, toMinorUnits } from "@/convex/utils/money";
import { errorMessage } from "../AccountingTabShared";
import { accountDisplayName } from "../reports/FinancialReportShared";

/**
 * Opening-balance entry for the accounting Setup tab.
 *
 * Lives in Setup rather than as an eleventh top-level tab because an opening
 * balance is a once-per-org action — the backend refuses a second one — so it
 * belongs with the other things you do when standing a dealership up.
 *
 * Whether the current user may post without a second approver is decided by
 * `accountingCutover.openingBalanceStatus` on the server, not re-derived here.
 * The client's own ownership heuristic (`roleName === "OWNER"`) and the
 * server's (`isSystemOwnerRole`) can disagree, and the disagreement would show
 * up as a button that fails on click.
 */

type DraftLine = {
  /** Stable across reorders and removals, unlike an array index. */
  id: string;
  accountId: string;
  debit: string;
  credit: string;
};

let lineSeq = 0;
function emptyLine(): DraftLine {
  lineSeq += 1;
  return { id: `line-${lineSeq}`, accountId: "", debit: "", credit: "" };
}

/** `YYYY-MM-DD` for a date input, from a timestamp. */
function toDateInputValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A date input's `YYYY-MM-DD` as UTC midnight — this repo's convention that a
 * calendar date IS its UTC midnight (see lib/dateInput.ts). Parsing with
 * `new Date(value)` would land on the browser's local midnight and shift the
 * accounting date across a period boundary for anyone west of UTC.
 *
 * Returns null on an empty or malformed value. A date input can be cleared,
 * and `Date.UTC(NaN, …)` is NaN, which would sail through as an `asOfDate` and
 * fail deep in period lookup with something unrelated to the real cause.
 */
function dateInputToUtcMs(value: string): number | null {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  return Date.UTC(y, m - 1, d);
}

export function OpeningBalanceCard() {
  const { t, locale } = useLanguage();
  const { activeOrgId } = useOrg();

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [asOfDate, setAsOfDate] = useState(() => toDateInputValue(Date.now()));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(() => [emptyLine(), emptyLine()]);

  const status = useQuery(
    api.accountingCutover.openingBalanceStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const accounts = useQuery(
    api.chartOfAccounts.list,
    activeOrgId ? { orgId: activeOrgId, activeOnly: true } : "skip"
  );

  const postDirect = useMutation(api.accountingCutover.postOpeningBalanceDirect);
  const draftForApproval = useMutation(api.accountingCutover.draftOpeningBalance);

  // The org's own currency, from the server. The minor-unit scale is 3 for
  // JOD/KWD/BHD/OMR and 2 for everything else, so a hardcoded factor posts
  // amounts off by a factor of ten on any org that is not on a 3-decimal
  // currency.
  const currency = status?.currency ?? "JOD";

  // Summed in minor units, so the balance check matches exactly what the
  // server validates rather than accumulating float error across lines.
  const totals = useMemo(() => {
    let debitMinor = 0;
    let creditMinor = 0;
    for (const line of lines) {
      debitMinor += toMinorUnits(Number(line.debit) || 0, currency);
      creditMinor += toMinorUnits(Number(line.credit) || 0, currency);
    }
    return { debitMinor, creditMinor, balanced: debitMinor === creditMinor && debitMinor > 0 };
  }, [lines, currency]);

  const filledLines = lines.filter(
    (line) => line.accountId && (Number(line.debit) > 0 || Number(line.credit) > 0)
  );
  const canSubmit =
    Boolean(activeOrgId) &&
    totals.balanced &&
    filledLines.length >= 2 &&
    dateInputToUtcMs(asOfDate) !== null &&
    !submitting;

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function resetForm() {
    setLines([emptyLine(), emptyLine()]);
    setMemo("");
    setAsOfDate(toDateInputValue(Date.now()));
  }

  async function submit() {
    if (!activeOrgId || !canSubmit) return;
    const asOfMs = dateInputToUtcMs(asOfDate);
    if (asOfMs === null) return;

    setSubmitting(true);
    try {
      const payload = {
        orgId: activeOrgId as Id<"organizations">,
        asOfDate: asOfMs,
        memo: memo.trim() || undefined,
        lines: filledLines.map((line) => ({
          accountId: line.accountId as Id<"chartOfAccounts">,
          debitMinor: toMinorUnits(Number(line.debit) || 0, currency),
          creditMinor: toMinorUnits(Number(line.credit) || 0, currency),
        })),
      };

      if (status?.canPostDirectly) {
        await postDirect(payload);
        toast.success(t("OpeningBalancePostedToast"));
      } else {
        await draftForApproval(payload);
        toast.success(t("OpeningBalanceSubmittedToast"));
      }
      setOpen(false);
      resetForm();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (!activeOrgId || status === undefined) return null;
  if (!status.canManageFinance) return null;

  const alreadyResolved = status.posted || status.pendingDraftId !== null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
          <div>
            <h3 className="text-sm font-semibold text-slate-900">{t("OpeningBalance")}</h3>
            <p className="text-sm text-slate-500">{t("OpeningBalanceDesc")}</p>

            {status.posted && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {t("OpeningBalancePosted")}
              </p>
            )}
            {!status.posted && status.pendingDraftId !== null && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-amber-700">
                <Clock className="h-4 w-4" />
                {t("OpeningBalancePending")}
              </p>
            )}
            {!alreadyResolved && (
              <p className="mt-2 text-sm text-slate-500">{t("OpeningBalanceNotSet")}</p>
            )}
          </div>
        </div>

        {!alreadyResolved && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">{t("OpeningBalanceSet")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>{t("OpeningBalance")}</DialogTitle>
                <DialogDescription>
                  {status.canPostDirectly
                    ? t("OpeningBalanceOwnerNote")
                    : t("OpeningBalanceApprovalNote")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-date">{t("OpeningBalanceAsOfDate")}</Label>
                    <Input
                      id="ob-date"
                      type="date"
                      value={asOfDate}
                      onChange={(e) => setAsOfDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-memo">{t("OpeningBalanceMemo")}</Label>
                    <Input
                      id="ob-memo"
                      value={memo}
                      placeholder={t("OpeningBalanceMemoPlaceholder")}
                      onChange={(e) => setMemo(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  {lines.map((line, index) => (
                    <div key={line.id} className="grid gap-2 sm:grid-cols-[1fr_130px_130px_40px]">
                      <Select
                        value={line.accountId}
                        onValueChange={(value) => updateLine(index, { accountId: value })}
                      >
                        <SelectTrigger aria-label={t("OpeningBalanceAccount")}>
                          <SelectValue placeholder={t("OpeningBalanceSelectAccount")} />
                        </SelectTrigger>
                        <SelectContent>
                          {(accounts ?? []).map((acc) => (
                            <SelectItem key={acc._id} value={acc._id}>
                              {/* Arabic name when the UI is Arabic — the chart
                                  carries nameAr for every seeded account, and
                                  the reports already localize the same way. */}
                              {acc.code} — {accountDisplayName(acc, locale)}
                              {" · "}
                              {/* Which side this account normally takes.
                                  Assets and expenses are debit-normal; the
                                  equity, liability and revenue accounts that
                                  balance them are credit-normal. Surfacing it
                                  here means nobody has to know the convention
                                  to fill the form in correctly. */}
                              <span className="text-xs text-slate-500">
                                {acc.normalBalance === "DEBIT"
                                  ? t("OpeningBalanceDebit")
                                  : t("OpeningBalanceCredit")}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        placeholder={t("OpeningBalanceDebit")}
                        aria-label={t("OpeningBalanceDebit")}
                        value={line.debit}
                        // A line is one side or the other; clearing the opposite
                        // field keeps a mistyped row from posting as both.
                        onChange={(e) => updateLine(index, { debit: e.target.value, credit: "" })}
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        placeholder={t("OpeningBalanceCredit")}
                        aria-label={t("OpeningBalanceCredit")}
                        value={line.credit}
                        onChange={(e) => updateLine(index, { credit: e.target.value, debit: "" })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("OpeningBalanceRemoveLine")}
                        disabled={lines.length <= 2}
                        onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLines((c) => [...c, emptyLine()])}
                  >
                    <Plus className="h-4 w-4" />
                    {t("OpeningBalanceAddLine")}
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
                  <span className="text-slate-600">{t("OpeningBalanceTotals")}</span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums text-slate-900">
                      {fromMinorUnits(totals.debitMinor, currency).toFixed(scaleForCurrency(currency))}{" / "}
                      {fromMinorUnits(totals.creditMinor, currency).toFixed(scaleForCurrency(currency))}
                    </span>
                    <span className={totals.balanced ? "text-emerald-700" : "text-amber-700"}>
                      {totals.balanced ? t("OpeningBalanceBalanced") : t("OpeningBalanceUnbalanced")}
                    </span>
                  </span>
                </div>
              </div>

              <DialogFooter>
                <Button onClick={() => void submit()} disabled={!canSubmit}>
                  {status.canPostDirectly
                    ? t("OpeningBalancePost")
                    : t("OpeningBalanceSubmitForApproval")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}
