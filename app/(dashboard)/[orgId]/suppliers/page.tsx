import { Suspense } from "react";
import { SuppliersClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export default function SuppliersPage() {
  return (
    <RoleGuard permissions={["view:finance"]}>
      <Suspense>
        <SuppliersClient />
      </Suspense>
    </RoleGuard>
  );
}
