"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  LineChart,
  Car,
  Receipt,
  Download,
  Printer,
  Users,
  Target,
  BadgeDollarSign,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const defaultEndDate = new Date();
const defaultStartDate = new Date();
defaultStartDate.setDate(defaultStartDate.getDate() - 30);

export default function ReportsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const [startDateStr, setStartDateStr] = useState(defaultStartDate.toISOString().split("T")[0]);
  const [endDateStr, setEndDateStr] = useState(defaultEndDate.toISOString().split("T")[0]);
  const [selectedSalesperson, setSelectedSalesperson] = useState<string>("all");

  const startDate = new Date(startDateStr).setHours(0, 0, 0, 0);
  const endDate = new Date(endDateStr).setHours(23, 59, 59, 999);

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

  const DateFilter = () => (
    <div className="flex flex-wrap items-end gap-4 no-print bg-card p-4 rounded-lg border shadow-sm">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("StartDate" as any)}</label>
        <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("EndDate" as any)}</label>
        <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Salesperson</label>
        <Select value={selectedSalesperson} onValueChange={setSelectedSalesperson}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All staff" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All staff</SelectItem>
            {salespersonOptions.map((sp: any) => (
              <SelectItem key={sp.id} value={sp.name}>{sp.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

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
          <TabsList className="no-print">
            <TabsTrigger value="sales" className="gap-2">
              <LineChart className="h-4 w-4" /> {t("SalesProfit" as any) || "Sales & Profit"}
            </TabsTrigger>
            <TabsTrigger value="inventory" className="gap-2">
              <Car className="h-4 w-4" /> {t("Inventory" as any) || "Inventory"}
            </TabsTrigger>
            <TabsTrigger value="expenses" className="gap-2">
              <Receipt className="h-4 w-4" /> {t("Expenses" as any) || "Expenses"}
            </TabsTrigger>
            <TabsTrigger value="performance" className="gap-2">
              <Users className="h-4 w-4" /> Performance
            </TabsTrigger>
            <TabsTrigger value="leads" className="gap-2">
              <Target className="h-4 w-4" /> {t("LeadConversion" as any) || "Lead Conversion"}
            </TabsTrigger>
          </TabsList>

          {/* SALES REPORT */}
          <TabsContent value="sales" className="space-y-4 m-0">
            <DateFilter />
            <div className="flex items-center justify-between no-print">
              <div>
                <h3 className="text-lg font-medium">{t("SalesProfitOverview" as any) || "Sales & Profit Overview"}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                  {selectedSalesperson !== "all" && ` · ${selectedSalesperson}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => filteredSales && downloadCSV(filteredSales, "sales_report.csv")}>
                  <Download className="h-4 w-4 mr-2" /> {t("ExportCSV" as any)}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-2" /> {t("Print" as any)}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalRevenue" as any) || "Total Revenue"}</CardTitle>
                  <LineChart className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{filteredRevenue.toLocaleString()} JOD</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalCosts" as any) || "Total Costs"}</CardTitle>
                  <Receipt className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{filteredCost.toLocaleString()} JOD</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("NetProfit" as any) || "Net Profit"}</CardTitle>
                  <BadgeDollarSign className="h-4 w-4 text-green-500 no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">{filteredProfit.toLocaleString()} JOD</div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date" as any)}</TableHead>
                    <TableHead>{t("Vehicle" as any)}</TableHead>
                    <TableHead>{t("VIN" as any)}</TableHead>
                    <TableHead>Salesperson</TableHead>
                    <TableHead className="text-right">{t("SalePrice" as any) || "Sale Price"}</TableHead>
                    <TableHead className="text-right">{t("TotalCost" as any) || "Total Cost"}</TableHead>
                    <TableHead className="text-right">{t("NetProfit" as any) || "Net Profit"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSales?.map((sale: any) => (
                    <TableRow key={sale._id}>
                      <TableCell>{new Date(sale.saleDate).toLocaleDateString()}</TableCell>
                      <TableCell>{sale.vehicleYear} {sale.vehicleMake} {sale.vehicleModel}</TableCell>
                      <TableCell className="font-mono text-xs">{sale.vehicleVin || "-"}</TableCell>
                      <TableCell>{sale.salespersonName || "-"}</TableCell>
                      <TableCell className="text-right">{sale.salePrice.toLocaleString()} JOD</TableCell>
                      <TableCell className="text-right">{sale.totalCost.toLocaleString()} JOD</TableCell>
                      <TableCell className="text-right text-green-600 font-medium">{sale.netProfit.toLocaleString()} JOD</TableCell>
                    </TableRow>
                  ))}
                  {!filteredSales?.length && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                        {t("NoSalesFoundPeriod" as any) || "No sales found in this period."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* INVENTORY REPORT */}
          <TabsContent value="inventory" className="space-y-4 m-0">
            <div className="flex items-center justify-between no-print">
              <div>
                <h3 className="text-lg font-medium">Inventory Valuation</h3>
                <p className="text-sm text-muted-foreground">Current available and reserved vehicles</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => inventoryReport?.vehicles && downloadCSV(inventoryReport.vehicles, "inventory_report.csv")}>
                  <Download className="h-4 w-4 mr-2" /> {t("ExportCSV" as any)}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-2" /> {t("Print" as any)}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Active Vehicles</CardTitle>
                  <Car className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{inventoryReport?.availableCount ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("InventoryValue" as any) || "Inventory Value"}</CardTitle>
                  <BadgeDollarSign className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{inventoryReport?.totalValue?.toLocaleString() ?? 0} JOD</div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Vehicle" as any)}</TableHead>
                    <TableHead>{t("VIN" as any)}</TableHead>
                    <TableHead>{t("Status" as any)}</TableHead>
                    <TableHead className="text-right">{t("PurchasePrice" as any) || "Purchase Price"}</TableHead>
                    <TableHead className="text-right">{t("Expenses" as any)}</TableHead>
                    <TableHead className="text-right">{t("TotalInvested" as any) || "Total Invested"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventoryReport?.vehicles?.map((vehicle: any) => (
                    <TableRow key={vehicle._id}>
                      <TableCell className="font-medium">{vehicle.year} {vehicle.make} {vehicle.model}</TableCell>
                      <TableCell className="font-mono text-xs">{vehicle.vin}</TableCell>
                      <TableCell>{vehicle.status}</TableCell>
                      <TableCell className="text-right">{(vehicle.purchasePrice || 0).toLocaleString()} JOD</TableCell>
                      <TableCell className="text-right">{(vehicle.totalExpenses || 0).toLocaleString()} JOD</TableCell>
                      <TableCell className="text-right font-medium">{(vehicle.totalInvestment || 0).toLocaleString()} JOD</TableCell>
                    </TableRow>
                  ))}
                  {!inventoryReport?.vehicles?.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                        No active vehicles in inventory.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* EXPENSES REPORT */}
          <TabsContent value="expenses" className="space-y-4 m-0">
            <DateFilter />
            <div className="flex items-center justify-between no-print">
              <div>
                <h3 className="text-lg font-medium">{t("ExpensesOverview" as any) || "Expenses Overview"}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => expensesReport?.expenses && downloadCSV(expensesReport.expenses, "expenses_report.csv")}>
                  <Download className="h-4 w-4 mr-2" /> {t("ExportCSV" as any)}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-2" /> {t("Print" as any)}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("TotalExpenses" as any) || "Total Expenses"}</CardTitle>
                  <Receipt className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">{expensesReport?.totalExpenses?.toLocaleString() ?? 0} JOD</div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date" as any)}</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Related Vehicle</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expensesReport?.expenses?.map((exp: any) => (
                    <TableRow key={exp._id}>
                      <TableCell>{new Date(exp.date).toLocaleDateString()}</TableCell>
                      <TableCell>{exp.category}</TableCell>
                      <TableCell>{exp.notes || "-"}</TableCell>
                      <TableCell>{exp.vehicleDesc}</TableCell>
                      <TableCell className="text-right font-medium">{exp.amount.toLocaleString()} JOD</TableCell>
                    </TableRow>
                  ))}
                  {!expensesReport?.expenses?.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                        No expenses found in this period.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* PERFORMANCE REPORT */}
          <TabsContent value="performance" className="space-y-4 m-0">
            <DateFilter />
            <div className="flex items-center justify-between no-print">
              <div>
                <h3 className="text-lg font-medium">Salesperson Performance</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => performanceReport && downloadCSV(performanceReport, "performance_report.csv")}>
                  <Download className="h-4 w-4 mr-2" /> {t("ExportCSV" as any)}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-2" /> {t("Print" as any)}
                </Button>
              </div>
            </div>

            <Card className="print-shadow-none border print:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Salesperson</TableHead>
                    <TableHead className="text-right">Vehicles Sold</TableHead>
                    <TableHead className="text-right">Total Revenue</TableHead>
                    <TableHead className="text-right">Net Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performanceReport?.map((perf: any) => (
                    <TableRow key={perf.userId}>
                      <TableCell className="font-medium">{perf.userName}</TableCell>
                      <TableCell className="text-right">{perf.vehiclesSold}</TableCell>
                      <TableCell className="text-right">{perf.totalRevenue.toLocaleString()} JOD</TableCell>
                      <TableCell className="text-right text-green-600 font-medium">{perf.totalProfit.toLocaleString()} JOD</TableCell>
                    </TableRow>
                  ))}
                  {!performanceReport?.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-6 text-muted-foreground">
                        No performance data found in this period.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* LEADS REPORT */}
          <TabsContent value="leads" className="space-y-4 m-0">
            <DateFilter />
            <div className="flex items-center justify-between no-print">
              <div>
                <h3 className="text-lg font-medium">Lead Conversion</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                </p>
              </div>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> {t("Print" as any)}
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
                  <Target className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{leadsReport?.totalLeads ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Won Leads</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{leadsReport?.wonLeads ?? 0}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Overall Conversion</CardTitle>
                  <LineChart className="h-4 w-4 text-green-500 no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {leadsReport?.overallConversionRate?.toFixed(1) ?? 0}%
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="print-shadow-none border print:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Salesperson</TableHead>
                    <TableHead className="text-right">Assigned Leads</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Conversion Rate</TableHead>
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
                        No lead metrics found in this period.
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
