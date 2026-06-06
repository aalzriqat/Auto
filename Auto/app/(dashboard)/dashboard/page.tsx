"use client";

import { useState } from "react";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { Car, Users, Target, BadgeDollarSign, TrendingUp, Shield, CheckCircle2, Clock, AlertCircle } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function DashboardPage() {
  const { activeOrgId } = useOrg();
  const [timeRange, setTimeRange] = useState<"DAY" | "MONTH" | "YEAR" | "ALL_TIME">("MONTH");

  // If no org is active, the wrapper layout handles it (Onboarding)
  // But we still pass activeOrgId conditionally to avoid Convex errors
  const stats = useQuery(
    api.dashboard.stats,
    activeOrgId ? { orgId: activeOrgId, timeRange } : "skip"
  );

  const myMembership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  if (myMembership === undefined) {
    return <div className="p-8 text-center text-muted-foreground">Loading dashboard...</div>;
  }

  if (myMembership && !myMembership.permissions.includes("manage:users")) {
    return (
      <div className="flex flex-col items-center justify-center h-[50vh] space-y-4 text-center">
        <Shield className="h-12 w-12 text-muted-foreground opacity-50" />
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Access Restricted</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            You do not have permission to view the dealership dashboard. Please contact your manager if you need access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground">
            Welcome to your dealership overview.
          </p>
        </div>
        
        <Select value={timeRange} onValueChange={(val: any) => setTimeRange(val)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Select time range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DAY">Today</SelectItem>
            <SelectItem value="MONTH">This Month</SelectItem>
            <SelectItem value="YEAR">This Year</SelectItem>
            <SelectItem value="ALL_TIME">All Time</SelectItem>
          </SelectContent>
        </Select>
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
            <h3 className="tracking-tight text-sm font-medium">
              Sales {timeRange === "DAY" ? "(Today)" : timeRange === "MONTH" ? "(30d)" : timeRange === "YEAR" ? "(1y)" : "(All)"}
            </h3>
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
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
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
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
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
                    <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Team Activity and Tasks */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        
        {/* Task Overview */}
        <div className="rounded-xl border bg-card text-card-foreground shadow col-span-2">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="space-y-1">
              <h3 className="font-semibold leading-none tracking-tight">Task Overview</h3>
              <p className="text-sm text-muted-foreground">System-wide status</p>
            </div>
          </div>
          <div className="p-6 pt-0 space-y-4">
            {stats === undefined ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <>
                <div className="flex items-center p-3 border rounded-lg bg-red-500/10 text-red-600 border-red-500/20">
                  <AlertCircle className="h-5 w-5 mr-3" />
                  <div className="flex-1 font-medium">Overdue</div>
                  <div className="text-xl font-bold">{stats.taskStats?.overdue || 0}</div>
                </div>
                <div className="flex items-center p-3 border rounded-lg bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
                  <Clock className="h-5 w-5 mr-3" />
                  <div className="flex-1 font-medium">Pending</div>
                  <div className="text-xl font-bold">{stats.taskStats?.pending || 0}</div>
                </div>
                <div className="flex items-center p-3 border rounded-lg bg-green-500/10 text-green-600 border-green-500/20">
                  <CheckCircle2 className="h-5 w-5 mr-3" />
                  <div className="flex-1 font-medium">Completed</div>
                  <div className="text-xl font-bold">{stats.taskStats?.completed || 0}</div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Team Activity Board */}
        <div className="rounded-xl border bg-card text-card-foreground shadow col-span-5">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="space-y-1">
              <h3 className="font-semibold leading-none tracking-tight">Team Activity Board</h3>
              <p className="text-sm text-muted-foreground">Task breakdown by team member</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-[200px] w-full mt-4" />
            ) : stats.teamTasks?.length === 0 ? (
              <div className="h-[200px] w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg mt-4">
                No tasks assigned to team members
              </div>
            ) : (
              <div className="mt-4">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50 rounded-t-lg">
                    <tr>
                      <th className="px-4 py-3 rounded-tl-lg">Team Member</th>
                      <th className="px-4 py-3 text-center">Pending</th>
                      <th className="px-4 py-3 text-center">Overdue</th>
                      <th className="px-4 py-3 text-center rounded-tr-lg">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.teamTasks.map((member: any) => (
                      <tr key={member.name} className="border-b last:border-0">
                        <td className="px-4 py-3 font-medium">{member.name || "Unassigned"}</td>
                        <td className="px-4 py-3 text-center text-yellow-600 font-semibold">{member.pending}</td>
                        <td className="px-4 py-3 text-center">
                          {member.overdue > 0 ? (
                            <span className="bg-destructive/10 text-destructive px-2 py-1 rounded-md font-semibold">
                              {member.overdue}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center text-green-600 font-semibold">{member.completed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
