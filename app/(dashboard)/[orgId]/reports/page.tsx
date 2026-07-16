"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { GlState } from "@/convex/reports";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import {
  LineChart,
  Car,
  Receipt,
  Download,
  Printer,
  Users,
  Target,
  BadgeDollarSign,
  BookCheck,
  Boxes,
  Clock,
  TriangleAlert,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadCSV } from "@/lib/utils/export";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { paginationOptsValidator } from "convex/server";
import { dateInputToUtcMs, dateInputEndToUtcMs, todayDateInput, daysFromTodayDateInput } from "@/lib/dateInput";

function ReportsDateFilter({
  startDateStr,
  endDateStr,
  setStartDateStr,
  setEndDateStr,
  selectedSalesperson,
  setSelectedSalesperson,
  salespersonOptions,
}: {
  startDateStr: string;
  endDateStr: string;
  setStartDateStr: (v: string) => void;
  setEndDateStr: (v: string) => void;
  selectedSalesperson: string;
  setSelectedSalesperson: (v: string) => void;
  salespersonOptions: Array<{ id: string; name: string }>;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap items-end gap-4 no-print bg-card p-4 rounded-lg border shadow-sm">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("StartDate")}</label>
        <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("EndDate")}</label>
        <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("Salesperson")}</label>
        <SearchableSelect
          value={selectedSalesperson}
          onValueChange={setSelectedSalesperson}
          className="w-[180px]"
          placeholder={t("AllSalespeople")}
          options={[
            { value: "all", label: t("AllSalespeople") },
            ...salespersonOptions.map((sp) => ({ value: sp.name, label: sp.name })),
          ]}
        />
      </div>
    </div>
  );
}

const GL_STATE_STYLES: Record<GlState, string> = {
  POSTED: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  CAPITALIZED: "bg-sky-500/10 text-sky-700 border-sky-500/20",
  PENDING: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  FAILED: "bg-red-500/10 text-red-700 border-red-500/20",
  MIXED: "bg-amber-500/10 text-amber-700 border-amber-500/20",
};

