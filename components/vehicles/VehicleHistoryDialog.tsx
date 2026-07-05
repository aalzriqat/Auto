"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface VehicleHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle: Doc<"vehicles"> | null;
}

// Maps vehicleEdits payload keys to existing i18n label keys, so the
// audit trail shows translated field names instead of raw camelCase.
const PAYLOAD_FIELD_LABEL_KEYS: Record<string, string> = {
  vin: "VIN",
  make: "Make",
  model: "Model",
  year: "Year",
  trim: "Trim",
  mileage: "Mileage",
  color: "Color",
  fuelType: "FuelType",
  transmission: "Transmission",
  purchasePrice: "PurchasePrice",
  minimumProfit: "MinimumProfit",
  sellingPrice: "SellingPrice",
  status: "Status",
  sourceType: "VehicleSource",
  sourcedFromName: "SourceDealerName",
  sourceCost: "SupplierCost",
  notes: "Notes",
};

export function VehicleHistoryDialog({ open, onOpenChange, vehicle }: VehicleHistoryDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const history = useQuery(
    api.vehicleEdits.getHistory,
    activeOrgId && vehicle ? { orgId: activeOrgId, vehicleId: vehicle._id } : "skip"
  );

  const rtfDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("VehicleAuditTrail" as any) || "Vehicle Audit Trail"}</DialogTitle>
          <DialogDescription>
            {vehicle?.year} {vehicle?.make} {vehicle?.model} (VIN: {vehicle?.vin})
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pe-4 -me-4 mt-4">
          {history === undefined ? (
            <div className="text-center py-8 text-muted-foreground">{t("LoadingHistory" as any)}</div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">{t("NoEditHistory" as any) || "No edit history found for this vehicle."}</div>
          ) : (
            <div className="space-y-6">
              {history.map((edit: Doc<"vehicleEdits"> & { requestedByName: string; resolvedByName?: string }) => (
                <div key={edit._id} className="relative ps-6 pb-2 border-s-2 last:border-0 border-muted">
                  <div className="absolute -start-[9px] top-1 h-4 w-4 rounded-full bg-background border-2 border-primary" />
                  
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <Badge variant={edit.type === "CREATE" ? "default" : "secondary"} className="shrink-0">
                        {edit.type}
                      </Badge>
                      <span className="text-sm font-medium truncate" title={edit.requestedByName}>{edit.requestedByName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {rtfDate.format(new Date(edit.createdAt))}
                    </span>
                  </div>

                  <div className="bg-muted/30 p-3 rounded-md text-sm mb-3">
                    <h4 className="font-medium text-xs text-muted-foreground mb-2 uppercase tracking-wider">{t("PayloadChanges" as any) || "Payload Changes"}</h4>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                      {Object.entries(edit.payload || {}).map(([key, value]) => {
                        if (key === "imageIds") return null;
                        const labelKey = PAYLOAD_FIELD_LABEL_KEYS[key];
                        const label = labelKey ? t(labelKey as any) : key.replace(/([A-Z])/g, ' $1').trim();
                        return (
                          <li key={key} className="flex justify-between items-center gap-2 py-0.5 border-b border-border/50 last:border-0">
                            <span className="text-muted-foreground shrink-0">{label}:</span>
                            <span className="font-medium truncate max-w-[150px]" title={String(value)}>
                              {String(value) || "N/A"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={
                      edit.status === "APPROVED" ? "default" :
                      edit.status === "REJECTED" ? "destructive" :
                      "outline"
                    } className={edit.status === "APPROVED" ? "bg-green-600 shrink-0" : "shrink-0"}>
                      {edit.status}
                    </Badge>
                    {edit.status !== "PENDING" && edit.resolvedByName && (
                      <span className="text-muted-foreground text-xs min-w-0 truncate" title={`${edit.resolvedByName} — ${rtfDate.format(new Date(edit.resolvedAt!))}`}>
                        {t("ByReq" as any) || "by"} {edit.resolvedByName} {t("On" as any) || "on"} {rtfDate.format(new Date(edit.resolvedAt!))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
