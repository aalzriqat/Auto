"use client";

import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter, useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { errorMessage, AccountingEmptyRow, AccountingTableFrame, scaleForCurrency } from "../AccountingTabShared";
import { BankStatementUploadDialog } from "./BankStatementUploadDialog";
import { OpeningRefundReturnDialog } from "./OpeningRefundReturnDialog";
import { OpeningDepositRefundDialog } from "@/components/customers/OpeningDepositRefundDialog";
import { usePermissions } from "@/hooks/use-permissions";

function emptyStatementLabel<T extends "NoUnmatchedLines" | "NoMatchedLines">(rows: readonly unknown[] | undefined, emptyKey: T) {
  if (rows === undefined) return "Loading";
  if (rows.length === 0) return emptyKey;
  return null;
}

function SuggestedStatementMatch({ suggested, candidateCount }: Readonly<{
  suggested: { memo?: string; accountingDate: number } | undefined;
  candidateCount: number;
}>) {
  const { t } = useLanguage();
  if (suggested) return <span className="text-sm text-muted-foreground">
    {suggested.memo || t("Untitled")} —{" "}{new Date(suggested.accountingDate).toLocaleDateString()}
  </span>;
  if (candidateCount > 0) return <span className="text-sm text-amber-600 dark:text-amber-400">{t("MultipleCandidates")}</span>;
  return <span className="text-sm text-muted-foreground/60">{t("NoCandidates")}</span>;
}

