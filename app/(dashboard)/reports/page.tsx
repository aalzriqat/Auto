"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { 
  LineChart, 
  Car, 
  Receipt, 
  Download, 
  Printer,
  Users,
  Target
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadCSV } from "@/lib/utils/export";

// Default date range (last 30 days)
const defaultEndDate = new Date();
const defaultStartDate = new Date();
defaultStartDate.setDate(defaultStartDate.getDate() - 30);

export default function ReportsPage() {
  const { activeOrgId } = useOrg();
  
  const [startDateStr, setStartDateStr] = useState(defaultStartDate.toISOString().split('T')[0]);
  const [endDateStr, setEndDateStr] = useState(defaultEndDate.toISOString().split('T')[0]);

  // Convert to timestamps for backend
  const startDate = new Date(startDateStr).setHours(0, 0, 0, 0);
  const endDate = new Date(endDateStr).setHours(23, 59, 59, 999);

  // Queries
  const salesReport = useQuery(api.reports.getSalesAndProfitReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const inventoryReport = useQuery(api.reports.getInventoryReport, activeOrgId ? { orgId: activeOrgId } : "skip");
  const expensesReport = useQuery(api.reports.getExpensesReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const performanceReport = useQuery(api.reports.getSalespersonPerformance, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");
  const leadsReport = useQuery(api.reports.getLeadConversionReport, activeOrgId ? { orgId: activeOrgId, startDate, endDate } : "skip");

  // Print function
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between space-y-2 no-print">
        <h2 className="text-3xl font-bold tracking-tight">Reports Hub</h2>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
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
            <LineChart className="h-4 w-4" /> Sales & Profit
          </TabsTrigger>
          <TabsTrigger value="inventory" className="gap-2">
            <Car className="h-4 w-4" /> Inventory
          </TabsTrigger>
          <TabsTrigger value="expenses" className="gap-2">
            <Receipt className="h-4 w-4" /> Expenses
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <Users className="h-4 w-4" /> Performance
          </TabsTrigger>
          <TabsTrigger value="leads" className="gap-2">
            <Target className="h-4 w-4" /> Lead Conversion
          </TabsTrigger>
        </TabsList>

        {/* Date Filter - Visible for Sales and Expenses only */}
        <div className="flex items-end gap-4 no-print bg-card p-4 rounded-lg border shadow-sm">
          <div className="space-y-1">
            <label className="text-sm font-medium">Start Date</label>
            <Input 
              type="date" 
              value={startDateStr} 
              onChange={(e) => setStartDateStr(e.target.value)} 
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">End Date</label>
            <Input 
              type="date" 
              value={endDateStr} 
              onChange={(e) => setEndDateStr(e.target.value)} 
            />
          </div>
        </div>

        {/* SALES REPORT */}
        <TabsContent value="sales" className="space-y-4 m-0">
          <div className="flex items-center justify-between no-print">
            <div>
              <h3 className="text-lg font-medium">Sales & Profit Overview</h3>
              <p className="text-sm text-muted-foreground">Showing data from {new Date(startDate).toLocaleDateString()} to {new Date(endDate).toLocaleDateString()}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => salesReport?.sales && downloadCSV(salesReport.sales, "sales_report.csv")}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> Print
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3 mb-4">
            <Card className="print-shadow-none border print:border-gray-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                <LineChart className="h-4 w-4 text-muted-foreground no-print" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{salesReport?.totalRevenue?.toLocaleString() ?? 0} JOD</div>
              </CardContent>
            </Card>
            <Card className="print-shadow-none border print:border-gray-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Costs</CardTitle>
                <Receipt className="h-4 w-4 text-muted-foreground no-print" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{salesReport?.totalCost?.toLocaleString() ?? 0} JOD</div>
              </CardContent>
            </Card>
            <Card className="print-shadow-none border print:border-gray-200">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
                <BadgeDollarSignIcon className="h-4 w-4 text-green-500 no-print" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">{salesReport?.totalProfit?.toLocaleString() ?? 0} JOD</div>
              </CardContent>
            </Card>
          </div>

          <Card className="print-shadow-none border print:border-gray-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>VIN</TableHead>
                  <TableHead className="text-right">Sale Price</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                  <TableHead className="text-right">Net Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salesReport?.sales?.map((sale) => (
                  <TableRow key={sale._id}>
                    <TableCell>{new Date(sale.saleDate).toLocaleDateString()}</TableCell>
                    <TableCell>{sale.vehicleYear} {sale.vehicleMake} {sale.vehicleModel}</TableCell>
                    <TableCell className="font-mono text-xs">{sale.vehicleVin || "-"}</TableCell>
                    <TableCell className="text-right">{sale.salePrice.toLocaleString()} JOD</TableCell>
                    <TableCell className="text-right">{sale.totalCost.toLocaleString()} JOD</TableCell>
                    <TableCell className="text-right text-green-600 font-medium">{sale.netProfit.toLocaleString()} JOD</TableCell>
                  </TableRow>
                ))}
                {!salesReport?.sales?.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                      No sales found in this period.
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
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> Print
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
                <CardTitle className="text-sm font-medium">Total Asset Value</CardTitle>
                <BadgeDollarSignIcon className="h-4 w-4 text-muted-foreground no-print" />
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
                  <TableHead>Vehicle</TableHead>
                  <TableHead>VIN</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Purchase Price</TableHead>
                  <TableHead className="text-right">Expenses</TableHead>
                  <TableHead className="text-right">Total Invested</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventoryReport?.vehicles?.map((vehicle) => (
                  <TableRow key={vehicle._id}>
                    <TableCell className="font-medium">{vehicle.year} {vehicle.make} {vehicle.model}</TableCell>
                    <TableCell className="font-mono text-xs">{vehicle.vin}</TableCell>
                    <TableCell>{vehicle.status}</TableCell>
                    <TableCell className="text-right">{vehicle.purchasePrice.toLocaleString()} JOD</TableCell>
                    <TableCell className="text-right">{vehicle.totalExpenses.toLocaleString()} JOD</TableCell>
                    <TableCell className="text-right font-medium">{vehicle.totalInvestment.toLocaleString()} JOD</TableCell>
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
          <div className="flex items-center justify-between no-print">
            <div>
              <h3 className="text-lg font-medium">Expenses Overview</h3>
              <p className="text-sm text-muted-foreground">Showing data from {new Date(startDate).toLocaleDateString()} to {new Date(endDate).toLocaleDateString()}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => expensesReport?.expenses && downloadCSV(expensesReport.expenses, "expenses_report.csv")}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> Print
              </Button>
            </div>
          </div>

          <Card className="print-shadow-none border print:border-gray-200 mb-4 max-w-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Expenses</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground no-print" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{expensesReport?.totalExpenses?.toLocaleString() ?? 0} JOD</div>
            </CardContent>
          </Card>

          <Card className="print-shadow-none border print:border-gray-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Related Vehicle</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expensesReport?.expenses?.map((exp) => (
                  <TableRow key={exp._id}>
                    <TableCell>{new Date(exp.date).toLocaleDateString()}</TableCell>
                    <TableCell>{exp.category}</TableCell>
                    <TableCell>{exp.description}</TableCell>
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
          <div className="flex items-center justify-between no-print">
            <div>
              <h3 className="text-lg font-medium">Salesperson Performance</h3>
              <p className="text-sm text-muted-foreground">Showing data from {new Date(startDate).toLocaleDateString()} to {new Date(endDate).toLocaleDateString()}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => performanceReport && downloadCSV(performanceReport, "performance_report.csv")}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> Print
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
                {performanceReport?.map((perf) => (
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
          <div className="flex items-center justify-between no-print">
            <div>
              <h3 className="text-lg font-medium">Lead Conversion Report</h3>
              <p className="text-sm text-muted-foreground">Showing data from {new Date(startDate).toLocaleDateString()} to {new Date(endDate).toLocaleDateString()}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => leadsReport?.salespersonMetrics && downloadCSV(leadsReport.salespersonMetrics, "lead_conversion.csv")}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
              <Button onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" /> Print
              </Button>
            </div>
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
            <CardHeader>
              <CardTitle>Salesperson Conversion</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Total Assigned Leads</TableHead>
                  <TableHead className="text-right">Won Leads</TableHead>
                  <TableHead className="text-right">Conversion Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leadsReport?.salespersonMetrics?.map((metric) => (
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
  );
}

// Icon helper to fix missing import
function BadgeDollarSignIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 18V6" />
    </svg>
  );
}
