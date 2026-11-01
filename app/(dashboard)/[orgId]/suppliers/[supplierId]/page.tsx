import { Suspense } from "react";
import { SupplierDetailClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export default async function SupplierDetailPage({ params }: Readonly<{ params: Promise<{ supplierId: string }> }>) {
  const { supplierId } = await params;
  return (
    <RoleGuard permissions={["view:finance"]}>
      <Suspense>
        <SupplierDetailClient supplierId={supplierId} />
      </Suspense>
    </RoleGuard>
  );
}
