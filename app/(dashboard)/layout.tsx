"use client";

// This layout exists solely to keep the `listMine` Convex subscription alive
// across all navigations within the dashboard route group.  Without it, the
// subscription is torn down when DashboardEntryPage unmounts (on redirect to
// /{orgId}/...) and re-created cold inside OrgProvider — causing a visible
// spinner while the query round-trips again.  With this layout persisted as a
// parent route, the Convex reactive cache stays warm and OrgProvider's
// useQuery returns immediately on first render.
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export default function DashboardGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated } = useConvexAuth();
  // Subscribe but don't render — this is a cache-warming subscription only.
  useQuery(api.organizations.listMine, isAuthenticated ? undefined : "skip");
  return <>{children}</>;
}
