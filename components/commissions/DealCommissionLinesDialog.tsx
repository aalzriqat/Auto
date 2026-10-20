"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DEAL_COMMISSION_KINDS, type DealCommissionKind } from "@/convex/utils/dealCommissionLines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage } from "@/lib/errors";

type Translate = (key: string) => string;

/**
 * Where a deal's employee commissions are registered: the lines on one deal,
 * and a small form to add another. A dialog, so neither the Commissions table
 * nor the deal screen carries a field for every commission type.
 *
 * The salesperson's own commission is set on the page's main row (existing
 * path), so it is listed here read-only and the form is for everyone else.
 */
export function DealCommissionLinesDialog({
  orgId,
  saleId,
  members,
  money,
  t,
  onOpenChange,
}: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales"> | null;
  members: ReadonlyArray<{ userId: Id<"users">; name: string }>;
  money: (minor: number, currency: string) => string;
  t: Translate;
  onOpenChange: (open: boolean) => void;
}>) {
  const view = useQuery(api.dealCommissions.forSale, saleId ? { orgId, saleId } : "skip");
  const addLine = useMutation(api.dealCommissions.addLine);
  const removeLine = useMutation(api.dealCommissions.removeLine);
  const [kind, setKind] = useState<DealCommissionKind>("PURCHASE");
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = amount.trim() === "" ? NaN : Number(amount);
  const canSubmit = !busy && saleId !== null && employeeId !== "" && Number.isFinite(parsed) && parsed > 0;

  async function submit() {
    if (!saleId || !canSubmit) return;
    setBusy(true);
    try {
      await addLine({ orgId, saleId, kind, employeeId: employeeId as Id<"users">, amount: parsed, note: note.trim() || undefined });
      toast.success(t("DealCommissionLinesAdded"));
      setAmount("");
      setNote("");
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function remove(lineId: Id<"dealCommissionLines">) {
    setBusy(true);
    try {
      await removeLine({ orgId, lineId });
      toast.success(t("DealCommissionLinesRemoved"));
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={saleId !== null} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("DealCommissionLinesTitle")}</DialogTitle>
        </DialogHeader>
        {view === undefined ? (
          <p className="text-sm text-muted-foreground">{t("DealCommissionsLoading")}</p>
        ) : (
          <div className="space-y-4">
            <ul className="divide-y rounded-md border text-sm">
              <li className="flex items-start justify-between gap-3 px-3 py-2">
                <span>
                  <span className="block">{t("DealCommissionSalespersonLine")}</span>
                  <span className="block text-xs text-muted-foreground">{view.salesperson.employeeName}</span>
                </span>
                <span className="tabular-nums">{view.salesperson.amountMinor === null ? "—" : money(view.salesperson.amountMinor, view.currency)}</span>
              </li>
              {view.lines.map((line) => (
                <li key={line.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <span>
                    <span className="block">{t(`DealCommissionKind${line.kind}`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {line.employeeName}
                      {line.note ? ` · ${line.note}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{money(line.amountMinor, view.currency)}</span>
                    {view.canManage && view.writesEnabled && (
                      <Button variant="ghost" size="icon" disabled={busy} aria-label={t("DealCommissionLinesRemove")} onClick={() => remove(line.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2 font-medium">
                <span>{t("DealCommissionsTotal")}</span>
                <span className="tabular-nums">{view.totalMinor === null ? "—" : money(view.totalMinor, view.currency)}</span>
              </li>
            </ul>

            {view.canManage && view.saleStatus !== "CANCELLED" && (
              view.writesEnabled ? (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium">{t("DealCommissionLinesAdd")}</h3>
                  <p className="text-xs text-muted-foreground">{t("DealCommissionLinesSalesPersonHint")}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>{t("DealCommissionLinesType")}</Label>
                      <Select value={kind} onValueChange={(value) => setKind(value as DealCommissionKind)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DEAL_COMMISSION_KINDS.map((option) => (
                            <SelectItem key={option} value={option}>{t(`DealCommissionKind${option}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{t(`DealCommissionKindHint${kind}`)}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t("DealCommissionLinesEmployee")}</Label>
                      <Select value={employeeId} onValueChange={setEmployeeId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {members.map((member) => (
                            <SelectItem key={member.userId} value={member.userId}>{member.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="deal-commission-amount">{t("DealCommissionLinesAmount")}</Label>
                      <Input id="deal-commission-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="deal-commission-note">{t("DealCommissionLinesNote")}</Label>
                      <Input id="deal-commission-note" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
                    </div>
                  </div>
                  <Button disabled={!canSubmit} onClick={submit}>{t("DealCommissionLinesSave")}</Button>
                </div>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400">{t("DealCommissionLinesPilotPaused")}</p>
              )
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
