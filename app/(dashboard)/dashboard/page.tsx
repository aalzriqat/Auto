"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { Car, Users, Target, BadgeDollarSign, TrendingUp } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";

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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <div className="rounded-xl border bg-card text-card-foreground shadow col-span-4">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="space-y-1">
              <h3 className="font-semibold leading-none tracking-tight">Revenue Overview</h3>
              <p className="text-sm text-muted-foreground">Monthly revenue trend</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            <div className="h-[300px] w-full mt-4">
              {stats === undefined ? (
                <Skeleton className="h-full w-full" />
              ) : stats.salesTrend?.length === 0 ? (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg">
                  No sales data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.salesTrend}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#333" />
                    <XAxis dataKey="name" stroke="#888" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis 
                      stroke="#888" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip 
                      formatter={(value: any) => [`$${Number(value).toLocaleString()}`, "Revenue"]}
                      contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151", color: "#f3f4f6" }}
                    />
                    <Area type="monotone" dataKey="Revenue" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow col-span-3">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="space-y-1">
              <h3 className="font-semibold leading-none tracking-tight">Profit Tracking</h3>
              <p className="text-sm text-muted-foreground">Revenue vs Profit</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            <div className="h-[300px] w-full mt-4">
              {stats === undefined ? (
                <Skeleton className="h-full w-full" />
              ) : stats.salesTrend?.length === 0 ? (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg">
                  No profit data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.salesTrend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#333" />
                    <XAxis dataKey="name" stroke="#888" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis 
                      stroke="#888" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip 
                      formatter={(value: any) => [`$${Number(value).toLocaleString()}`, undefined]}
                      contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151", color: "#f3f4f6" }}
                    />
                    <Legend />
                    <Bar dataKey="Revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Profit" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
