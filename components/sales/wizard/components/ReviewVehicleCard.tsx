"use client";

import { Doc } from "@/convex/_generated/dataModel";
import { Car, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMoneyDisplay } from "@/hooks/useMoneyDisplay";
import { VehicleCostBar } from "./VehicleCostBar";

interface ReviewVehicleCardProps {
  vehicle: Doc<"vehicles">;
  basePrice: number;
  desiredProfit?: number;
  className?: string;
}

export default function ReviewVehicleCard({
  vehicle,
  basePrice,
  desiredProfit = 0,
  className,
}: ReviewVehicleCardProps) {
  const { t } = useLanguage();
  const money = useMoneyDisplay();
  const effectivePrice = basePrice + desiredProfit;

  return (
    <div className={cn("rounded-xl border bg-muted/20 p-4 space-y-3", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <Car className="w-3.5 h-3.5" />
        {t("Vehicle" as any)}
      </div>

      {/* Vehicle name */}
      <div>
        <p className="font-semibold text-base">
          {vehicle?.year} {vehicle?.make} {vehicle?.model}
          {vehicle?.trim ? ` ${vehicle?.trim}` : ""}
        </p>
        <p className="text-sm text-muted-foreground">{vehicle?.vin}</p>
      </div>

      {/* Pricing */}
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold">
            {money.format(basePrice ?? 0)}
          </span>
          <span className="text-xs text-muted-foreground">{t("BasePrice" as any)}</span>
        </div>

        {desiredProfit > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <TrendingUp className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-indigo-300">
              + {money.format(desiredProfit)} {t("DealerProfit" as any)} →{" "}
              <strong>{money.format(effectivePrice)}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Cost breakdown — only rendered once vehicle data is available */}
      {vehicle && (
        <VehicleCostBar
          vehicleId={vehicle._id}
          purchasePrice={vehicle.purchasePrice}
        />
      )}
    </div>
  );
}