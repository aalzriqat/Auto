"use client";

import { Check, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { calculateUnifiedMurabaha } from "@/lib/financing";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface ManualFinanceCardProps {
  vehiclePrice: number;
  downPayment: number;
  termMonths: number;
  selected: boolean;
  profitRate: number;
  insuranceRate: number;
  onChangeProfitRate: (value: number) => void;
  onChangeInsuranceRate: (value: number) => void;
  executionCommission: number;
  onChangeExecutionCommission: (value: number) => void;
  executionFees: number;
  onChangeExecutionFees: (value: number) => void;
  onSelect: () => void;
}

export function ManualFinanceCard({
  vehiclePrice,
  downPayment,
  termMonths,
  selected,
  profitRate,
  insuranceRate,
  onChangeProfitRate,
  onChangeInsuranceRate,
  executionCommission,
  onChangeExecutionCommission,
  executionFees,
  onChangeExecutionFees,
  onSelect,
}: ManualFinanceCardProps) {
  const { t } = useLanguage();

  const result = calculateUnifiedMurabaha({
    vehiclePrice,
    downPayment,
    commission: 0,
    processingFees: 0,
    executionCommission,
    executionFees,
    annualProfitRate: profitRate,
    annualInsuranceRate: insuranceRate,
    termMonths,
    gracePeriodMonths: 0,
    includesCommissionInDebt: false,
  });

  return (
    <div
      onClick={onSelect}
      className={cn(
        "text-start rounded-xl border transition-all duration-200 overflow-hidden cursor-pointer",
        selected
          ? "border-indigo-500 ring-2 ring-indigo-500/30 shadow-lg shadow-indigo-500/10"
          : "border-border hover:border-indigo-500/50 hover:shadow-md"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "px-4 py-3 border-b flex items-center justify-between",
          selected
            ? "bg-indigo-500/10 border-indigo-500/30"
            : "bg-muted/30 border-border"
        )}
      >
        <div className="flex items-center gap-2">
          <PenLine className="w-3.5 h-3.5 text-muted-foreground" />
          <div>
            <p className="font-semibold text-sm">{t("OtherFinanceOption" as any)}</p>
            <p className="text-xs text-muted-foreground">{t("OtherFinanceDesc" as any)}</p>
          </div>
        </div>

        {selected && (
          <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center shrink-0">
            <Check className="w-3 h-3 text-white" />
          </div>
        )}
      </div>

      {/* Rate inputs */}
      <div
        className="px-4 pt-3 grid grid-cols-2 gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid gap-1">
          <label className="text-[11px] text-muted-foreground">{t("Profit Rate" as any)}</label>
          <input
            type="number"
            step="0.01"
            value={profitRate || ""}
            onChange={(e) => {
              onChangeProfitRate(parseFloat(e.target.value) || 0);
              onSelect();
            }}
            className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-[11px] text-muted-foreground">{t("Insurance Rate" as any)}</label>
          <input
            type="number"
            step="0.01"
            value={insuranceRate || ""}
            onChange={(e) => {
              onChangeInsuranceRate(parseFloat(e.target.value) || 0);
              onSelect();
            }}
            className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-[11px] text-muted-foreground">{t("ExecutionCommission" as any)}</label>
          <input
            type="number"
            step="0.01"
            value={executionCommission || ""}
            onChange={(e) => {
              onChangeExecutionCommission(parseFloat(e.target.value) || 0);
              onSelect();
            }}
            className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="grid gap-1">
          <label className="text-[11px] text-muted-foreground">{t("ExecutionFees" as any)}</label>
          <input
            type="number"
            step="0.01"
            value={executionFees || ""}
            onChange={(e) => {
              onChangeExecutionFees(parseFloat(e.target.value) || 0);
              onSelect();
            }}
            className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      {/* Monthly installment */}
      <div className="px-4 pt-3 pb-2 text-center bg-gradient-to-b from-background to-muted/10">
        <p className="text-xs text-muted-foreground mb-0.5">{t("MonthlyInstallment" as any)}</p>
        <p className={cn("text-2xl font-bold", selected ? "text-indigo-400" : "text-foreground")}>
          {result.monthlyInstallment.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          <span className="text-sm font-normal text-muted-foreground ms-1">{t("JOD" as any)}</span>
        </p>
      </div>

      {/* Details */}
      <div className="px-4 pb-3 space-y-1.5 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>{t("FinancedAmount" as any)}</span>
          <span className="font-medium text-foreground">
            {result.financedAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>

        <div className="flex justify-between text-muted-foreground">
          <span>{t("TotalProfit" as any) || "Total Profit"}</span>
          <span className="font-medium text-foreground">
            {result.totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>

        {result.takafulAmount > 0 && (
          <div className="flex justify-between text-muted-foreground">
            <span>{t("Takaful" as any)}</span>
            <span className="font-medium text-foreground">
              {result.takafulAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
