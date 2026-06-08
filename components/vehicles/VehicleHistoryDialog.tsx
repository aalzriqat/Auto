"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
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

        <ScrollArea className="flex-1 pr-4 -mr-4 mt-4">
          {history === undefined ? (
            <div className="text-center py-8 text-muted-foreground">{t("LoadingHistory" as any)}</div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">{t("NoEditHistory" as any) || "No edit history found for this vehicle."}</div>
          ) : (
            <div className="space-y-6">
              {history.map((edit) => (
                <div key={edit._id} className="relative pl-6 pb-2 border-l-2 last:border-0 border-muted">
                  <div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full bg-background border-2 border-primary" />
                  
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={edit.type === "CREATE" ? "default" : "secondary"}>
                        {edit.type}
                      </Badge>
                      <span className="text-sm font-medium">{edit.requestedByName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {rtfDate.format(new Date(edit.createdAt))}
                    </span>
                  </div>

                  <div className="bg-muted/30 p-3 rounded-md text-sm mb-3">
                    <h4 className="font-medium text-xs text-muted-foreground mb-2 uppercase tracking-wider">{t("PayloadChanges" as any) || "Payload Changes"}</h4>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                      {Object.entries(edit.payload || {}).map(([key, value]) => {
                        if (key === "imageIds") return null;
                        return (
                          <li key={key} className="flex justify-between items-center py-0.5 border-b border-border/50 last:border-0">
                            <span className="text-muted-foreground capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>
                            <span className="font-medium truncate max-w-[150px]" title={String(value)}>
                              {String(value) || "N/A"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant={
                      edit.status === "APPROVED" ? "default" : 
                      edit.status === "REJECTED" ? "destructive" : 
                      "outline"
                    } className={edit.status === "APPROVED" ? "bg-green-600" : ""}>
                      {edit.status}
                    </Badge>
                    {edit.status !== "PENDING" && edit.resolvedByName && (
                      <span className="text-muted-foreground text-xs">
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
