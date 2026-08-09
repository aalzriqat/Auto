"use client";

import { useParams } from "next/navigation";
import { useOrg } from "@/components/providers/OrgProvider";
import type { Id } from "@/convex/_generated/dataModel";
import { DealCockpit } from "@/components/applications/cockpit/DealCockpit";
import { Skeleton } from "@/components/ui/skeleton";

export function DealCockpitClient() {
  const { activeOrgId } = useOrg();
  const params = useParams<{ applicationId: string }>();
  const applicationId = params?.applicationId;

  // `activeOrgId` is withheld until a live membership query confirms the caller
  // actually belongs to the org in the URL, so rendering before it arrives would
  // query on a tenancy nobody has verified yet.
  if (!activeOrgId || !applicationId) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <DealCockpit
      orgId={activeOrgId as Id<"organizations">}
      applicationId={applicationId as Id<"financeApplications">}
    />
  );
}
