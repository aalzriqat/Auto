"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";
import { useOrg } from "@/components/providers/OrgProvider";
import { SupplierBalancesScreen } from "@/components/suppliers/management/SupplierBalancesScreen";

export default function SupplierBalancesPage() {
  const { activeOrgId } = useOrg();
  return <RoleGuard permissions={["view:finance"]}>{activeOrgId && <SupplierBalancesScreen orgId={activeOrgId} />}</RoleGuard>;
}
