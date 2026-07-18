"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { downloadVehicleSheet, type VehicleSheetRow } from "@/components/vehicles/vehicleSheet";

/**
 * Exports the whole vehicle inventory into the dealership's canonical import
 * template, so the same file can be re-imported into this — or a brand-new —
 * dealer account with no manual column remapping.
 *
 * Data is fetched on click (imperative query) rather than subscribed, so opening
 * the vehicles page never pulls the entire inventory just to keep this button
 * enabled.
 */
export function VehicleExportButton() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const convex = useConvex();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (!activeOrgId || exporting) return;
    setExporting(true);
    const toastId = toast.loading(t("ExportingVehicles" as any));
    try {
      const data = await convex.query(api.vehicles.exportData, { orgId: activeOrgId });

      if (data.vehicles.length === 0) {
        toast.error(t("ExportNoVehicles" as any), { id: toastId });
        return;
      }

      const rows: VehicleSheetRow[] = data.vehicles.map((vehicle) => ({
        make: vehicle.make,
        vin: vehicle.vin,
        color: vehicle.color,
        mileage: vehicle.mileage,
        cost: vehicle.cost,
        model: vehicle.model,
        year: vehicle.year,
        sellingPrice: vehicle.sellingPrice,
        sourceType: vehicle.sourceType,
        sourcedFrom: vehicle.sourcedFrom,
        valuationsByCompany: Object.fromEntries(
          vehicle.valuations.map((valuation) => [valuation.companyName, valuation.amount])
        ),
      }));

      const today = new Date().toISOString().slice(0, 10);
      await downloadVehicleSheet({
        fileName: `vehicle_export_${today}.xlsx`,
        companyNames: data.valuationCompanyNames,
        rows,
      });

      toast.success(t("ExportVehiclesSuccess" as any), { id: toastId });
    } catch (error) {
      console.error("Vehicle export failed:", error);
      toast.error(t("ExportVehiclesFailed" as any), { id: toastId });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button variant="outline" onClick={handleExport} disabled={exporting || !activeOrgId}>
      <Download className="me-2 h-4 w-4" />
      {exporting ? t("ExportingVehicles" as any) : t("ExportVehicles" as any)}
    </Button>
  );
}
