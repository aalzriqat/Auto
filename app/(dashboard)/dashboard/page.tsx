"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { Car, Users, Target, BadgeDollarSign } from "lucide-react";

export default function DashboardPage() {
  const { activeOrgId } = useOrg();

  // If no org is active, the wrapper layout handles it (Onboarding)
  // But we still pass activeOrgId conditionally to avoid Convex errors
  const stats = useQuery(
    api.dashboard.stats,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          Welcome to your dealership overview.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Vehicles Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Vehicles</h3>
            <Car className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats.totalVehicles}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats.availableVehicles} available
                </p>
              </>
            )}
          </div>
        </div>

        {/* Leads Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Active Leads</h3>
            <Target className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{stats.activeLeads}</div>
            )}
          </div>
        </div>

        {/* Sales Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Sales (30d)</h3>
            <BadgeDollarSign className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats.salesThisMonth}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  ${stats.salesVolumeThisMonth.toLocaleString()} volume
                </p>
              </>
            )}
          </div>
        </div>

        {/* Team Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Team Members</h3>
            <Users className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{stats.teamMembers}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
