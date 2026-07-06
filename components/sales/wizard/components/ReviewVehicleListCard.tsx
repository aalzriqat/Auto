"use client";

import { Doc } from "@/convex/_generated/dataModel";
import { Car } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface ReviewVehicleListCardProps {
  vehicles: Array<{ vehicle: Doc<"vehicles">; unitPrice: number }>;
  className?: string;
}

/** Multi-vehicle counterpart to ReviewVehicleCard — used when a CASH quote covers 2+ vehicles. */
export default function ReviewVehicleListCard({ vehicles, className }: ReviewVehicleListCardProps) {
  const { t } = useLanguage();
  const total = vehicles.reduce((sum, { unitPrice }) => sum + unitPrice, 0);

  return (
    <div className={cn("rounded-xl border bg-muted/20 p-4 space-y-3", className)}>
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <Car className="w-3.5 h-3.5" />
        {t("Vehicle" as any)} ({vehicles.length})
      </div>

      <div className="space-y-2">
        {vehicles.map(({ vehicle, unitPrice }) => (
          <div key={vehicle._id} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium truncate">
                {vehicle.year} {vehicle.make} {vehicle.model}
                {vehicle.trim ? ` ${vehicle.trim}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">{vehicle.vin}</p>
            </div>
            <span className="font-semibold shrink-0">
              {unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-baseline justify-between gap-2 border-t pt-2">
        <span className="text-xs text-muted-foreground">{t("TotalVehiclesCount" as any) ?? "Total"}</span>
        <span className="text-lg font-bold">
          {total.toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}
        </span>
      </div>
    </div>
  );
}
