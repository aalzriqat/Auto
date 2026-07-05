"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  Car,
  Banknote,
  FileText,
  Receipt,
  Truck,
  TrendingUp,
  Users,
} from "lucide-react";

interface SaleTrailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saleId: Id<"sales"> | null;
}

interface TrailStep {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail?: string;
  date?: number;
}

export function SaleTrailDialog({ open, onOpenChange, saleId }: SaleTrailDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format } = useCurrency();
  const trail = useQuery(
    api.sales.getSaleTrail,
    activeOrgId && saleId ? { orgId: activeOrgId, saleId } : "skip"
  );

  const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

  const steps: TrailStep[] = [];
  if (trail) {
    const { sale, vehicle, customer, salespersonName } = trail;
    const vehicleLabel = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "";

    steps.push({
      icon: FileText,
      label: t("StepSaleCreated" as any),
      detail: `${customer ? `${customer.firstName} ${customer.lastName}` : ""} — ${vehicleLabel} — ${format(sale.salePrice)} — ${salespersonName}`,
      date: sale.saleDate,
    });

    if (sale.status === "COMPLETED") {
      steps.push({ icon: Car, label: t("StepVehicleSold" as any), detail: vehicleLabel });

      for (const deposit of trail.deposits) {
        steps.push({
          icon: Banknote,
          label: t("StepDepositApplied" as any),
          detail: format(deposit.amount),
          date: deposit.resolvedAt,
        });
      }

      if (trail.saleJournalEntry) {
        steps.push({
          icon: Receipt,
          label: t("StepGLPosted" as any),
          detail: `${t("JournalNumberLabel" as any)} #${trail.saleJournalEntry.journalNumber}`,
          date: trail.saleJournalEntry.postedAt,
        });
      }

      if (trail.receivable) {
        steps.push({
          icon: FileText,
          label: t("StepReceivableCreated" as any),
          detail: `${trail.receivable.documentNumber} — ${format(sale.salePrice)}`,
          date: trail.receivable.issueDate,
        });
      }

      for (const payment of trail.payments) {
        steps.push({
          icon: Banknote,
          label: t("StepPaymentAllocated" as any),
          detail: format(payment.amount),
          date: payment.allocationDate,
        });
      }

      if (trail.supplierPayable) {
        steps.push({
          icon: Truck,
          label: t("StepSupplierPayable" as any),
          detail: `${trail.supplierPayable.sourcedFromName} — ${format(trail.supplierPayable.amountDue)}`,
        });
      }

      if (sale.commissionAmount) {
        steps.push({
          icon: TrendingUp,
          label: t("StepCommissionAccrued" as any),
          detail: `${salespersonName} — ${format(sale.commissionAmount)}`,
        });
        if (trail.commissionJournalEntry) {
          steps.push({
            icon: Receipt,
            label: t("StepCommissionGLPosted" as any),
            detail: `${t("JournalNumberLabel" as any)} #${trail.commissionJournalEntry.journalNumber}`,
            date: trail.commissionJournalEntry.postedAt,
          });
        }
        if (sale.commissionPaidAt) {
          steps.push({
            icon: CheckCircle2,
            label: t("StepCommissionPaid" as any),
            detail: `${format(sale.commissionAmount)} — ${trail.commissionPaidByName ?? ""}`,
            date: sale.commissionPaidAt,
          });
        }
      }

      if (trail.lead?.stage === "WON") {
        steps.push({ icon: CheckCircle2, label: t("StepLeadClosed" as any) });
      }

      steps.push({ icon: Users, label: t("StepManagersNotified" as any) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("SaleTrail" as any)}</DialogTitle>
          <DialogDescription>{t("SaleTrailDesc" as any)}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pe-4 -me-4 mt-2">
          {trail === undefined ? (
            <div className="text-center py-8 text-muted-foreground">{t("Loading" as any)}</div>
          ) : (
            <div className="space-y-4">
              {trail.sale.status !== "COMPLETED" && (
                <p className="text-sm text-muted-foreground italic">{t("SaleTrailPendingNote" as any)}</p>
              )}
              {steps.map((step, i) => (
                <div key={i} className="relative ps-6 pb-2 border-s-2 last:border-0 border-muted">
                  <div className="absolute -start-[9px] top-1 h-4 w-4 rounded-full bg-background border-2 border-primary flex items-center justify-center">
                    <step.icon className="h-2.5 w-2.5 text-primary" />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{step.label}</span>
                    {step.date && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {dateFormat.format(new Date(step.date))}
                      </span>
                    )}
                  </div>
                  {step.detail && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate" title={step.detail}>
                      {step.detail}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
