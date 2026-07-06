"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import VehiclePicker, { type SourceVehicleData } from "./VehiclePicker";
import type { VehicleLineItem } from "../types";

interface VehicleLineItemsPickerProps {
  vehicles: any[] | undefined;
  nonSelectableVehicles?: any[];
  items: VehicleLineItem[];
  onChange: (items: VehicleLineItem[]) => void;
  onSourceVehicle?: (data: SourceVehicleData) => Promise<string>;
}

/**
 * Wraps the existing single-vehicle VehiclePicker to let a CASH quote cover
 * multiple vehicles (or several units of the same model — each its own
 * inventory row/VIN). Each row is its own independent VehiclePicker instance;
 * "quantity" of one model is achieved by adding that model's other units as
 * separate rows, since inventory is tracked per-VIN.
 */
export function VehicleLineItemsPicker({
  vehicles,
  nonSelectableVehicles,
  items,
  onChange,
  onSourceVehicle,
}: VehicleLineItemsPickerProps) {
  const { t } = useLanguage();
  const currency = useCurrency();

  const selectedIds = new Set(items.map((item) => item.vehicleId).filter(Boolean));

  const updateItem = (index: number, vehicleId: string, unitPrice: number) => {
    const next = [...items];
    next[index] = { vehicleId, unitPrice };
    onChange(next);
  };

  const addItem = () => onChange([...items, { vehicleId: "", unitPrice: 0 }]);
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));

  const total = items.reduce((sum, item) => sum + (item.unitPrice || 0), 0);

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="flex-1">
            <VehiclePicker
              vehicles={vehicles?.filter((v) => !selectedIds.has(v._id) || v._id === item.vehicleId)}
              nonSelectableVehicles={nonSelectableVehicles}
              value={item.vehicleId}
              onChange={(id, price) => updateItem(index, id, price)}
              onSourceVehicle={onSourceVehicle}
            />
          </div>
          {items.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeItem(index)}
              className="mt-0.5 shrink-0"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </Button>
          )}
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addItem} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" />
        {t("AddAnotherVehicle" as any) ?? "Add another vehicle"}
      </Button>

      {items.length > 1 && (
        <div className="flex justify-between items-center rounded-lg border border-teal-500/30 bg-teal-500/5 px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">
            {t("TotalVehiclesCount" as any) ?? "Total"} ({items.length})
          </span>
          <span className="font-bold">{currency.format(total)}</span>
        </div>
      )}
    </div>
  );
}
