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
import { Doc, Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
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
  const [taxAmount, setTaxAmount] = useState("");
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

  // The live special-order pipeline — cars on order for a customer that have
  // not sold yet. Payables below only exist once the sale completes, so without
  // this the page was empty for the entire life of an order.
  const pipeline = useQuery(
    api.sourcingPayables.listPipeline,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const markPaid = useMutation(api.sourcingPayables.markPaid);
  const markArrived = useMutation(api.vehicles.markSourcedVehicleArrived);
  const [arrivingVehicleId, setArrivingVehicleId] = useState<string | null>(null);

  const handleMarkArrived = async (vehicleId: Id<"vehicles">) => {
    if (!activeOrgId) return;
    setArrivingVehicleId(vehicleId);
    try {
      await markArrived({ orgId: activeOrgId, vehicleId });
      toast.success(t("VehicleMarkedArrived" as any) || "Marked as arrived");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setArrivingVehicleId(null);
    }
  };

  const handleMarkPaid = async () => {
    if (!activeOrgId || !payDialogPayable) return;
    setIsPaying(true);
    try {
      const trimmedTax = taxAmount.trim();
      let parsedTaxAmount: number | undefined;
      if (trimmedTax) {
        parsedTaxAmount = Number(trimmedTax);
        if (!Number.isFinite(parsedTaxAmount) || parsedTaxAmount < 0) {
          toast.error(t("InvalidVatAmount" as any));
          setIsPaying(false);
          return;
        }
      }
      markPaidIdempotencyKeyRef.current ??= `mark-paid:${crypto.randomUUID()}`;
      await markPaid({
        orgId: activeOrgId,
        payableId: payDialogPayable._id,
        paymentNotes: paymentNotes.trim() || undefined,
        paymentMethod,
        taxAmount: parsedTaxAmount,
        idempotencyKey: markPaidIdempotencyKeyRef.current,
      });
      markPaidIdempotencyKeyRef.current = null;
      toast.success(t("SupplierMarkedPaid" as any));
      markPaidIdempotencyKeyRef.current = null;
      setPayDialogPayable(null);
      setPaymentNotes("");
      setPaymentMethod("CASH");
      setTaxAmount("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("UnexpectedError" as any));
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
            {/* Counts both halves of the page. Reading only the payables table
                made this card say "0 sourced deals" directly above a list of
                live special orders, because a payable is not written until the
                sale completes. */}
            <p className="text-2xl font-bold">
              {(pipeline?.length ?? 0) + (allPayables?.length ?? 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* In-progress special orders.
          Deliberately not another table: each row is one live commitment to a
          customer, and the thing that matters is how long they have been
          waiting — so the layout leads with the stage and the wait, not with
          columns of figures. The payables table below stays financial. */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 className="text-base font-semibold">{t("OrdersInProgress" as any) || "Orders in progress"}</h2>
          {pipeline && pipeline.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {pipeline.length}{" "}
              {pipeline.length === 1
                ? (t("VehicleOnOrder" as any) || "vehicle on order")
                : (t("VehiclesOnOrder" as any) || "vehicles on order")}
              {" · "}
              {pipeline.reduce((sum, row) => sum + row.sourceCost, 0).toLocaleString()} JOD{" "}
              {t("CommittedToSuppliers" as any) || "committed to source dealers"}
            </p>
          )}
        </div>

        {pipeline === undefined ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("Loading" as any) || "Loading..."}
            </CardContent>
          </Card>
        ) : pipeline.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("NoOrdersInProgress" as any) ||
                "No special orders in progress. Sourced vehicles appear here from the moment they are ordered until the sale completes."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {pipeline.map((row) => {
              // Arrival is its own fact, not a status: a car that arrives while
              // a deposit holds it stays RESERVED. So the stage is read from
              // both — "here and spoken for" is a real and common state.
              const stage = row.hasArrived
                ? {
                  label: row.isHeld
                    ? (t("StageArrivedHeld" as any) || "Arrived · held")
                    : (t("StageArrived" as any) || "Arrived"),
                  icon: CheckCircle2,
                  rail: "bg-emerald-500",
                  chip: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
                }
                : row.isHeld
                  ? {
                    label: t("StageHeldForCustomer" as any) || "Held for customer",
                    icon: Truck,
                    rail: "bg-sky-500",
                    chip: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-400",
                  }
                  : {
                    label: t("StageOnOrder" as any) || "On order",
                    icon: Clock,
                    rail: "bg-amber-400",
                    chip: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400",
                  };
              const StageIcon = stage.icon;
              return (
                <div
                  key={row._id}
                  className="relative flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card ps-5 pe-4 py-3 overflow-hidden"
                >
                  <span className={`absolute inset-y-0 start-0 w-1 ${stage.rail}`} aria-hidden="true" />

                  <div className="min-w-[12rem] flex-1">
                    <p className="font-medium leading-tight">{row.vehicleDesc}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.sourcedFromName || t("UnknownSupplier" as any) || "Unknown supplier"}
                    </p>
                  </div>

                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${stage.chip}`}
                  >
                    <StageIcon className="h-3 w-3" aria-hidden="true" />
                    {stage.label}
                  </span>

                  <div className="min-w-[9rem]">
                    <p className="text-xs text-muted-foreground">{t("Customer" as any) || "Customer"}</p>
                    <p className="text-sm">
                      {row.customerName ?? (
                        <span className="text-muted-foreground">
                          {t("NoCustomerYet" as any) || "Not assigned"}
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="min-w-[7rem]">
                    <p className="text-xs text-muted-foreground">{t("DepositTaken" as any) || "Deposit"}</p>
                    <p className="text-sm font-medium tabular-nums">
                      {row.depositTotal > 0 ? `${row.depositTotal.toLocaleString()} JOD` : "—"}
                    </p>
                  </div>

                  <div className="min-w-[7rem]">
                    <p className="text-xs text-muted-foreground">{t("SupplierCost" as any) || "Supplier cost"}</p>
                    <p className="text-sm font-medium tabular-nums">{row.sourceCost.toLocaleString()} JOD</p>
                  </div>

                  <div className="text-end min-w-[6rem]">
                    <p
                      className={`text-lg font-bold tabular-nums leading-none ${row.daysWaiting >= 30 ? "text-red-600 dark:text-red-400" : row.daysWaiting >= 14 ? "text-amber-600 dark:text-amber-500" : ""}`}
                    >
                      {row.daysWaiting}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("DaysWaiting" as any) || "days waiting"}</p>
                  </div>

                  {!row.hasArrived && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={arrivingVehicleId === row._id}
                      onClick={() => void handleMarkArrived(row._id)}
                    >
                      {t("MarkArrived" as any) || "Mark arrived"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

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
          <p className="text-sm text-muted-foreground">
            {t("SupplierPayablesHint" as any) ||
              "Amounts owed to source dealers. A row appears once the sale completes, or immediately for owned stock bought on account."}
          </p>
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
        taxAmount={taxAmount}
        t={t as any}
        onNotesChange={setPaymentNotes}
        onPaymentMethodChange={setPaymentMethod}
        onTaxAmountChange={setTaxAmount}
        onConfirm={handleMarkPaid}
        onOpenChange={(open) => {
          if (!open) {
            markPaidIdempotencyKeyRef.current = null;
            setPayDialogPayable(null);
            setPaymentNotes("");
            setPaymentMethod("CASH");
            setTaxAmount("");
          }
        }}
      />
    </div>
  );
}
