"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { scaleForCurrency } from "../AccountingTabShared";

type CashDrawerSession = Doc<"cashDrawerSessions">;
type RecordableCashMovementType = "SALE" | "PAYOUT" | "HANDOVER";

function statusClass(status: CashDrawerSession["status"]) {
  if (status === "APPROVED") return "text-emerald-700";
  return "text-amber-700";
}

export function CashDrawerPanel() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const factor = Math.pow(10, scaleForCurrency(currencyCode));
  const [openDialog, setOpenDialog] = useState(false);
  const [movementSession, setMovementSession] = useState<CashDrawerSession | null>(null);
  const [closeSession, setCloseSession] = useState<CashDrawerSession | null>(null);
  const [selectedSession, setSelectedSession] = useState<CashDrawerSession | null>(null);

  const sessions = useQuery(api.cashDrawer.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const movements = useQuery(
    api.cashDrawer.listMovements,
    activeOrgId && selectedSession ? { orgId: activeOrgId, sessionId: selectedSession._id } : "skip"
  );
  const beginCount = useMutation(api.cashDrawer.beginCount);
  const approveVariance = useMutation(api.cashDrawer.approveVariance);

  if (!activeOrgId) return null;

  async function begin(session: CashDrawerSession) {
    try {
      await beginCount({ orgId: activeOrgId!, sessionId: session._id });
      toast.success(t("CashDrawerCountingStarted" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  }

  async function approve(session: CashDrawerSession) {
    try {
      await approveVariance({ orgId: activeOrgId!, sessionId: session._id });
      toast.success(t("CashDrawerApproved" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpenDialog(true)}>
          <Plus className="me-2 h-4 w-4" />
          {t("OpenCashDrawer" as any)}
        </Button>
      </div>
      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("OpenedAt" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("OpeningFloat" as any)}</TableHead>
              <TableHead className="text-right">{t("CountedCash" as any)}</TableHead>
              <TableHead className="text-right">{t("Difference" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!sessions ? (
              <CashDrawerEmptyRow label={t("LoadingCashDrawers" as any)} />
            ) : sessions.length === 0 ? (
              <CashDrawerEmptyRow label={t("NoCashDrawerSessions" as any)} />
            ) : (
              sessions.map((session) => (
                <TableRow key={session._id}>
                  <TableCell>{new Date(session.openedAt).toLocaleString()}</TableCell>
                  <TableCell className={statusClass(session.status)}>{session.status}</TableCell>
                  <TableCell className="text-right">{formatCurrency(session.openingFloatMinor / factor)}</TableCell>
                  <TableCell className="text-right">{session.closingCountMinor != null ? formatCurrency(session.closingCountMinor / factor) : "-"}</TableCell>
                  <TableCell className="text-right">{session.varianceMinor != null ? formatCurrency(session.varianceMinor / factor) : "-"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => setSelectedSession(session)}>{t("Movements" as any)}</Button>
                      <Button size="sm" variant="outline" disabled={session.status !== "OPEN"} onClick={() => setMovementSession(session)}>{t("Record" as any)}</Button>
                      <Button size="sm" variant="outline" disabled={session.status !== "OPEN"} onClick={() => begin(session)}>{t("BeginCount" as any)}</Button>
                      <Button size="sm" variant="outline" disabled={session.status !== "COUNTING"} onClick={() => setCloseSession(session)}>{t("Close" as any)}</Button>
                      <Button size="sm" variant="outline" disabled={session.status !== "CLOSED"} onClick={() => approve(session)}>{t("Approve" as any)}</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {selectedSession && (
        <MovementList
          session={selectedSession}
          movements={movements ?? []}
          formatAmount={(amountMinor) => formatCurrency(amountMinor / factor)}
          onClose={() => setSelectedSession(null)}
        />
      )}
      <OpenDrawerDialog open={openDialog} onOpenChange={setOpenDialog} factor={factor} />
      <RecordMovementDialog session={movementSession} onOpenChange={(open) => !open && setMovementSession(null)} factor={factor} />
      <CloseDrawerDialog session={closeSession} onOpenChange={(open) => !open && setCloseSession(null)} factor={factor} />
    </div>
  );
}

function CashDrawerEmptyRow({ label }: Readonly<{ label: string }>) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="text-center text-slate-500 py-8">
        {label}
      </TableCell>
    </TableRow>
  );
}

function MovementList({
  session,
  movements,
  formatAmount,
  onClose,
}: Readonly<{
  session: CashDrawerSession;
  movements: Doc<"cashMovements">[];
  formatAmount: (amountMinor: number) => string;
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const sortedMovements = useMemo(
    () => [...movements].sort((a, b) => a.occurredAt - b.occurredAt),
    [movements]
  );

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("Movements" as any)} - {session.status}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("Close" as any)}</Button>
      </div>
      {sortedMovements.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">{t("NoCashMovements" as any)}</p>
      ) : (
        <div className="space-y-2">
          {sortedMovements.map((movement) => (
            <div key={movement._id} className="flex justify-between text-sm">
              <span>{movement.type} · {new Date(movement.occurredAt).toLocaleString()}</span>
              <span className="font-medium">{formatAmount(movement.amountMinor)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenDrawerDialog({ open, onOpenChange, factor }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; factor: number }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const openDrawer = useMutation(api.cashDrawer.open);
  const [openingFloat, setOpeningFloat] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId) return;
    setSubmitting(true);
    try {
      await openDrawer({ orgId: activeOrgId, openingFloatMinor: Math.round(Number(openingFloat) * factor) });
      toast.success(t("CashDrawerOpened" as any));
      onOpenChange(false);
      setOpeningFloat("");
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("OpenCashDrawer" as any)}</DialogTitle>
          <DialogDescription>{t("OpenCashDrawerDesc" as any)}</DialogDescription>
        </DialogHeader>
        <Input type="number" min="0" step={1 / factor} value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} placeholder={t("OpeningFloat" as any)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !openingFloat}>{submitting ? t("Saving" as any) : t("Open" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordMovementDialog({ session, onOpenChange, factor }: Readonly<{ session: CashDrawerSession | null; onOpenChange: (open: boolean) => void; factor: number }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const recordMovement = useMutation(api.cashDrawer.recordMovement);
  const [type, setType] = useState<RecordableCashMovementType>("SALE");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !session) return;
    setSubmitting(true);
    try {
      await recordMovement({
        orgId: activeOrgId,
        sessionId: session._id,
        type,
        amountMinor: Math.round(Number(amount) * factor),
        notes: notes.trim() || undefined,
      });
      toast.success(t("CashMovementRecorded" as any));
      onOpenChange(false);
      setAmount("");
      setNotes("");
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("RecordCashMovement" as any)}</DialogTitle>
          <DialogDescription>{session ? new Date(session.openedAt).toLocaleString() : ""}</DialogDescription>
        </DialogHeader>
        <Select value={type} onValueChange={(value) => setType(value as RecordableCashMovementType)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(["SALE", "PAYOUT", "HANDOVER"] as RecordableCashMovementType[]).map((movementType) => (
              <SelectItem key={movementType} value={movementType}>{movementType}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="number" min="0" step={1 / factor} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("Amount" as any)} />
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("NotesLabel" as any)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !amount}>{submitting ? t("Saving" as any) : t("Record" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseDrawerDialog({ session, onOpenChange, factor }: Readonly<{ session: CashDrawerSession | null; onOpenChange: (open: boolean) => void; factor: number }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const closeDrawer = useMutation(api.cashDrawer.close);
  const [closingCount, setClosingCount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!activeOrgId || !session) return;
    setSubmitting(true);
    try {
      await closeDrawer({ orgId: activeOrgId, sessionId: session._id, closingCountMinor: Math.round(Number(closingCount) * factor) });
      toast.success(t("CashDrawerClosed" as any));
      onOpenChange(false);
      setClosingCount("");
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("CloseCashDrawer" as any)}</DialogTitle>
          <DialogDescription>{t("CloseCashDrawerDesc" as any)}</DialogDescription>
        </DialogHeader>
        <Input type="number" min="0" step={1 / factor} value={closingCount} onChange={(event) => setClosingCount(event.target.value)} placeholder={t("CountedCash" as any)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !closingCount}>{submitting ? t("Saving" as any) : t("Close" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
