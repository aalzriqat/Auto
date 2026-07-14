"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [ignoring, setIgnoring] = useState<{ id: Id<"bankStatementLines">; reason: string } | null>(null);

  const suggestions = useQuery(api.bankReconciliation.suggestMatches, { orgId, bankAccountId });
  const uploadLines = useMutation(api.bankReconciliation.uploadStatementLines);
  const confirmMatch = useMutation(api.bankReconciliation.confirmMatch);
  const ignoreLine = useMutation(api.bankReconciliation.ignoreLine);

  const factor = Math.pow(10, scaleForCurrency(currency));

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
    setBusyAction(`confirm_${statementLineId}`);
    try {
      await confirmMatch({ orgId, statementLineId, journalLineId });
      toast.success(t("MatchConfirmed" as any));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(null);
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
    setBusyAction(`ignore_${targetId}`);
    try {
      await ignoreLine({ orgId, statementLineId: targetId, reason: ignoring.reason });
      toast.success(t("LineIgnored" as any));
      setIgnoring((cur) => (cur?.id === targetId ? null : cur));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAction((cur) => (cur === `ignore_${targetId}` ? null : cur));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">{t("Reconciliation" as any)}</h3>
        {canManageFinance && (
          <BankStatementUploadDialog t={t as any} currencyScaleFactor={factor} onImport={handleImport} importing={importing} />
        )}
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
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
                const confirming = busyAction === `confirm_${s.statementLineId}`;
                const ignoringThisLine = busyAction === `ignore_${s.statementLineId}`;
                return (
                  <TableRow key={s.statementLineId}>
                    <TableCell className="text-slate-500">
                      {new Date(s.statementDate).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{s.description}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(s.amountMinor / factor)}
                    </TableCell>
                    <TableCell>
                      {suggested ? (
                        <span className="text-sm text-slate-600">
                          {suggested.memo || t("Untitled" as any)} —{" "}
                          {new Date(suggested.accountingDate).toLocaleDateString()}
                        </span>
                      ) : s.candidates.length > 0 ? (
                        <span className="text-sm text-amber-600">{t("MultipleCandidates" as any)}</span>
                      ) : (
                        <span className="text-sm text-slate-400">{t("NoCandidates" as any)}</span>
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
                          className="text-rose-600 hover:text-rose-700"
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
              disabled={busyAction === `ignore_${ignoring?.id}`}
            >
              {t("IgnoreLine" as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
