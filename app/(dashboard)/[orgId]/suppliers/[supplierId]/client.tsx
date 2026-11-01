"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { SupplierDetailScreen } from "@/components/suppliers/management/SupplierDetailScreen";

export function SupplierDetailClient({ supplierId }: Readonly<{ supplierId: string }>) {
  const { activeOrgId } = useOrg();
  if (!activeOrgId) return null;
  return <SupplierDetailScreen orgId={activeOrgId} supplierId={supplierId as Id<"suppliers">} />;
}