export function ReconciliationPanel({
  orgId,
  bankAccountId,
  currency,
  canManageFinance,
}: Readonly<{
  orgId: Id<"organizations">;
  bankAccountId: Id<"bankAccounts">;
  currency: string;
  canManageFinance: boolean;
}>) {
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const formatBankCurrency = useCurrencyFormatterInCurrency();
  const { isOwner, hasPermission } = usePermissions();
  const canRecordBankReturn = canManageFinance && (isOwner || hasPermission("approve:requests"));
  const [returnLine, setReturnLine] = useState<{ id: Id<"bankStatementLines">; description: string; amountLabel: string } | null>(null);
  // A set of in-flight action keys, so overlapping confirm/ignore requests each
  // keep their own spinner — one completing (or another starting) can never
  // clear a different request's busy state.
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [ignoring, setIgnoring] = useState<{ id: Id<"bankStatementLines">; reason: string } | null>(null);
  const [viewMode, setViewMode] = useState<"unmatched" | "matched">("unmatched");
  const [archivedRefundLine, setArchivedRefundLine] = useState<Id<"bankStatementLines"> | null>(null);

  const startAction = (key: string) => setBusyActions((prev) => new Set(prev).add(key));
  const endAction = (key: string) =>
    setBusyActions((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const suggestions = useQuery(api.bankReconciliation.suggestMatches, { orgId, bankAccountId });
  const matchedLines = useQuery(
    api.bankReconciliation.listStatementLines,
    viewMode === "matched" ? { orgId, bankAccountId, status: "MATCHED" } : "skip"
  );
  const archivedRefund = useQuery(api.openingRefundReturns.archivedRefundRecovery,
    canRecordBankReturn && archivedRefundLine ? { orgId, statementLineId: archivedRefundLine } : "skip");
  const uploadLines = useMutation(api.bankReconciliation.uploadStatementLines);
  const confirmMatch = useMutation(api.bankReconciliation.confirmMatch);
  const ignoreLine = useMutation(api.bankReconciliation.ignoreLine);
  const unmatch = useMutation(api.bankReconciliation.unmatch);

  const factor = Math.pow(10, scaleForCurrency(currency));
  const unmatchedEmptyKey = emptyStatementLabel(suggestions, "NoUnmatchedLines");
  const matchedEmptyKey = emptyStatementLabel(matchedLines, "NoMatchedLines");

  async function handleUnmatch(statementLineId: Id<"bankStatementLines">) {
    if (!window.confirm(t("ConfirmUnmatch"))) return;
    const key = `unmatch_${statementLineId}`;
    startAction(key);
    try {
      await unmatch({ orgId, statementLineId });
      toast.success(t("UnmatchedSuccess"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endAction(key);
    }
  }

  async function handleImport(rows: { statementDate: number; description: string; amountMinor: number }[]) {
    setImporting(true);
    try {
      const result = await uploadLines({ orgId, bankAccountId, rows });
      toast.success(t("StatementImported").replace("{count}", String(result.count)));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }

  async function handleConfirm(statementLineId: Id<"bankStatementLines">, journalLineId: Id<"journalLines">) {
    const key = `confirm_${statementLineId}`;
    startAction(key);
    try {
      await confirmMatch({ orgId, statementLineId, journalLineId });
      toast.success(t("MatchConfirmed"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endAction(key);
    }
  }

  async function handleIgnore() {
    if (!ignoring) return;
    if (!ignoring.reason.trim()) {
      toast.error(t("IgnoreLineReasonPlaceholder"));
      return;
    }
    // Capture the target id and use functional state updates keyed to it:
    // if the user dismisses this dialog and opens another line's while this
    // request is still in flight, completion here must not clear the newer
    // dialog's state or busy indicator.
    const targetId = ignoring.id;
    const key = `ignore_${targetId}`;
    startAction(key);
    try {
      await ignoreLine({ orgId, statementLineId: targetId, reason: ignoring.reason });
      toast.success(t("LineIgnored"));
      setIgnoring((cur) => (cur?.id === targetId ? null : cur));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endAction(key);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-foreground">{t("Reconciliation")}</h3>
          <div className="flex items-center rounded-lg border bg-muted/30 p-1">
            <Button
              size="sm"
              variant={viewMode === "unmatched" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setViewMode("unmatched")}
            >
              {t("UnmatchedLines")}
            </Button>
            <Button
              size="sm"
              variant={viewMode === "matched" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setViewMode("matched")}
            >
              {t("MatchedLines")}
            </Button>
          </div>
        </div>
        {canManageFinance && (
          <BankStatementUploadDialog t={t} currencyScaleFactor={factor} onImport={handleImport} importing={importing} />
        )}
      </div>

      <AccountingTableFrame>
        {viewMode === "unmatched" ? (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("Date")}</TableHead>
                <TableHead>{t("Description")}</TableHead>
                <TableHead className="text-right">{t("Amount")}</TableHead>
                <TableHead>{t("SuggestedMatch")}</TableHead>
                <TableHead className="text-right">{t("Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unmatchedEmptyKey ? (
                <AccountingEmptyRow colSpan={5} label={t(unmatchedEmptyKey)} />
              ) : (
                suggestions?.map((s) => {
                  const suggested = s.candidates.find((c) => c.journalLineId === s.suggestedJournalLineId);
                  const confirming = busyActions.has(`confirm_${s.statementLineId}`);
                  const ignoringThisLine = busyActions.has(`ignore_${s.statementLineId}`);
                  return (
                    <TableRow key={s.statementLineId}>
                      <TableCell className="text-muted-foreground">
                        {new Date(s.statementDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{s.description}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(s.amountMinor / factor)}
                      </TableCell>
                      <TableCell>
                        <SuggestedStatementMatch suggested={suggested} candidateCount={s.candidates.length} />
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {canRecordBankReturn && s.amountMinor > 0 && (
                          <Button type="button" size="sm" variant="outline" onClick={() => setReturnLine({
                            id: s.statementLineId, description: s.description, amountLabel: formatBankCurrency(s.amountMinor / factor, currency, scaleForCurrency(currency)),
                          })}>
                            {t("OpeningRefundRecordBankReturn")}
                          </Button>
                        )}
                        {canManageFinance && suggested && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={confirming}
                            onClick={() => void handleConfirm(s.statementLineId, suggested.journalLineId)}
                          >
                            {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            {t("ConfirmMatch")}
                          </Button>
                        )}
                        {canManageFinance && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                            disabled={ignoringThisLine}
                            onClick={() => setIgnoring({ id: s.statementLineId, reason: "" })}
                          >
                            {ignoringThisLine ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                            {t("IgnoreLine")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("Date")}</TableHead>
                <TableHead>{t("Description")}</TableHead>
                <TableHead className="text-right">{t("Amount")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead className="text-right">{t("Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matchedEmptyKey ? (
                <AccountingEmptyRow colSpan={5} label={t(matchedEmptyKey)} />
              ) : (
                matchedLines?.map((line) => {
                  const unmatching = busyActions.has(`unmatch_${line._id}`);
                  return (
                    <TableRow key={line._id}>
                      <TableCell className="text-muted-foreground">
                        {new Date(line.statementDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{line.description}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(line.amountMinor / factor)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                          {line.openingDepositRefundReturnEventId ? t("OpeningRefundBankReturnRecorded") : t("Matched")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canRecordBankReturn && line.openingDepositRefundReturnEventId && (
                          <Button size="sm" variant="ghost" onClick={() => setArchivedRefundLine(line._id)}>
                            {t("OpeningRefundArchivedRecovery")}
                          </Button>
                        )}
                        {canManageFinance && !line.openingDepositRefundReturnEventId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                            disabled={unmatching}
                            onClick={() => void handleUnmatch(line._id)}
                          >
                            {unmatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            {t("Unmatch")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </AccountingTableFrame>

      {returnLine && <OpeningRefundReturnDialog key={returnLine.id} orgId={orgId} line={returnLine} onClose={() => setReturnLine(null)} />}

      {canRecordBankReturn && archivedRefundLine && <ArchivedRefundRecovery
        statementLineId={archivedRefundLine} orgId={orgId} recovery={archivedRefund} onClose={() => setArchivedRefundLine(null)} />}

      <Dialog open={!!ignoring} onOpenChange={(open) => !open && setIgnoring(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("IgnoreLineReasonTitle")}</DialogTitle>
            <DialogDescription>{t("IgnoreLineReasonDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={ignoring?.reason ?? ""}
            onChange={(e) => setIgnoring((cur) => (cur ? { ...cur, reason: e.target.value } : cur))}
            placeholder={t("IgnoreLineReasonPlaceholder")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIgnoring(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleIgnore()}
              disabled={!!ignoring && busyActions.has(`ignore_${ignoring.id}`)}
            >
              {t("IgnoreLine")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function ArchivedRefundRecovery({ orgId, statementLineId, recovery, onClose }: Readonly<{
  orgId: Id<"organizations">;
  statementLineId: Id<"bankStatementLines">;
  recovery: FunctionReturnType<typeof api.openingRefundReturns.archivedRefundRecovery> | undefined;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const formatBankCurrency = useCurrencyFormatterInCurrency();
  if (recovery) {
    return <OpeningDepositRefundDialog key={statementLineId} orgId={orgId} depositId={recovery.depositId}
      reserved={recovery.reserved} currency={recovery.currency}
      amountLabel={formatBankCurrency(recovery.amountMinor / 10 ** scaleForCurrency(recovery.currency),
        recovery.currency, scaleForCurrency(recovery.currency))} onClose={onClose} />;
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("OpeningRefundArchivedRecovery")}</DialogTitle>
          <DialogDescription>{t(recovery === undefined ? "Loading" : "OpeningRefundArchivedUnavailable")}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
