"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
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
  // A set of in-flight action keys, so overlapping confirm/ignore requests each
  // keep their own spinner — one completing (or another starting) can never
  // clear a different request's busy state.
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [ignoring, setIgnoring] = useState<{ id: Id<"bankStatementLines">; reason: string } | null>(null);
  const [viewMode, setViewMode] = useState<"unmatched" | "matched">("unmatched");

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
  const uploadLines = useMutation(api.bankReconciliation.uploadStatementLines);
  const confirmMatch = useMutation(api.bankReconciliation.confirmMatch);
  const ignoreLine = useMutation(api.bankReconciliation.ignoreLine);
  const unmatch = useMutation(api.bankReconciliation.unmatch);

  const factor = Math.pow(10, scaleForCurrency(currency));

  async function handleUnmatch(statementLineId: Id<"bankStatementLines">) {
    if (!window.confirm(t("ConfirmUnmatch" as any))) return;
    const key = `unmatch_${statementLineId}`;
    startAction(key);
    try {
      await unmatch({ orgId, statementLineId });
      toast.success(t("UnmatchedSuccess" as any));
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
      toast.success(t("StatementImported" as any).replace("{count}", String(result.count)));
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
      toast.success(t("MatchConfirmed" as any));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endAction(key);
    }
  }

  async function handleIgnore() {
    if (!ignoring) return;
    if (!ignoring.reason.trim()) {
      toast.error(t("IgnoreLineReasonPlaceholder" as any));
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
      toast.success(t("LineIgnored" as any));
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
          <h3 className="text-base font-semibold text-foreground">{t("Reconciliation" as any)}</h3>
          <div className="flex items-center rounded-lg border bg-muted/30 p-1">
            <Button
              size="sm"
              variant={viewMode === "unmatched" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setViewMode("unmatched")}
            >
              {t("UnmatchedLines" as any)}
            </Button>
            <Button
              size="sm"
              variant={viewMode === "matched" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setViewMode("matched")}
            >
              {t("MatchedLines" as any)}
            </Button>
          </div>
        </div>
        {canManageFinance && (
          <BankStatementUploadDialog t={t as any} currencyScaleFactor={factor} onImport={handleImport} importing={importing} />
        )}
      </div>

      <AccountingTableFrame>
        {viewMode === "unmatched" ? (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("Date" as any)}</TableHead>
                <TableHead>{t("Description" as any)}</TableHead>
                <TableHead className="text-right">{t("Amount" as any)}</TableHead>
                <TableHead>{t("SuggestedMatch" as any)}</TableHead>
                <TableHead className="text-right">{t("Actions" as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suggestions === undefined ? (
                <AccountingEmptyRow colSpan={5} label={t("Loading")} />
              ) : suggestions.length === 0 ? (
                <AccountingEmptyRow colSpan={5} label={t("NoUnmatchedLines" as any)} />
              ) : (
                suggestions.map((s) => {
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
                        {suggested ? (
                          <span className="text-sm text-muted-foreground">
                            {suggested.memo || t("Untitled" as any)} —{" "}
                            {new Date(suggested.accountingDate).toLocaleDateString()}
                          </span>
                        ) : s.candidates.length > 0 ? (
                          <span className="text-sm text-amber-600 dark:text-amber-400">{t("MultipleCandidates" as any)}</span>
                        ) : (
                          <span className="text-sm text-muted-foreground/60">{t("NoCandidates" as any)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {canManageFinance && suggested && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={confirming}
                            onClick={() => void handleConfirm(s.statementLineId, suggested.journalLineId)}
                          >
                            {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            {t("ConfirmMatch" as any)}
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
                            {t("IgnoreLine" as any)}
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
                <TableHead>{t("Date" as any)}</TableHead>
                <TableHead>{t("Description" as any)}</TableHead>
                <TableHead className="text-right">{t("Amount" as any)}</TableHead>
                <TableHead>{t("Status" as any)}</TableHead>
                <TableHead className="text-right">{t("Actions" as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matchedLines === undefined ? (
                <AccountingEmptyRow colSpan={5} label={t("Loading")} />
              ) : matchedLines.length === 0 ? (
                <AccountingEmptyRow colSpan={5} label={t("NoMatchedLines" as any)} />
              ) : (
                matchedLines.map((line) => {
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
                          {t("Matched" as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManageFinance && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                            disabled={unmatching}
                            onClick={() => void handleUnmatch(line._id)}
                          >
                            {unmatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            {t("Unmatch" as any)}
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

      <Dialog open={!!ignoring} onOpenChange={(open) => !open && setIgnoring(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("IgnoreLineReasonTitle" as any)}</DialogTitle>
            <DialogDescription>{t("IgnoreLineReasonDescription" as any)}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={ignoring?.reason ?? ""}
            onChange={(e) => setIgnoring((cur) => (cur ? { ...cur, reason: e.target.value } : cur))}
            placeholder={t("IgnoreLineReasonPlaceholder" as any)}
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
              {t("IgnoreLine" as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
