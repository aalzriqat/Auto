"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMoneyDisplay } from "@/hooks/useMoneyDisplay";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Info, Eye, EyeOff } from "lucide-react";

interface VehicleCostBarProps {
  vehicleId: string;
  purchasePrice: number | null | undefined;
}

export function VehicleCostBar({ vehicleId, purchasePrice }: VehicleCostBarProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format: formatCurrency } = useMoneyDisplay();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [isRevealed, setIsRevealed] = useState(false);

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
  // No org means the total is never asked for: a skeleton would never resolve.
  if (!activeOrgId) return null;
  // Hold the collapsed panel's height while the total loads, so the inputs
  // below do not jump when it arrives (SCRUM-628 F-06).
  if (totalExpenses === undefined) {
    return (
      <div
        data-testid="vehicle-cost-bar-loading"
        aria-busy="true"
        className="rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-slate-700 p-3 text-sm"
      >
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <div className="h-4 w-40 rounded bg-slate-200 dark:bg-slate-700 animate-pulse motion-reduce:animate-none" />
        </div>
      </div>
    );
  }

  // SCRUM-55: this panel shows the two stored inputs only. It used to add them up as "Total Cost" and subtract from the sale price as "Profit", but `totalByVehicle` is every vehicle expense at its gross amount, while the books cost the vehicle from landed cost plus only the capitalized net expenses. A second profit formula in the client disagreed with the ledger (owner 2026-10-08, SCRUM-795 c22479); the authoritative margin lives in accounting, not here.
  const hasCostData = purchasePrice != null;



  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-slate-700 p-3 text-sm">
      <div className="flex items-center justify-between gap-1.5 mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          <Info className="h-3.5 w-3.5" />
          {t("VehicleCostBreakdown" as any)}
        </div>
        <button
          type="button"
          onClick={() => setIsRevealed((v) => !v)}
          title={t((isRevealed ? "HideCostBreakdown" : "ShowCostBreakdown") as any)}
          aria-label={t((isRevealed ? "HideCostBreakdown" : "ShowCostBreakdown") as any)}
          aria-pressed={isRevealed}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      {isRevealed && (
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
                  {formatCurrency(totalExpenses)}
                </span>
              </div>
            </>
          ) : (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("TotalExpenses" as any)}</span>
              <span className="tabular-nums font-medium text-amber-600">
                {formatCurrency(totalExpenses)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
