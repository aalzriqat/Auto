"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Truck, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type StatusFilter = "PENDING" | "PAID" | "ALL";

export function SourcingClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("PENDING");
  const [payDialogPayable, setPayDialogPayable] = useState<any>(null);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [isPaying, setIsPaying] = useState(false);
  const markPaidIdempotencyKeyRef = useRef<string | null>(null);

  const payables = useQuery(
    api.sourcingPayables.list,
    activeOrgId ? { orgId: activeOrgId, status: statusFilter === "ALL" ? undefined : statusFilter } : "skip"
  );

  const markPaid = useMutation(api.sourcingPayables.markPaid);

  const handleMarkPaid = async () => {
    if (!activeOrgId || !payDialogPayable) return;
    setIsPaying(true);
    try {
      markPaidIdempotencyKeyRef.current ??= `mark-paid:${crypto.randomUUID()}`;
      await markPaid({
        orgId: activeOrgId,
        payableId: payDialogPayable._id,
        paymentNotes: paymentNotes.trim() || undefined,
        idempotencyKey: markPaidIdempotencyKeyRef.current,
      });
      markPaidIdempotencyKeyRef.current = null;
      toast.success(t("SupplierMarkedPaid" as any));
      setPayDialogPayable(null);
      setPaymentNotes("");
    } catch (err: any) {
      toast.error(err?.message || "Failed to mark as paid");
    } finally {
      setIsPaying(false);
    }
  };

  const pending = payables?.filter((p) => p.status === "PENDING") ?? [];
  const totalOwed = pending.reduce((sum, p) => sum + p.amountDue, 0);

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6">
      <div className="flex items-center gap-3">
        <Truck className="h-6 w-6 text-orange-500" />
        <div>
          <h1 className="text-2xl font-bold">{t("SpecialOrdersSourcing" as any)}</h1>
          <p className="text-sm text-muted-foreground">{t("SpecialOrdersDesc" as any)}</p>
        </div>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">{t("OutstandingPayables" as any)}</p>
            <p className="text-2xl font-bold text-orange-600">{totalOwed.toLocaleString()} JOD</p>
            <p className="text-xs text-muted-foreground">{pending.length} {t("PendingPayments" as any)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">{t("OldestOutstanding" as any)}</p>
            <p className="text-2xl font-bold">
              {pending.length > 0 ? Math.max(...pending.map((p) => p.daysOutstanding)) : 0} {t("Days" as any)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">{t("TotalSourcedDeals" as any)}</p>
            <p className="text-2xl font-bold">{payables?.length ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2">
        {(["PENDING", "PAID", "ALL"] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s === "PENDING" ? t("Pending" as any) : s === "PAID" ? t("Paid" as any) : t("All" as any)}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("SupplierPayables" as any)}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Vehicle" as any)}</TableHead>
                <TableHead>{t("SourceDealer" as any)}</TableHead>
                <TableHead>{t("Customer" as any)}</TableHead>
                <TableHead>{t("AmountOwed" as any)}</TableHead>
                <TableHead>{t("DaysOutstanding" as any)}</TableHead>
                <TableHead>{t("Status" as any)}</TableHead>
                <TableHead>{t("Date" as any)}</TableHead>
                <TableHead className="text-right">{t("Actions" as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!payables ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    {t("Loading" as any)}…
                  </TableCell>
                </TableRow>
              ) : payables.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    {t("NoSourcingPayables" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                payables.map((p) => (
                  <TableRow key={p._id}>
                    <TableCell className="font-medium">{p.vehicleDesc}</TableCell>
                    <TableCell>{p.sourcedFromName}</TableCell>
                    <TableCell className="text-muted-foreground">{p.customerName ?? "—"}</TableCell>
                    <TableCell className="font-semibold">{p.amountDue.toLocaleString()} JOD</TableCell>
                    <TableCell>
                      <span className={p.daysOutstanding > 30 ? "text-red-600 font-semibold" : "text-muted-foreground"}>
                        {p.daysOutstanding}d
                      </span>
                    </TableCell>
                    <TableCell>
                      {p.status === "PENDING" ? (
                        <Badge variant="outline" className="text-orange-600 border-orange-400">
                          <Clock className="h-3 w-3 me-1" />{t("Pending" as any)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-green-600 border-green-400">
                          <CheckCircle2 className="h-3 w-3 me-1" />{t("Paid" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{format(p.createdAt, "PP")}</TableCell>
                    <TableCell className="text-right">
                      {p.status === "PENDING" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600"
                          onClick={() => { setPayDialogPayable(p); setPaymentNotes(""); }}
                        >
                          {t("MarkPaid" as any)}
                        </Button>
                      )}
                      {p.status === "PAID" && (
                        <span className="text-xs text-muted-foreground">
                          {p.paidAt ? format(p.paidAt, "PP") : "—"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mark Paid Dialog */}
      <Dialog open={!!payDialogPayable} onOpenChange={(o) => { if (!o) { setPayDialogPayable(null); setPaymentNotes(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ConfirmSupplierPayment" as any)}</DialogTitle>
          </DialogHeader>
          {payDialogPayable && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <p><strong>{t("Vehicle" as any)}:</strong> {payDialogPayable.vehicleDesc}</p>
                <p><strong>{t("SourceDealer" as any)}:</strong> {payDialogPayable.sourcedFromName}</p>
                <p><strong>{t("Amount" as any)}:</strong> <span className="font-semibold text-orange-600">{payDialogPayable.amountDue.toLocaleString()} JOD</span></p>
              </div>
              <p className="text-sm text-muted-foreground">{t("MarkPaidWarning" as any)}</p>
              <div className="space-y-1">
                <label className="text-sm font-medium">{t("PaymentNotes" as any)} ({t("Optional" as any)})</label>
                <Textarea value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} placeholder={t("PaymentNotesPlaceholder" as any)} rows={2} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setPayDialogPayable(null); setPaymentNotes(""); }}>
                  {t("Cancel" as any)}
                </Button>
                <Button className="bg-green-600 hover:bg-green-700 text-white" onClick={handleMarkPaid} disabled={isPaying}>
                  {isPaying ? t("Processing" as any) + "…" : t("ConfirmPayment" as any)}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
