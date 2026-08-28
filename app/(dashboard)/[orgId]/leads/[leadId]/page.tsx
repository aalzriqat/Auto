"use client";

import { useParams } from "next/navigation";

import { RoleGuard } from "@/components/auth/RoleGuard";
import { LeadWorkspace } from "@/components/leads/LeadWorkspace";
import { Id } from "@/convex/_generated/dataModel";

export default function LeadWorkspacePage() {
  const params = useParams<{ leadId: string }>();

  return (
    <RoleGuard permissions={["view:leads"]}>
      <LeadWorkspace leadId={params.leadId as Id<"leads">} />
    </RoleGuard>
  );
}
