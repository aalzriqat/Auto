"use client";

import { useState } from "react";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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
  const { t } = useLanguage();
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
    return <div className="p-8 text-center text-muted-foreground">{t("Loading" as any) || "Loading dashboard..."}</div>;
  }

  if (myMembership && !myMembership.permissions.includes("manage:users")) {
    return (
      <div className="flex flex-col items-center justify-center h-[50vh] space-y-4 text-center">
        <Shield className="h-12 w-12 text-muted-foreground opacity-50" />
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">{t("AccessRestricted" as any)}</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            {t("NoPermissionDashboard" as any)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t("Dashboard")}</h2>
          <p className="text-muted-foreground">
            {t("Overview")}
          </p>
        </div>
        
        <Select value={timeRange} onValueChange={(val: any) => setTimeRange(val)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={t("SelectTimeRange" as any)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DAY">{t("Today" as any)}</SelectItem>
            <SelectItem value="MONTH">{t("ThisMonth" as any)}</SelectItem>
            <SelectItem value="YEAR">{t("ThisYear" as any)}</SelectItem>
            <SelectItem value="ALL_TIME">{t("AllTime" as any)}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Vehicles Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t("Vehicles")}</h3>
            <Car className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats.totalVehicles}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats.availableVehicles} {t("AvailableLC" as any)}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Leads Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t("ActiveLeads" as any)}</h3>
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
              {t("Sales")} {timeRange === "DAY" ? `(${t("Today" as any)})` : timeRange === "MONTH" ? "(30d)" : timeRange === "YEAR" ? "(1y)" : `(${t("AllTime" as any)})`}
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
                  {stats.salesVolumeThisMonth.toLocaleString()} JOD {t("VolumeLC" as any)}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Team Card */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t("TeamMembers" as any)}</h3>
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
              <h3 className="font-semibold leading-none tracking-tight">{t("Revenue")}</h3>
              <p className="text-sm text-muted-foreground">{t("Overview")}</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            <div className="h-[300px] w-full mt-4">
              {stats === undefined ? (
                <Skeleton className="h-full w-full" />
              ) : stats.salesTrend?.length === 0 ? (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg">
                  {t("NoSalesData" as any)}
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
                      tickFormatter={(value) => `${value} JOD`}
                    />
                    <Tooltip 
                      formatter={(value: any) => [`${Number(value).toLocaleString()} JOD`, t("Revenue")]}
                      contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151", color: "#f3f4f6" }}
                    />
                    <Area type="monotone" dataKey="Revenue" name={t("Revenue" as any)} stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow col-span-3">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="space-y-1">
              <h3 className="font-semibold leading-none tracking-tight">{t("ProfitTracking" as any)}</h3>
              <p className="text-sm text-muted-foreground">{t("RevenueVsProfit" as any)}</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            <div className="h-[300px] w-full mt-4">
              {stats === undefined ? (
                <Skeleton className="h-full w-full" />
              ) : stats.salesTrend?.length === 0 ? (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg">
                  {t("NoProfitData" as any)}
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
                      tickFormatter={(value) => `${value} JOD`}
                    />
                    <Tooltip 
                      formatter={(value: any) => [`${Number(value).toLocaleString()} JOD`, undefined]}
                      contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151", color: "#f3f4f6" }}
                    />
                    <Legend />
                    <Bar dataKey="Revenue" name={t("Revenue" as any)} fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Profit" name={t("Profit" as any)} fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Expenses" name={t("Expenses" as any)} fill="#ef4444" radius={[4, 4, 0, 0]} />
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
              <h3 className="font-semibold leading-none tracking-tight">{t("TaskOverview" as any)}</h3>
              <p className="text-sm text-muted-foreground">{t("SystemWideStatus" as any)}</p>
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
                  <div className="flex-1 font-medium">{t("Overdue" as any)}</div>
                  <div className="text-xl font-bold">{stats.taskStats?.overdue || 0}</div>
                </div>
                <div className="flex items-center p-3 border rounded-lg bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
                  <Clock className="h-5 w-5 mr-3" />
                  <div className="flex-1 font-medium">{t("Pending" as any)}</div>
                  <div className="text-xl font-bold">{stats.taskStats?.pending || 0}</div>
                </div>
                <div className="flex items-center p-3 border rounded-lg bg-green-500/10 text-green-600 border-green-500/20">
                  <CheckCircle2 className="h-5 w-5 mr-3" />
                  <div className="flex-1 font-medium">{t("Completed" as any)}</div>
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
              <h3 className="font-semibold leading-none tracking-tight">{t("TeamActivityBoard" as any)}</h3>
              <p className="text-sm text-muted-foreground">{t("TaskBreakdown" as any)}</p>
            </div>
          </div>
          <div className="p-6 pt-0">
            {stats === undefined ? (
              <Skeleton className="h-[200px] w-full mt-4" />
            ) : stats.teamTasks?.length === 0 ? (
              <div className="h-[200px] w-full flex items-center justify-center text-muted-foreground border border-dashed rounded-lg mt-4">
                {t("NoTasksAssigned" as any)}
              </div>
            ) : (
              <div className="mt-4">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50 rounded-t-lg">
                    <tr>
                      <th className="px-4 py-3 rounded-tl-lg">{t("TeamMember" as any)}</th>
                      <th className="px-4 py-3 text-center">{t("Pending" as any)}</th>
                      <th className="px-4 py-3 text-center">{t("Overdue" as any)}</th>
                      <th className="px-4 py-3 text-center rounded-tr-lg">{t("Completed" as any)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.teamTasks.map((member: any) => (
                      <tr key={member.name} className="border-b last:border-0">
                        <td className="px-4 py-3 font-medium">{member.name || t("Unassigned" as any)}</td>
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
