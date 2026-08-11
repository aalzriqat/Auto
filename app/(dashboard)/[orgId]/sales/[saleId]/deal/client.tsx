"use client";

import { useParams } from "next/navigation";
import { useOrg } from "@/components/providers/OrgProvider";
import type { Id } from "@/convex/_generated/dataModel";
import { CashDealCockpit } from "@/components/applications/cockpit/DealCockpit";
import { Skeleton } from "@/components/ui/skeleton";

export function CashDealCockpitClient() {
  const { activeOrgId } = useOrg();
  const params = useParams<{ saleId: string }>();
  const saleId = params?.saleId;

  // `activeOrgId` is withheld until a live membership query confirms the caller
  // actually belongs to the org in the URL, so rendering before it arrives would
  // query on a tenancy nobody has verified yet.
  if (!activeOrgId || !saleId) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <CashDealCockpit
      orgId={activeOrgId as Id<"organizations">}
      saleId={saleId as Id<"sales">}
    />
  );
}
