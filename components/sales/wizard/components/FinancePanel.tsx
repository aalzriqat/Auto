"use client";

import { Badge } from "@/components/ui/badge";
import { FinanceCompanyCard } from "./FinanceCompanyCard";
import { useFinanceComparison } from "../hooks/useFinanceComparison";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface FinancePanelProps {
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  vehicleId: string;

  selectedCompanyId?: string;
  onSelectCompany: (companyId: string) => void;
  customerStatuses?: string[];
}

export function FinancePanel({
  vehiclePrice,
  desiredProfit,
  downPayment,
  termMonths,
  vehicleId,
  selectedCompanyId,
  onSelectCompany,
  customerStatuses = [],
}: FinancePanelProps) {
  const { t } = useLanguage();

  const {
    comparisons,
    effectivePrice,
    loading,
    hasVehicle,
  } = useFinanceComparison({
    vehiclePrice,
    desiredProfit,
    downPayment,
    termMonths,
    vehicleId,
    customerStatuses,
  });

  if (!hasVehicle) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("SelectVehiclePrice" as any)}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        {t("LoadingFinance" as any)}
      </div>
    );
  }

  if (customerStatuses.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("SelectStatusFilter")}
      </div>
    );
  }

  if (comparisons.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("NoFinanceCompanies" as any)}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Effective Price Summary */}
      {desiredProfit > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-indigo-500/10 border border-indigo-500/30 px-4 py-2.5 text-sm">
          <span className="text-indigo-300">
            {t("Base" as any)} {vehiclePrice.toLocaleString()} {t("JOD" as any)} + {t("DealerProfit" as any)}{" "}
            {desiredProfit.toLocaleString()} {t("JOD" as any)}
          </span>

          <span className="font-bold text-indigo-200">
            = {effectivePrice.toLocaleString()} {t("JOD" as any)} {t("Effective" as any)}
          </span>
        </div>
      )}

      {/* Selected Company Indicator */}
      {selectedCompanyId && (
        <Badge
          variant="outline"
          className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30"
        >
          {t("CompanySelected" as any)}
        </Badge>
      )}

      {/* Finance Company Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {comparisons.map((comparison) => (
          <FinanceCompanyCard
            key={comparison.companyId}
            result={comparison}
            selected={selectedCompanyId === comparison.companyId}
            onSelect={onSelectCompany}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="text-xs text-muted-foreground">
        <span className="text-amber-400">*</span> {t("RequiredDocument" as any)}
        &nbsp;·&nbsp;
        {t("ClickToSelectFinance" as any)}
      </div>
    </div>
  );
}