/** Whether this row's amount actually reached the ledger. */
function GlStateBadge({ state, t }: Readonly<{ state?: GlState; t: (k: string) => string }>) {
  // Older cached query results won't carry glState; a missing badge is better
  // than asserting a state the server never sent.
  if (!state) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${GL_STATE_STYLES[state]}`}>
      {t(`GlState${state}`)}
    </span>
  );
}

/**
 * Says out loud what this report is, so nobody reads it as the P&L.
 *
 * Three honest states, because "do the two reports agree?" has three answers:
 *  - Something is still queued or dead-lettered → amber, count it, link to fix.
 *    The trigger is the ENTRY COUNT, never a signed monetary net: a queued
 *    amortization and its queued reversal cancel to zero while two entries wait.
 *  - Everything posted, but some of it capitalized into inventory → the
 *    operational total legitimately exceeds the Income Statement by that much,
 *    which is an asset there, not an expense. Say so rather than claim they
 *    match.
 *  - Everything posted to the P&L and nothing capitalized → they genuinely
 *    agree, and only then does the notice say so.
 *
 * The Setup tab (the accounting page's default) is where queued and failed
 * entries get redriven.
 */
function OperationalReportNotice({
  orgId,
  hasUnpostedEntries,
  unpostedEntryCount,
  capitalizedAmount,
  loaded,
  format,
  t,
}: Readonly<{
  orgId: Id<"organizations"> | null;
  hasUnpostedEntries: boolean;
  unpostedEntryCount: number;
  capitalizedAmount: number;
  loaded: boolean;
  format: (n: number) => string;
  t: (k: string) => string;
}>) {
  if (!loaded) return null;
  if (hasUnpostedEntries) {
    return (
      <div className="mb-4 text-xs text-amber-700 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{t("OperationalReportNotice").replace("{count}", String(unpostedEntryCount))}</span>
        {orgId && (
          <Link href={`/${orgId}/accounting`} className="font-medium underline underline-offset-2 no-print">
            {t("ResolveUnpostedEntries")}
          </Link>
        )}
      </div>
    );
  }
  if (capitalizedAmount !== 0) {
    return (
      <p className="mb-4 text-xs text-sky-700 bg-sky-500/10 border border-sky-500/20 rounded-md px-3 py-2">
        {t("OperationalReportCapitalizedNote").replace("{capitalized}", format(capitalizedAmount))}
      </p>
    );
  }
  return (
    <p className="mb-4 text-xs text-emerald-700 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
      {t("OperationalReportAllPosted")}
    </p>
  );
}

export default function ReportsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format, formatCompact } = useCurrency();

  const [startDateStr, setStartDateStr] = useState(() => daysFromTodayDateInput(-30));
  const [endDateStr, setEndDateStr] = useState(() => todayDateInput());
  const [selectedSalesperson, setSelectedSalesperson] = useState<string>("all");

  // UTC boundaries — the report buckets by UTC month, so a local setHours() here
  // pulled a Jordan user's range 3 hours into the previous day and clipped the
  // last 3 hours of the end date. See lib/dateInput.ts.
  const startDate = dateInputToUtcMs(startDateStr);
  const endDate = dateInputEndToUtcMs(endDateStr);

  const salesReport = useQuery(api.reports.getSalesAndProfitReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const inventoryReport = useQuery(api.reports.getInventoryReport, activeOrgId ? { orgId: activeOrgId } : "skip");
  const expensesReport = useQuery(api.reports.getExpensesReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const performanceReport = useQuery(api.reports.getSalespersonPerformance, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const leadsReport = useQuery(api.reports.getLeadConversionReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const members = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId, paginationOpts: { numItems: 100, cursor: null } } : "skip");

  const salespersonOptions = members?.page?.map((m: any) => ({ id: m.userId, name: m.userName || m.userEmail })) ?? [];

  const filteredSales = selectedSalesperson === "all"
    ? salesReport?.sales
    : salesReport?.sales?.filter((s: any) => s.salespersonId === selectedSalesperson || s.salespersonName === selectedSalesperson);

  const filteredRevenue = filteredSales?.reduce((sum: number, s: any) => sum + s.salePrice, 0) ?? 0;
  const filteredCost = filteredSales?.reduce((sum: number, s: any) => sum + s.totalCost, 0) ?? 0;
  const filteredProfit = filteredSales?.reduce((sum: number, s: any) => sum + s.netProfit, 0) ?? 0;

  const handlePrint = () => window.print();
  const dateFilterProps = { startDateStr, endDateStr, setStartDateStr, setEndDateStr, selectedSalesperson, setSelectedSalesperson, salespersonOptions };

  return (
    <RoleGuard permissions={["view:reports"]}>
      <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
        <style dangerouslySetInnerHTML={{
          __html: `
          @media print {
            .no-print { display: none !important; }
            body { padding: 0; margin: 0; }
            .print-full-width { width: 100% !important; max-width: 100% !important; }
            .print-shadow-none { box-shadow: none !important; border: none !important; }
            header { display: none !important; }
          }
        `}} />

        <Tabs defaultValue="sales" className="space-y-4 print-full-width">
          <div className="overflow-x-auto no-print">
            <TabsList className="w-max">
              <TabsTrigger value="sales" className="gap-2">
                <LineChart className="h-4 w-4" /> {t("SalesProfit") || "Sales & Profit"}
              </TabsTrigger>
              <TabsTrigger value="inventory" className="gap-2">
                <Car className="h-4 w-4" /> {t("Inventory") || "Inventory"}
              </TabsTrigger>
              <TabsTrigger value="expenses" className="gap-2">
                <Receipt className="h-4 w-4" /> {t("Expenses") || "Expenses"}
              </TabsTrigger>
              <TabsTrigger value="performance" className="gap-2">
                <Users className="h-4 w-4" /> {t("Performance")}
              </TabsTrigger>
              <TabsTrigger value="leads" className="gap-2">
                <Target className="h-4 w-4" /> {t("LeadConversion") || "Lead Conversion"}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* SALES REPORT */}
          <TabsContent value="sales" className="space-y-4 m-0">
            <ReportsDateFilter {...dateFilterProps} />
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("SalesProfitOverview") || "Sales & Profit Overview"}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                  {selectedSalesperson !== "all" && ` · ${selectedSalesperson}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => filteredSales && downloadCSV(filteredSales, "sales_report.csv")}>
                  <Download className="h-4 w-4 me-2" /> {t("ExportCSV")}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 me-2" /> {t("Print")}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalRevenue") || "Total Revenue"}</CardTitle>
                  <LineChart className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(filteredRevenue)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalCosts") || "Total Costs"}</CardTitle>
                  <Receipt className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(filteredCost)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("NetProfit") || "Net Profit"}</CardTitle>
                  <BadgeDollarSign className="h-4 w-4 text-green-500 no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">{format(filteredProfit)}</div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date")}</TableHead>
                    <TableHead>{t("Vehicle")}</TableHead>
                    <TableHead>{t("VIN")}</TableHead>
                    <TableHead>{t("Salesperson")}</TableHead>
                    <TableHead className="text-right">{t("SalePrice") || "Sale Price"}</TableHead>
                    <TableHead className="text-right">{t("TotalCost") || "Total Cost"}</TableHead>
                    <TableHead className="text-right">{t("NetProfit") || "Net Profit"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSales?.map((sale: any) => (
                    <TableRow key={sale._id}>
                      <TableCell>{new Date(sale.saleDate).toLocaleDateString()}</TableCell>
                      <TableCell>{sale.vehicleYear} {sale.vehicleMake} {sale.vehicleModel}</TableCell>
                      <TableCell className="font-mono text-xs">{sale.vehicleVin || "-"}</TableCell>
                      <TableCell>{sale.salespersonName || "-"}</TableCell>
                      <TableCell className="text-right">{format(sale.salePrice)}</TableCell>
                      <TableCell className="text-right">{format(sale.totalCost)}</TableCell>
                      <TableCell className="text-right text-green-600 font-medium">{format(sale.netProfit)}</TableCell>
                    </TableRow>
                  ))}
                  {!filteredSales?.length && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                        {t("NoSalesFoundPeriod") || "No sales found in this period."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* INVENTORY REPORT */}
          <TabsContent value="inventory" className="space-y-4 m-0">
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("InventoryValuation")}</h3>
                <p className="text-sm text-muted-foreground">{t("CurrentAvailableAndReserved")}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => inventoryReport?.vehicles && downloadCSV(inventoryReport.vehicles, "inventory_report.csv")}>
                  <Download className="h-4 w-4 me-2" /> {t("ExportCSV")}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 me-2" /> {t("Print")}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("ActiveVehicles")}</CardTitle>
                  <Car className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{inventoryReport?.availableCount ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("InventoryValue") || "Inventory Value"}</CardTitle>
                  <BadgeDollarSign className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(inventoryReport?.totalValue ?? 0)}</div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Vehicle")}</TableHead>
                    <TableHead>{t("VIN")}</TableHead>
                    <TableHead>{t("Status")}</TableHead>
                    <TableHead className="text-right">{t("PurchasePrice") || "Purchase Price"}</TableHead>
                    <TableHead className="text-right">{t("Expenses")}</TableHead>
                    <TableHead className="text-right">{t("TotalInvested") || "Total Invested"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventoryReport?.vehicles?.map((vehicle: any) => (
                    <TableRow key={vehicle._id}>
                      <TableCell className="font-medium">{vehicle.year} {vehicle.make} {vehicle.model}</TableCell>
                      <TableCell className="font-mono text-xs">{vehicle.vin}</TableCell>
                      <TableCell>{vehicle.status}</TableCell>
                      <TableCell className="text-right">{format(vehicle.purchasePrice || 0)}</TableCell>
                      <TableCell className="text-right">{format(vehicle.totalExpenses || 0)}</TableCell>
                      <TableCell className="text-right font-medium">{format(vehicle.totalInvestment || 0)}</TableCell>
                    </TableRow>
                  ))}
                  {!inventoryReport?.vehicles?.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                        {t("NoActiveVehiclesInInventory")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* EXPENSES REPORT */}
          <TabsContent value="expenses" className="space-y-4 m-0">
            <ReportsDateFilter {...dateFilterProps} />
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("OperationalExpensesReport")}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => expensesReport?.expenses && downloadCSV(expensesReport.expenses, "expenses_report.csv")}>
                  <Download className="h-4 w-4 me-2" /> {t("ExportCSV")}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 me-2" /> {t("Print")}
                </Button>
              </div>
            </div>

            <OperationalReportNotice
              orgId={activeOrgId}
              hasUnpostedEntries={expensesReport?.hasUnpostedEntries ?? false}
              unpostedEntryCount={(expensesReport?.pendingEntryCount ?? 0) + (expensesReport?.failedEntryCount ?? 0)}
              capitalizedAmount={expensesReport?.totalCapitalized ?? 0}
              loaded={!!expensesReport}
              format={format}
              t={t}
            />

            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("OperationalTotal")}</CardTitle>
                  <Receipt className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">{format(expensesReport?.totalExpenses ?? 0)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("PostedToPnl")}</CardTitle>
                  <BookCheck className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(expensesReport?.totalPosted ?? 0)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("CapitalizedToAssets")}</CardTitle>
                  <Boxes className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(expensesReport?.totalCapitalized ?? 0) !== 0 ? "text-sky-600" : ""}`}>
                    {format(expensesReport?.totalCapitalized ?? 0)}
                  </div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("PendingPosting")}</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(expensesReport?.totalPending ?? 0) !== 0 ? "text-amber-600" : ""}`}>
                    {format(expensesReport?.totalPending ?? 0)}
                  </div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("FailedPosting")}</CardTitle>
                  <TriangleAlert className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(expensesReport?.totalFailed ?? 0) !== 0 ? "text-red-600" : ""}`}>
                    {format(expensesReport?.totalFailed ?? 0)}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date")}</TableHead>
                    <TableHead>{t("Category")}</TableHead>
                    <TableHead>{t("Description")}</TableHead>
                    <TableHead>{t("RelatedVehicle")}</TableHead>
                    <TableHead>{t("GlStatus")}</TableHead>
                    <TableHead className="text-right">{t("Amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expensesReport?.expenses?.map((exp: any) => (
                    <TableRow key={exp._id}>
                      <TableCell>{new Date(exp.date).toLocaleDateString()}</TableCell>
                      <TableCell>{exp.category}</TableCell>
                      <TableCell>
                        {exp.notes || "-"}
                        {exp.amortization && (
                          <div className="text-xs text-muted-foreground">
                            {t("PrepaidAmortizedNote")
                              .replace("{monthsElapsed}", String(exp.amortization.monthsElapsed))
                              .replace("{amortizationMonths}", String(exp.amortization.amortizationMonths))
                              .replace("{totalAmount}", format(exp.amount))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{exp.vehicleDesc}</TableCell>
                      <TableCell>
                        <GlStateBadge state={exp.glState} t={t} />
                      </TableCell>
                      <TableCell className="text-right font-medium">{format(exp.recognizedAmount ?? exp.amount)}</TableCell>
                    </TableRow>
                  ))}
                  {!expensesReport?.expenses?.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                        {t("NoExpensesFoundPeriod")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* PERFORMANCE REPORT */}
          <TabsContent value="performance" className="space-y-4 m-0">
            <ReportsDateFilter {...dateFilterProps} />
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("SalespersonPerformance")}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => performanceReport && downloadCSV(performanceReport, "performance_report.csv")}>
                  <Download className="h-4 w-4 me-2" /> {t("ExportCSV")}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 me-2" /> {t("Print")}
                </Button>
              </div>
            </div>

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Salesperson")}</TableHead>
                    <TableHead className="text-right">{t("VehiclesSold")}</TableHead>
                    <TableHead className="text-right">{t("TotalRevenue")}</TableHead>
                    <TableHead className="text-right">{t("NetProfit")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performanceReport?.map((perf: any) => (
                    <TableRow key={perf.userId}>
                      <TableCell className="font-medium">{perf.userName}</TableCell>
                      <TableCell className="text-right">{perf.vehiclesSold}</TableCell>
                      <TableCell className="text-right">{format(perf.totalRevenue)}</TableCell>
                      <TableCell className="text-right text-green-600 font-medium">{format(perf.totalProfit)}</TableCell>
                    </TableRow>
                  ))}
                  {!performanceReport?.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-6 text-muted-foreground">
                        {t("NoPerformanceData")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* LEADS REPORT */}
          <TabsContent value="leads" className="space-y-4 m-0">
            <ReportsDateFilter {...dateFilterProps} />
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("LeadConversion")}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 me-2" /> {t("Print")}
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalLeads")}</CardTitle>
                  <Target className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{leadsReport?.totalLeads ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("WonLeads")}</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{leadsReport?.wonLeads ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("OverallConversion")}</CardTitle>
                  <LineChart className="h-4 w-4 text-green-500 no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {leadsReport?.overallConversionRate?.toFixed(1) ?? 0}%
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Salesperson")}</TableHead>
                    <TableHead className="text-right">{t("AssignedLeads")}</TableHead>
                    <TableHead className="text-right">{t("Won")}</TableHead>
                    <TableHead className="text-right">{t("ConversionRate")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leadsReport?.salespersonMetrics?.map((metric: any) => (
                    <TableRow key={metric.userId}>
                      <TableCell className="font-medium">{metric.userName}</TableCell>
                      <TableCell className="text-right">{metric.totalLeads}</TableCell>
                      <TableCell className="text-right">{metric.wonLeads}</TableCell>
                      <TableCell className="text-right">{metric.conversionRate.toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                  {!leadsReport?.salespersonMetrics?.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-6 text-muted-foreground">
                        {t("NoLeadMetrics")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </RoleGuard>
  );
}
