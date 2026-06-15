"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";

// Returns orgSettings row (or null while loading / not set)
export function useOrgSettings() {
  const { activeOrgId } = useOrg();
  return useQuery(
    api.orgSettings.get,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
}
