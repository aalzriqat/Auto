"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { DealQueueView, type DealQueueViewKey } from "@/components/deals/DealQueueView";
import { useNow } from "@/lib/deals/useNow";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The data half: one query, no presentation.
 *
 * Split from the view so the screen can be rendered against server-shaped
 * fixtures — the same reason `DealCockpit` is split from `DealCockpitView`.
 * Bidi and RTL behaviour is only checkable on rendered output, and a component
 * welded to `useQuery` can only be rendered against whatever happens to be in a
 * deployment.
 */
export function DealQueueClient() {
  const { activeOrgId } = useOrg();
  const [view, setView] = useState<DealQueueViewKey>("NEEDS_ATTENTION");
  const now = useNow();

  const data = useQuery(api.deals.queue, activeOrgId ? { orgId: activeOrgId, view } : "skip");

  // `activeOrgId` is withheld until a live membership query confirms the caller
  // actually belongs to the org in the URL, so rendering before it arrives would
  // query on a tenancy nobody has verified yet.
  if (!activeOrgId) return <Skeleton className="h-64 w-full" />;

  return <DealQueueView data={data} view={view} onViewChange={setView} now={now} />;
}
