"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePermissions } from "@/hooks/use-permissions";
import { VehicleDetailsDialog } from "@/components/vehicles/VehicleDetailsDialog";
import { QueryErrorBoundary, useTranslate } from "./shared";
import { SupplierRelationshipsError } from "./SupplierRelationshipsSection";

function VehicleTargetBody({ orgId, recordId }: Readonly<{ orgId: Id<"organizations">; recordId: string }>) {
  const [open, setOpen] = useState(true);
  const { hasPermission, isLoading } = usePermissions();
  const translate = useTranslate();
  const allowed = !isLoading && hasPermission("view:vehicles");
  // The existing public reader validates the id and enforces tenancy and cost redaction.
  const vehicle = useQuery(api.vehicles.get, allowed && open ? { orgId, vehicleId: recordId as Id<"vehicles"> } : "skip");
  if (!allowed || !open) return null;
  if (vehicle === undefined) return <output className="block p-3 text-sm">{translate("SuppliersRelationshipsLoading")}</output>;
  if (!vehicle) return <SupplierRelationshipsError />;
  return <VehicleDetailsDialog vehicle={vehicle} open={open} onOpenChange={setOpen} canViewPurchasePrice={hasPermission("view:cost_price")} />;
}

/** Supplier links open one exact record without walking the inventory's paginated list. */
export function SupplierVehicleTarget({ orgId }: Readonly<{ orgId: Id<"organizations"> | null }>) {
  const search = useSearchParams();
  const recordId = search.get("supplierVehicleId");
  if (!orgId || !recordId) return null;
  return <QueryErrorBoundary key={`${orgId}:${recordId}`} render={() => <SupplierRelationshipsError />}>
    <VehicleTargetBody orgId={orgId} recordId={recordId} />
  </QueryErrorBoundary>;
}
