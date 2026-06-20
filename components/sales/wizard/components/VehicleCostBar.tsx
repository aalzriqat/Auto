"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Info, TrendingUp, TrendingDown } from "lucide-react";

interface VehicleCostBarProps {
  vehicleId: string;
  purchasePrice: number | null | undefined;
  salePrice: number;
}

export function VehicleCostBar({ vehicleId, purchasePrice, salePrice }: VehicleCostBarProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();

  const canViewExpenses = !permissionsLoading && hasPermission(PERMISSIONS.VIEW_EXPENSES);

  const totalExpenses = useQuery(
    api.expenses.totalByVehicle,
    activeOrgId && vehicleId && canViewExpenses
      ? { orgId: activeOrgId, vehicleId: vehicleId as Id<"vehicles"> }
      : "skip"
  );

  // Cost/profit data is sensitive — don't show this bar at all to roles
  // without VIEW_EXPENSES (e.g. SALES), rather than crash on the query.
  if (permissionsLoading || !canViewExpenses) return null;
  if (totalExpenses === undefined) return null;

  const hasCostData = purchasePrice != null;
  const totalCost = hasCostData ? purchasePrice + totalExpenses : null;
  const grossProfit = hasCostData && totalCost != null ? salePrice - totalCost : null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-slate-700 p-3 text-sm">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        <Info className="h-3.5 w-3.5" />
        {t("VehicleCostBreakdown" as any)}
      </div>

      <div className="space-y-1">
        {hasCostData ? (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("PurchasePrice" as any)}</span>
              <span className="tabular-nums font-medium">{formatCurrency(purchasePrice!)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("TotalExpenses" as any)}</span>
              <span className="tabular-nums font-medium text-amber-600">
                {totalExpenses > 0 ? `+ ${formatCurrency(totalExpenses)}` : formatCurrency(0)}
              </span>
            </div>
            <div className="flex justify-between border-t pt-1 mt-1">
              <span className="font-semibold">{t("TotalCost" as any)}</span>
              <span className="tabular-nums font-semibold">{formatCurrency(totalCost!)}</span>
            </div>
            {grossProfit != null && (
              <div className="flex justify-between pt-0.5">
                <span className="text-muted-foreground">{t("Profit" as any)}</span>
                <span
                  className={`tabular-nums font-semibold flex items-center gap-1 ${
                    grossProfit >= 0 ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {grossProfit >= 0
                    ? <TrendingUp className="h-3 w-3" />
                    : <TrendingDown className="h-3 w-3" />}
                  {formatCurrency(Math.abs(grossProfit))}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("TotalExpenses" as any)}</span>
            <span className="tabular-nums font-medium text-amber-600">
              {totalExpenses > 0 ? `+ ${formatCurrency(totalExpenses)}` : formatCurrency(0)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
