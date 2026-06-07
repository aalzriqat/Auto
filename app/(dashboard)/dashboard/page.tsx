"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { Car, Filter, Search, ChevronDown, Calendar, ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";


export default function DashboardPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const [timeRange, setTimeRange] = useState<"DAY" | "MONTH" | "YEAR" | "ALL_TIME">("MONTH");
  const [currentPage, setCurrentPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const itemsPerPage = 4;

  const stats = useQuery(
    api.dashboard.stats,
    activeOrgId ? { orgId: activeOrgId, timeRange } : "skip"
  );

  const leads = useQuery(
    api.leads.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const myMembership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  if (myMembership === undefined) {
    return <div className="p-8 text-center text-muted-foreground">{t("Loading" as any) || "Loading dashboard..."}</div>;
  }

  // Fallback data mapping to match the image exactly if the real data is missing or different
  const allLeads = leads || [];
  const filteredLeads = filterStatus === "ALL"
    ? allLeads
    : allLeads.filter(l => l.stage === filterStatus);

  const totalItems = filteredLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));

  const safePage = Math.min(currentPage, totalPages);
  if (safePage !== currentPage && totalItems > 0) {
    setCurrentPage(safePage);
  }

  const paginatedLeads = filteredLeads.slice((safePage - 1) * itemsPerPage, safePage * itemsPerPage);

  const displayLeads = paginatedLeads.map(lead => ({
    name: lead.customerName,
    source: lead.source || "Website",
    status: lead.stage === "NEW" ? "New Lead" :
      lead.stage === "CONTACTED" ? "Contacted" :
        lead.stage === "INTERESTED" ? "Qualified" :
          lead.stage === "TEST_DRIVE" ? "Test Drive" :
            lead.stage === "NEGOTIATION" ? "Nurturing" :
              lead.stage === "RESERVED" ? "Reserved" :
                lead.stage === "WON" ? "WON" :
                  lead.stage === "LOST" ? "Lost" : lead.stage,
    vehicle: lead.vehicleSummary || "Unknown Vehicle",
    activity: new Date(lead._creationTime).toLocaleDateString(),
    contact: lead.phone || lead.email || "(555) 000-0000",
    avatar: lead.customerName.substring(0, 2).toUpperCase()
  }));

  const lineChartData = stats?.salesTrend?.length ? stats.salesTrend.map(t => ({ name: t.name, value: t.Revenue })) : [];
  const trendRange = (stats?.salesTrend?.length || 0) > 1
    ? `${stats!.salesTrend![0].name} - ${stats!.salesTrend![stats!.salesTrend!.length - 1].name}`
    : timeRange === "DAY" ? "Today" : timeRange === "MONTH" ? "Last 30 Days" : timeRange === "YEAR" ? "Last 12 Months" : "All Time";
  const newLeadsCount = leads?.filter(l => l.stage === "NEW").length || 0;
  const qualifiedLeadsCount = leads?.filter(l => l.stage === "INTERESTED" || l.stage === "TEST_DRIVE").length || 0;

  const donutChartData = [
    { name: t("New" as any) || "New", value: newLeadsCount, color: "#10b981" },
    { name: t("Contacted" as any) || "Contacted", value: leads?.filter(l => l.stage === "CONTACTED").length || 0, color: "#3b82f6" },
    { name: t("TestDrive" as any) || "Test Drive", value: leads?.filter(l => l.stage === "TEST_DRIVE").length || 0, color: "#f97316" },
    { name: t("Nurturing" as any) || "Negotiation", value: leads?.filter(l => l.stage === "NEGOTIATION").length || 0, color: "#eab308" },
  ].filter(d => d.value > 0);

  const finalDonutData = donutChartData;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-4 max-w-[1400px] mx-auto pb-4"
    >
      {/* Row 1: Sales Hero Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="rounded-2xl border-0 bg-gradient-to-r from-[#6b21a8] via-[#4f46e5] to-[#2563eb] text-white shadow-lg overflow-hidden relative w-full h-[220px]"
      >
        <div className="absolute inset-0 p-6 flex justify-between z-10">
          {/* Left Column */}
          <div className="flex flex-col justify-between h-full w-1/3">
            <div>
              <div className="flex items-center gap-2 mb-6 text-sm font-medium tracking-widest uppercase text-white/80">
                <span>{t("SalesOverview" as any) || "SALES OVERVIEW"}</span>
              </div>
              <p className="text-xs font-semibold tracking-wider text-white/70 mb-2 uppercase">{t("SalesPerformance" as any) || "SALES PERFORMANCE"}</p>

              <div className="flex items-baseline gap-6">
                <div>
                  <div className="text-5xl font-bold tracking-tight">
                    {(stats?.salesVolumeThisMonth || 0).toLocaleString()} <span className="text-2xl">JOD</span>
                  </div>
                  <p className="text-sm text-white/80 mt-1 flex items-center">
                    {t("Revenue" as any) || "Revenue"} <span className="ml-1 text-[#4ade80] font-medium">(+0.0%)</span>
                  </p>
                </div>
                <div>
                  <div className="text-5xl font-bold tracking-tight">{stats?.salesThisMonth || 0}</div>
                  <p className="text-sm text-white/80 mt-1">{t("VehiclesSold" as any) || "Vehicles Sold"}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold border border-white/30">
                {stats?.teamTasks?.[0]?.name ? stats.teamTasks[0].name.substring(0, 2).toUpperCase() : "SJ"}
              </div>
              <span className="text-sm font-medium text-white/90">{t("TopPerformer" as any) || "Top Performer"}: {stats?.teamTasks?.[0]?.name || "Sarah J."}</span>
            </div>
          </div>

          {/* Right Column (Graph) */}
          <div className="flex flex-col justify-between items-end h-full w-2/3">
            <Select value={timeRange} onValueChange={(val: any) => setTimeRange(val)}>
              <SelectTrigger className="w-[160px] bg-white/10 border-white/20 text-white hover:bg-white/20 rounded-lg border-0 h-9">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  <SelectValue placeholder={t("SelectTimeRange" as any)} />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAY">{t("Today" as any)}</SelectItem>
                <SelectItem value="MONTH">{t("ThisMonth" as any)}</SelectItem>
                <SelectItem value="YEAR">{t("ThisYear" as any)}</SelectItem>
                <SelectItem value="ALL_TIME">{t("AllTime" as any)}</SelectItem>
              </SelectContent>
            </Select>

            <div className="w-full h-[110px] relative">
              <div className="absolute top-0 end-10 bg-white text-slate-900 text-xs px-3 py-2 rounded-lg font-medium shadow-xl z-20">
                {t("RevenueTrend" as any) || "Revenue Trend"}<br /><span className="text-slate-500 font-normal">{trendRange}</span>
                <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-white rotate-45"></div>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineChartData} margin={{ top: 20, right: 0, left: 20, bottom: 0 }}>
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#ffffff"
                    strokeWidth={3}
                    dot={{ r: 4, fill: "#ffffff", strokeWidth: 0 }}
                    activeDot={{ r: 6, fill: "#ffffff" }}
                  />
                </LineChart>
              </ResponsiveContainer>
              <div className="flex justify-between text-white/60 text-xs px-6 font-medium mt-1">
                {lineChartData.map((d: any, i: number) => (
                  <span key={i}>{d.name}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Row 2: Secondary Metrics (3 Columns) */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Vehicles Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="rounded-2xl bg-[#dcfce7] p-5 shadow-sm border border-[#bbf7d0]/50 relative"
        >
          <h3 className="text-xs font-bold text-slate-700 tracking-wider uppercase mb-2">{t("VehiclesUpper" as any) || "VEHICLES"}</h3>
          <div className="text-4xl font-bold text-slate-900 tracking-tight">{stats?.totalVehicles || 0}</div>
          <p className="text-sm text-slate-600 font-medium mb-4">{t("ActiveInventory" as any) || "Active Inventory"}</p>

          <div className="flex gap-6 mb-4">
            <div>
              <div className="text-xl font-bold text-slate-900">{stats?.totalVehicles || 0}</div>
              <p className="text-xs text-slate-600 font-medium">{t("Total" as any) || "Total"}</p>
            </div>
            <div>
              <div className="text-xl font-bold text-slate-900">{stats?.availableVehicles || 0}</div>
              <p className="text-xs text-slate-600 font-medium">{t("Available" as any) || "Available"}</p>
            </div>
          </div>

          <div className="text-sm font-medium text-[#16a34a]">{t("StockLevelHealthy" as any) || "Stock Level: Healthy"}</div>

          <div className="absolute bottom-6 end-6 flex items-end gap-1.5 opacity-50">
            <div className="w-2 h-6 bg-[#22c55e] rounded-t-sm"></div>
            <div className="w-2 h-10 bg-[#22c55e] rounded-t-sm"></div>
            <div className="w-2 h-4 bg-[#22c55e] rounded-t-sm"></div>
            <div className="w-2 h-12 bg-[#22c55e] rounded-t-sm"></div>
            <div className="w-2 h-8 bg-[#22c55e] rounded-t-sm"></div>
          </div>
        </motion.div>

        {/* Leads Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          className="rounded-2xl bg-[#ffedd5] p-5 shadow-sm border border-[#fed7aa]/50 relative flex justify-between"
        >
          <div>
            <h3 className="text-xs font-bold text-slate-700 tracking-wider uppercase mb-2">{t("LeadsUpper" as any) || "LEADS"}</h3>
            <div className="text-4xl font-bold text-slate-900 tracking-tight">{stats?.activeLeads || 0}</div>
            <p className="text-sm text-slate-600 font-medium mb-4">{t("TotalLeads" as any) || "Total Leads"}</p>

            <div className="flex gap-6 mb-4">
              <div>
                <div className="text-xl font-bold text-slate-900">{newLeadsCount}</div>
                <p className="text-xs text-slate-600 font-medium">{t("New" as any) || "New"}</p>
              </div>
              <div>
                <div className="text-xl font-bold text-slate-900">{qualifiedLeadsCount}</div>
                <p className="text-xs text-slate-600 font-medium">{t("Qualified" as any) || "Qualified"}</p>
              </div>
            </div>

            <div className="text-sm font-medium text-[#16a34a]">+0.0% {t("Growth" as any) || "growth"}</div>
          </div>

          <div className="w-32 flex flex-col items-center justify-center mt-2">
            <div className="h-20 w-20">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={finalDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={25}
                    outerRadius={40}
                    dataKey="value"
                    stroke="none"
                  >
                    {finalDonutData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-col gap-1 w-full pl-4">
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#10b981]"></div><span className="text-[10px] font-medium text-slate-700">{t("New" as any) || "New"}</span></div>
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#3b82f6]"></div><span className="text-[10px] font-medium text-slate-700">{t("Contacted" as any) || "Contacted"}</span></div>
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#f97316]"></div><span className="text-[10px] font-medium text-slate-700">{t("TestDrive" as any) || "Test Drive"}</span></div>
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#eab308]"></div><span className="text-[10px] font-medium text-slate-700">{t("Nurturing" as any) || "Nurturing"}</span></div>
            </div>
          </div>
        </motion.div>

        {/* Team Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="rounded-2xl bg-[#e0f2fe] p-5 shadow-sm border border-[#bae6fd]/50"
        >
          <h3 className="text-xs font-bold text-slate-700 tracking-wider uppercase mb-2">{t("TeamMembers" as any) || "TEAM MEMBERS"}</h3>
          <div className="text-4xl font-bold text-slate-900 tracking-tight">{stats?.teamMembers || 0}</div>
          <p className="text-sm text-slate-600 font-medium mb-4">{t("ActiveStaff" as any) || "Active Staff"}</p>

          <div className="flex flex-col gap-4 mt-2">
            {stats?.teamTasks?.slice(0, 2).map((member: any, i: number) => (
              <div key={i} className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full ${i === 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'} flex items-center justify-center font-bold border border-white`}>
                  {member.name.substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900">{member.name}</p>
                  <p className="text-xs font-medium text-slate-500">{member.completed} {t("TasksDone" as any) || "Tasks Done"}</p>
                </div>
              </div>
            ))}
            {(!stats?.teamTasks || stats.teamTasks.length === 0) && (
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 font-bold border border-white">
                  ?
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900">{t("NoActiveTasks" as any) || "No active tasks"}</p>
                  <p className="text-xs font-medium text-slate-500">{t("AssignTasksToSee" as any) || "Assign tasks to see them here"}</p>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Row 3: Recent Leads Table (Full Width) */}
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
        className="rounded-2xl border border-slate-200 bg-white text-card-foreground shadow-sm overflow-hidden flex flex-col w-full"
      >
        <div className="p-4 flex flex-row items-center justify-between border-b border-slate-100 bg-white">
          <h3 className="font-bold text-sm tracking-widest uppercase text-slate-800">{t("RecentLeadsActivity" as any) || "RECENT LEADS ACTIVITY"}</h3>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-2 border-slate-200 text-slate-600 text-xs font-semibold rounded-lg">
                  <Filter className="w-3.5 h-3.5" /> {t("Filters" as any) || "Filters"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { setFilterStatus("ALL"); setCurrentPage(1); }}>{t("Total" as any) || "All"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("NEW"); setCurrentPage(1); }}>{t("New" as any) || "New"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("CONTACTED"); setCurrentPage(1); }}>{t("Contacted" as any) || "Contacted"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("INTERESTED"); setCurrentPage(1); }}>{t("Qualified" as any) || "Qualified"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("TEST_DRIVE"); setCurrentPage(1); }}>{t("TestDrive" as any) || "Test Drive"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("NEGOTIATION"); setCurrentPage(1); }}>{t("Nurturing" as any) || "Nurturing"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("RESERVED"); setCurrentPage(1); }}>{t("Reserved" as any) || "Reserved"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("WON"); setCurrentPage(1); }}>{t("WON" as any) || "WON"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setFilterStatus("LOST"); setCurrentPage(1); }}>{t("Lost" as any) || "Lost"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="p-0 flex-1 bg-white">
          <div className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Name" as any) || "Name"}</TableHead>
                  <TableHead>{t("Source" as any) || "Source"}</TableHead>
                  <TableHead>{t("Status" as any) || "Status"}</TableHead>
                  <TableHead>{t("VehicleInterest" as any) || "Vehicle Interest"}</TableHead>
                  <TableHead>{t("LastActivity" as any) || "Last Activity"}</TableHead>
                  <TableHead>{t("Contact" as any) || "Contact"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayLeads.map((lead: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-semibold text-slate-900 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-600 border border-slate-200">
                        {lead.avatar}
                      </div>
                      {lead.name}
                    </TableCell>
                    <TableCell className="font-medium text-slate-600">

                      {t(lead.source as any) || lead.source}
                    </TableCell>
                    <TableCell>
                      <span className={`px-2.5 py-1 rounded-md font-bold text-[11px] ${lead.status === "New Lead" ? "bg-[#ffedd5] text-[#ea580c]" :
                        lead.status === "Contacted" ? "bg-[#e0f2fe] text-[#0284c7]" :
                          "bg-[#dcfce7] text-[#16a34a]"
                        }`}>
                        {t(lead.status as any) || lead.status}
                      </span>
                    </TableCell>
                    <TableCell className="font-medium text-slate-600">
                      {lead.vehicle === "Unknown Vehicle" ? t("UnknownVehicle" as any) || lead.vehicle : lead.vehicle}
                    </TableCell>
                    <TableCell className="font-medium text-slate-600">
                      {lead.activity}
                    </TableCell>
                    <TableCell className="font-medium text-slate-600">
                      {lead.contact}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-end p-4 border-t border-slate-100 gap-2">
            <span className="text-xs font-medium text-slate-500 mr-2">
              {totalItems === 0 ? "0" : `${(safePage - 1) * itemsPerPage + 1} - ${Math.min(safePage * itemsPerPage, totalItems)}`} of {totalItems}
            </span>
            <Button
              variant="outline" size="icon" className="h-7 w-7 rounded-md"
              disabled={safePage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              <ChevronDown className="w-4 h-4 rotate-90" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7 rounded-md bg-slate-100 text-slate-900 font-bold border-0 text-xs">
              {safePage}
            </Button>
            <Button
              variant="outline" size="icon" className="h-7 w-7 rounded-md"
              disabled={safePage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >
              <ChevronDown className="w-4 h-4 -rotate-90" />
            </Button>
          </div>
        </div>
      </motion.div>

    </motion.div>
  );
}
