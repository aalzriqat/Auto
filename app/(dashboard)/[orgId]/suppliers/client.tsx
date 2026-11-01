"use client";

import { useOrg } from "@/components/providers/OrgProvider";
import { SupplierListScreen } from "@/components/suppliers/management/SupplierListScreen";

export function SuppliersClient() {
  const { activeOrgId } = useOrg();
  if (!activeOrgId) return null;
  return <SupplierListScreen orgId={activeOrgId} />;
}
