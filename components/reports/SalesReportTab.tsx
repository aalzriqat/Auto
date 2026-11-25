"use client";

import { Fragment } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { downloadCSV } from "@/lib/utils/export";
import { CostAccessNote } from "@/components/accounting/CostAccessNote";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BadgeDollarSign, Download, LineChart, Printer, Receipt } from "lucide-react";
import type { ReportRangeProblem } from "@/convex/utils/reportRange";
import { SalesReportRowWorking } from "./SalesReportRowWorking";
import { ReportsDateFilter } from "./ReportsDateFilter";
import { reportAccessMessage } from "./reportAccessMessage";

type SalesReport = FunctionReturnType<typeof api.reports.getSalesAndProfitReport>;

/** The slice of the reports view model the Sales & Profit tab reads. */
export type SalesReportTabProps = Readonly<{
  t: (key: string) => string;
  format: (amount: number) => string;
  permissionsLoading: boolean;
  canSeeCost: boolean;
  startDate: number;
  endDate: number;
  selectedSalesperson: string;
  salesReport: SalesReport | undefined;
  salesReportRequiresUpdate: boolean;
  filteredSales: NonNullable<SalesReport>["sales"] | undefined;
  filteredRevenue: number;
  filteredCost: number;
  filteredProfit: number;
  filteredNetAfterCommissions: number;
  filteredUnknownMargin: number;
  showCommissions: boolean;
  rangeProblem: ReportRangeProblem | null;
  handlePrint: () => void;
  dateFilterProps: React.ComponentProps<typeof ReportsDateFilter>;
}>;
export function SalesReportTab({
  t,
  format,
  permissionsLoading,
  canSeeCost,
  startDate,
  endDate,
  selectedSalesperson,
  salesReport,
  salesReportRequiresUpdate,
  filteredSales,
  filteredRevenue,
  filteredCost,
  filteredProfit,
  filteredNetAfterCommissions,
  filteredUnknownMargin,
  showCommissions,
  rangeProblem,
  handlePrint,
  dateFilterProps,
}: SalesReportTabProps) {
  const { locale } = useLanguage();
  // A refused range skips the query; the filter stays on screen so the dates can be corrected.
  const accessMessage = rangeProblem !== null && canSeeCost ? null
    : reportAccessMessage({ permissionsLoading, canSeeCost, report: salesReport, requiresUpdate: salesReportRequiresUpdate });
  const rowMoney = (amount: number | null, currency: string) => amount === null ? "—" : formatMoneyDisplay(amount, currency, locale);
  const exportSales = () => {
    if (!filteredSales) return;
    downloadCSV(filteredSales.map((sale) => ({
      [t("Date")]: new Date(sale.saleDate).toISOString(),
      [t("Vehicle")]: `${sale.vehicleYear ?? ""} ${sale.vehicleMake ?? ""} ${sale.vehicleModel ?? ""}`.trim(),
      [t("VIN")]: sale.vehicleVin ?? "",
      currency: sale.currency,
      [t("SalePrice")]: sale.salePrice,
      [t("ReportRecognizedRevenue")]: sale.recognizedRevenue ?? null,
      [t("ReportDealCosts")]: sale.totalCost,
      [t("ProfitBeforeCommissionsSubtotal")]: sale.netProfit,
      ...(showCommissions ? {
        [t("ReportCommissionsColumn")]: sale.commissionsTotal,
        [t("ReportNetAfterCommissions")]: sale.netProfitAfterCommissions,
      } : {}),
      profitUnavailableReason: sale.profitUnavailableReason,
      salePriceUnavailableReason: sale.salePriceUnavailableReason,
      includedInTotals: sale.includedInTotals,
    })), "sales_report.csv");
  };
  return (
          <TabsContent value="sales" className="space-y-4 m-0">
            {accessMessage !== null ? <CostAccessNote>{t(accessMessage)}</CostAccessNote> : (<>
            <ReportsDateFilter {...dateFilterProps} />
            {rangeProblem === null && (<>
            <div className="flex flex-wrap items-center justify-between gap-2 no-print">
              <div>
                <h3 className="text-lg font-medium">{t("SalesProfitOverview") || "Sales & Profit Overview"}</h3>
                <p className="text-sm text-muted-foreground">
                  {new Date(startDate).toLocaleDateString()} — {new Date(endDate).toLocaleDateString()}
                  {selectedSalesperson !== "all" && ` · ${selectedSalesperson}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={exportSales}>
                  <Download className="h-4 w-4 me-2" /> {t("ExportCSV")}
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="h-4 w-4 me-2" /> {t("Print")}
                </Button>
              </div>
            </div>

            <div className={`grid gap-4 mb-4 ${showCommissions ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3"}`}>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("ReportRecognizedRevenue")}</CardTitle>
                  <LineChart className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(filteredRevenue)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("ReportDealCosts")}</CardTitle>
                  <Receipt className="h-4 w-4 text-muted-foreground no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{format(filteredCost)}</div>
                </CardContent>
              </Card>
              <Card className="print-shadow-none border print:border-gray-200">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("ProfitBeforeCommissionsSubtotal")}</CardTitle>
                  <BadgeDollarSign className="h-4 w-4 text-green-500 no-print" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">{format(filteredProfit)}</div>
                </CardContent>
              </Card>
              {showCommissions && (
                <Card className="print-shadow-none border print:border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("ReportNetAfterCommissions")}</CardTitle>
                    <BadgeDollarSign className="h-4 w-4 text-green-500 no-print" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-green-600 dark:text-green-400">{format(filteredNetAfterCommissions)}</div>
                  </CardContent>
                </Card>
              )}
            </div>

            <p className="text-sm text-muted-foreground">{t("ReportDealFiguresHint")}</p>

            {/* An understated total presented as complete is the same failure as
                an overstated one, so the exclusions are stated next to the
                figures they changed rather than only in the row itself. */}
            {filteredUnknownMargin > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                {t("ProfitUnknownNotice").replace("{count}", String(filteredUnknownMargin))}
              </div>
            )}

            {showCommissions && (salesReport?.commissionIncompleteSaleCount ?? 0) > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                {salesReport?.commissionIncompleteSaleCount} {t("ReportCommissionsIncomplete")}
              </div>
            )}

            <Card className="print-shadow-none border print:border-gray-200 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Date")}</TableHead>
                    <TableHead>{t("Vehicle")}</TableHead>
                    <TableHead>{t("VIN")}</TableHead>
                    <TableHead>{t("Salesperson")}</TableHead>
                    <TableHead className="text-right">{t("SalePrice") || "Sale Price"}</TableHead>
                    <TableHead className="text-right">{t("ReportRecognizedRevenue")}</TableHead>
                    <TableHead className="text-right">{t("ReportDealCosts")}</TableHead>
                    <TableHead className="text-right">{t("ProfitBeforeCommissionsSubtotal")}</TableHead>
                    {showCommissions && (
                      <>
                        <TableHead className="text-right">{t("ReportCommissionsColumn")}</TableHead>
                        <TableHead className="text-right">{t("ReportNetAfterCommissions")}</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSales?.map((sale: NonNullable<FunctionReturnType<typeof api.reports.getSalesAndProfitReport>>["sales"][number]) => (
                    <Fragment key={sale._id}>
                    <TableRow>
                      <TableCell>{new Date(sale.saleDate).toLocaleDateString()}</TableCell>
                      <TableCell>{sale.vehicleYear} {sale.vehicleMake} {sale.vehicleModel}</TableCell>
                      <TableCell className="font-mono text-xs">{sale.vehicleVin || "-"}</TableCell>
                      <TableCell>{dateFilterProps.salespersonOptions.find((person) => person.id === sale.salespersonId)?.name || "-"}</TableCell>
                      <TableCell className="text-right" dir="ltr">{rowMoney(sale.salePrice, sale.currency)}</TableCell>
                      <TableCell className="text-right" dir="ltr">{rowMoney(sale.recognizedRevenue ?? null, sale.currency)}</TableCell>
                      <TableCell className="text-right" dir="ltr">{rowMoney(sale.totalCost, sale.currency)}</TableCell>
                      {/* `null` is the server saying it cannot establish what
                          this deal earned — a financed sale settled directly
                          with the supplier whose recorded margin is missing. It
                          is shown as a dash and excluded from the totals above,
                          because formatting it as 0 would read as "this sale
                          made nothing", which is a different and false claim. */}
                      <TableCell className="text-right font-medium text-green-600 dark:text-green-400" dir="ltr">
                        {sale.netProfit === null ? (
                          <span className="text-muted-foreground" title={t("ProfitUnknownForSale")}>
                            —
                          </span>
                        ) : (
                          rowMoney(sale.netProfit, sale.currency)
                        )}
                        {sale.profitClassification === "ESTIMATED_AWAITING_SETTLEMENT" && (
                          <span className="ms-2 inline-flex items-center rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300" title={t("ReportEstimateNote")}>
                            {t("ReportEstimateBadge")}
                          </span>
                        )}
                      </TableCell>
                      {showCommissions && (
                        <>
                          <TableCell className="text-right" dir="ltr">
                            {sale.commissionsTotal === null ? "—" : rowMoney(sale.commissionsTotal, sale.currency)}
                            {sale.commissionPending && (
                              <span className="block text-xs text-amber-700 dark:text-amber-400">{t("DealCommissionsPendingSale")}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium" dir="ltr">
                            {sale.netProfitAfterCommissions === null ? "—" : rowMoney(sale.netProfitAfterCommissions, sale.currency)}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                    {(sale.profitLines ?? []).length > 0 && sale.netProfit !== null && (
                      <TableRow>
                        <TableCell colSpan={showCommissions ? 10 : 8} className="py-0">
                          <SalesReportRowWorking sale={sale} rowMoney={rowMoney} t={t} />
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                  ))}
                  {!filteredSales?.length && (
                    <TableRow>
                      <TableCell colSpan={showCommissions ? 10 : 8} className="text-center py-6 text-muted-foreground">
                        {t("NoSalesFoundPeriod") || "No sales found in this period."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
            </>)}
            </>)}
          </TabsContent>
  );
}
