import { Suspense } from "react";
import { SourcingClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export default function SourcingPage() {
  return (
    <RoleGuard permissions={["view:finance"]}>
      <Suspense>
        <SourcingClient />
      </Suspense>
    </RoleGuard>
  );
}
