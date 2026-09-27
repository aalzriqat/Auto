"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { fromMinorUnits, toMinorUnits } from "@/convex/utils/money";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaymentMethodSelect } from "@/components/payments/PaymentMethodSelect";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";

type Recovery = {
  _id: Id<"supplierCostRecoveries">;
  sourcedFromName: string;
  currency: string;
  amountDueMinor: number;
  amountRecoveredMinor: number;
  remainingMinor: number;
  status: "OPEN" | "PARTIALLY_RECOVERED" | "RECOVERED" | "REVERSED";
  sourcePostingState: "POSTED" | "REVERSED" | "PENDING" | "FAILED" | "NONE";
  expenseTitle: string | null;
  vehicleLabel: string | null;
};

const STATUS_CLASS: Record<Recovery["status"], string> = {
  OPEN: "text-orange-600 border-orange-400",
  PARTIALLY_RECOVERED: "text-sky-700 border-sky-400 dark:text-sky-400",
  RECOVERED: "text-green-600 border-green-400",
  REVERSED: "text-muted-foreground border-border",
};

type RecoveryMethod = "CASH" | "BANK_TRANSFER";
const RECOVERY_METHODS: readonly RecoveryMethod[] = ["CASH", "BANK_TRANSFER"];

function money(minor: number, currency: string): string {
  return `${fromMinorUnits(minor, currency).toLocaleString()} ${currency}`;
}

/**
 * SCRUM-389 — supplier-borne vehicle costs still owed back, with the one action
 * that settles them. Deliberately minimal: listing and recording a receipt.
 * Reversal of a receipt, write-off (SCRUM-399), cheques (SCRUM-400) and
 * netting at settlement (SCRUM-401) are not offered here.
 */
export function SupplierCostRecoveriesSection() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const canView = !permissionsLoading && hasPermission(PERMISSIONS.VIEW_FINANCE);
  const canRecord = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  const recoveries = useQuery(
    api.supplierCostRecoveries.list,
    activeOrgId && canView ? { orgId: activeOrgId } : "skip"
  );
  const recordReceipt = useMutation(api.supplierCostRecoveries.recordReceipt);

  const [target, setTarget] = useState<Recovery | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<RecoveryMethod>("CASH");
  const [receivedDate, setReceivedDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  // One receipt intent per dialog session: a retried submit is the SAME
  // command, and closing the dialog ends it.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target) idempotencyKeyRef.current = null;
  }, [target]);

  if (!canView) return null;

  const open = (row: Recovery) => {
    setTarget(row);
    setAmount(String(fromMinorUnits(row.remainingMinor, row.currency)));
    setMethod("CASH");
    setReceivedDate(new Date().toISOString().split("T")[0]);
    setReference("");
  };

  const submit = async () => {
    if (!activeOrgId || !target) return;
    let amountMinor: number;
    try {
      // Throws on anything that is not a safe integer in minor units (NaN included).
      amountMinor = toMinorUnits(Number(amount), target.currency);
    } catch {
      toast.error(t("RecoveryReceiptInvalidAmount" as any));
      return;
    }
    if (amountMinor <= 0 || amountMinor > target.remainingMinor) {
      toast.error(t("RecoveryReceiptInvalidAmount" as any));
      return;
    }
    // The picked calendar day, clamped to now so "today" is never in the future.
    const picked = new Date(`${receivedDate}T12:00:00`).getTime();
    const receivedAt = Math.min(Number.isFinite(picked) ? picked : Date.now(), Date.now() - 1_000);
    setSaving(true);
    try {
      idempotencyKeyRef.current ??= `supplier-cost-receipt:${crypto.randomUUID()}`;
      await recordReceipt({
        orgId: activeOrgId,
        recoveryId: target._id,
        amountMinor,
        method,
        receivedDate: receivedAt,
        reference: reference.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(t("RecoveryReceiptRecorded" as any));
      setTarget(null);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const items: Recovery[] = recoveries?.items ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("SupplierCostRecoveriesTitle" as any)}</h2>
          <p className="text-sm text-muted-foreground">{t("SupplierCostRecoveriesHint" as any)}</p>
        </div>
        {recoveries && !recoveries.complete && (
          <p className="text-xs text-muted-foreground">{t("RecoveryListIncomplete" as any)}</p>
        )}
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Vehicle" as any)}</TableHead>
              <TableHead>{t("SourceDealer" as any)}</TableHead>
              <TableHead>{t("Expenses" as any)}</TableHead>
              <TableHead className="text-end">{t("RecoveryDue" as any)}</TableHead>
              <TableHead className="text-end">{t("RecoveryRecovered" as any)}</TableHead>
              <TableHead className="text-end">{t("RecoveryRemaining" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recoveries === undefined ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                  {t("Loading" as any)}…
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                  {t("NoSupplierCostRecoveries" as any)}
                </TableCell>
              </TableRow>
            ) : (
              items.map((row) => {
                const posted = row.sourcePostingState === "POSTED";
                const collectible = posted && row.remainingMinor > 0 && row.status !== "REVERSED";
                return (
                  <TableRow key={row._id}>
                    <TableCell className="font-medium">{row.vehicleLabel ?? "—"}</TableCell>
                    <TableCell>{row.sourcedFromName}</TableCell>
                    <TableCell className="text-muted-foreground">{row.expenseTitle ?? "—"}</TableCell>
                    <TableCell className="text-end tabular-nums">{money(row.amountDueMinor, row.currency)}</TableCell>
                    <TableCell className="text-end tabular-nums">{money(row.amountRecoveredMinor, row.currency)}</TableCell>
                    <TableCell className="text-end tabular-nums font-semibold">{money(row.remainingMinor, row.currency)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_CLASS[row.status]}>
                        {t(`RecoveryStatus_${row.status}` as any)}
                      </Badge>
                      {!posted && row.status !== "REVERSED" && (
                        <span className="ms-2 text-xs text-muted-foreground">{t("RecoveryAwaitingPosting" as any)}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      {canRecord && collectible && (
                        <Button size="sm" variant="outline" onClick={() => open(row)}>
                          {t("RecordRecoveryReceipt" as any)}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!target} onOpenChange={(next) => { if (!next) setTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("RecordRecoveryReceipt" as any)}</DialogTitle>
          </DialogHeader>
          {target && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <p><strong>{t("Vehicle" as any)}:</strong> {target.vehicleLabel ?? "—"}</p>
                <p><strong>{t("SourceDealer" as any)}:</strong> {target.sourcedFromName}</p>
                <p>
                  <strong>{t("RecoveryRemaining" as any)}:</strong>{" "}
                  <span className="font-semibold tabular-nums">{money(target.remainingMinor, target.currency)}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-amount">{t("RecoveryReceiptAmount" as any)}</Label>
                <Input
                  id="recovery-amount"
                  type="number"
                  step="0.001"
                  min="0"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("RecoveryReceiptMethod" as any)}</Label>
                  <PaymentMethodSelect t={t} value={method} onValueChange={setMethod} methods={RECOVERY_METHODS} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recovery-date">{t("RecoveryReceiptDate" as any)}</Label>
                  <Input
                    id="recovery-date"
                    type="date"
                    max={new Date().toISOString().split("T")[0]}
                    value={receivedDate}
                    onChange={(e) => setReceivedDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-reference">{t("RecoveryReceiptReference" as any)}</Label>
                <Input id="recovery-reference" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setTarget(null)}>
                  {t("Cancel" as any)}
                </Button>
                <Button type="button" disabled={saving} onClick={() => void submit()}>
                  {saving ? t("Saving" as any) : t("RecordRecoveryReceipt" as any)}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
