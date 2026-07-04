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
import { Truck, CheckCircle2, Clock, XCircle } from "lucide-react";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { Doc } from "@/convex/_generated/dataModel";
import { type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { SupplierPaymentDialog } from "@/components/sourcing/SupplierPaymentDialog";

type StatusFilter = "PENDING" | "PAID" | "CANCELLED" | "ALL";

type SourcingPayable = Doc<"vehicleSupplierPayables"> & {
  vehicleDesc: string;
  vehicleVin?: string;
  customerName: string | null;
  paidByName: string | null | undefined;
  daysOutstanding: number;
};

function payableMethodLabel(t: (key: any) => string, method?: PaymentMethod) {
  return t(`PaymentMethod_${method ?? "CASH"}` as any);
}

export function SourcingClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("PENDING");
  const [payDialogPayable, setPayDialogPayable] = useState<SourcingPayable | null>(null);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [isPaying, setIsPaying] = useState(false);
  const markPaidIdempotencyKeyRef = useRef<string | null>(null);

  // allPayables for summary cards (unfiltered); payables for the table (filtered by statusFilter).
  const allPayables = useQuery(
    api.sourcingPayables.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
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
        paymentMethod,
        idempotencyKey: markPaidIdempotencyKeyRef.current,
      });
      markPaidIdempotencyKeyRef.current = null;
      toast.success(t("SupplierMarkedPaid" as any));
      markPaidIdempotencyKeyRef.current = null;
      setPayDialogPayable(null);
      setPaymentNotes("");
      setPaymentMethod("CASH");
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setIsPaying(false);
    }
  };

  // Summary stats always reflect the full dataset, not the current filter.
  const allPending = allPayables?.filter((p: SourcingPayable) => p.status === "PENDING") ?? [];
  const totalOwed = allPending.reduce((sum: number, p: SourcingPayable) => sum + p.amountDue, 0);

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
            <p className="text-xs text-muted-foreground">{allPending.length} {t("PendingPayments" as any)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">{t("OldestOutstanding" as any)}</p>
            <p className="text-2xl font-bold">
              {allPending.length > 0 ? Math.max(...allPending.map((p: SourcingPayable) => p.daysOutstanding)) : 0} {t("Days" as any)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">{t("TotalSourcedDeals" as any)}</p>
            <p className="text-2xl font-bold">{allPayables?.length ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2">
        {(["PENDING", "PAID", "CANCELLED", "ALL"] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s === "PENDING" ? t("Pending" as any) : s === "PAID" ? t("Paid" as any) : s === "CANCELLED" ? t("Cancelled" as any) : t("All" as any)}
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
                <TableHead>{t("PaymentMethodLabel" as any)}</TableHead>
                <TableHead>{t("Date" as any)}</TableHead>
                <TableHead className="text-right">{t("Actions" as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!payables ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {t("Loading" as any)}…
                  </TableCell>
                </TableRow>
              ) : payables.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {t("NoSourcingPayables" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                payables.map((p: SourcingPayable) => (
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
                      ) : p.status === "PAID" ? (
                        <Badge variant="outline" className="text-green-600 border-green-400">
                          <CheckCircle2 className="h-3 w-3 me-1" />{t("Paid" as any)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-slate-600 border-slate-300">
                          <XCircle className="h-3 w-3 me-1" />{t("Cancelled" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {p.status === "PAID" ? payableMethodLabel(t as any, p.paymentMethod) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{format(p.createdAt, "PP")}</TableCell>
                    <TableCell className="text-right">
                      {p.status === "PENDING" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600"
                          onClick={() => { setPayDialogPayable(p); setPaymentNotes(""); setPaymentMethod("CASH"); }}
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

      <SupplierPaymentDialog
        payable={payDialogPayable}
        open={!!payDialogPayable}
        isPaying={isPaying}
        notes={paymentNotes}
        paymentMethod={paymentMethod}
        t={t as any}
        onNotesChange={setPaymentNotes}
        onPaymentMethodChange={setPaymentMethod}
        onConfirm={handleMarkPaid}
        onOpenChange={(open) => {
          if (!open) {
            markPaidIdempotencyKeyRef.current = null;
            setPayDialogPayable(null);
            setPaymentNotes("");
            setPaymentMethod("CASH");
          }
        }}
      />
    </div>
  );
}
