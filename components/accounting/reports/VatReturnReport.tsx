"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadCSV } from "@/lib/utils/export";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import { ReportMetric, formatMinorAmount, type ReportMoneyFormatter } from "./FinancialReportShared";
import { useOrgSettings } from "@/hooks/useOrgSettings";

export type VatReturnLine = {
  currency: string;
  outputVatMinor: number;
  inputVatMinor: number;
  netDueMinor: number;
};

export type VatReturnData = {
  currency: string;
  outputVatMinor: number;
  inputVatMinor: number;
  netDueMinor: number;
  lines: VatReturnLine[];
  fromDate: number | null;
  toDate: number;
};

export function VatReturnReport({
  report,
  locale,
  t,
  formatMoney,
}: Readonly<{
  report: VatReturnData | undefined;
  locale: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  const orgSettings = useOrgSettings();

  if (report === undefined) return <p className="p-8 text-center text-slate-500">{t("Loading")}</p>;

  function exportCSV() {
    downloadCSV(
      report!.lines.map((line) => ({
        Currency: line.currency,
        OutputVAT: formatMinorAmount(line.outputVatMinor, line.currency, locale === "ar" ? "ar-JO" : "en-US"),
        InputVAT: formatMinorAmount(line.inputVatMinor, line.currency, locale === "ar" ? "ar-JO" : "en-US"),
        NetDue: formatMinorAmount(line.netDueMinor, line.currency, locale === "ar" ? "ar-JO" : "en-US"),
      })),
      `vat-return-${new Date(report!.toDate).toISOString().slice(0, 10)}.csv`
    );
  }

  function exportPDF() {
    const doc = new jsPDF();
    const legalName = orgSettings?.legalCompanyName || orgSettings?.dealershipName;
    let cursorY = 18;
    if (legalName) {
      doc.setFontSize(11);
      doc.text(legalName, 14, cursorY);
      cursorY += 8;
    }
    doc.setFontSize(16);
    doc.text(t("VatReturn"), 14, cursorY);
    cursorY += 8;
    doc.setFontSize(10);
    const periodLabel = report!.fromDate
      ? `${new Date(report!.fromDate).toLocaleDateString()} - ${new Date(report!.toDate).toLocaleDateString()}`
      : `${t("AsOf")} ${new Date(report!.toDate).toLocaleDateString()}`;
    doc.text(periodLabel, 14, cursorY);

    autoTable(doc, {
      startY: cursorY + 8,
      head: [[t("Currency"), t("OutputVat"), t("InputVat"), t("NetVatDue")]],
      body: report!.lines.map((line) => [
        line.currency,
        formatMoney(line.outputVatMinor, line.currency),
        formatMoney(line.inputVatMinor, line.currency),
        formatMoney(line.netDueMinor, line.currency),
      ]),
    });

    doc.save(`vat-return-${new Date(report!.toDate).toISOString().slice(0, 10)}.pdf`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-slate-900">{t("VatReturn")}</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={exportCSV} disabled={report.lines.length === 0}>
            <Download className="h-4 w-4" />
            {t("ExportCSV")}
          </Button>
          <Button size="sm" variant="outline" onClick={exportPDF} disabled={report.lines.length === 0}>
            <FileText className="h-4 w-4" />
            {t("ExportPDF")}
          </Button>
        </div>
      </div>

      <p className="text-xs text-slate-500">{t("VatReturnDisclaimer")}</p>

      <div className="grid gap-3 md:grid-cols-3">
        <ReportMetric label={t("OutputVat")} value={formatMoney(report.outputVatMinor, report.currency)} />
        <ReportMetric label={t("InputVat")} value={formatMoney(report.inputVatMinor, report.currency)} />
        <ReportMetric
          label={t("NetVatDue")}
          value={formatMoney(report.netDueMinor, report.currency)}
          tone={report.netDueMinor >= 0 ? "danger" : "success"}
        />
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Currency")}</TableHead>
              <TableHead className="text-right">{t("OutputVat")}</TableHead>
              <TableHead className="text-right">{t("InputVat")}</TableHead>
              <TableHead className="text-right">{t("NetVatDue")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.lines.length === 0 ? (
              <AccountingEmptyRow colSpan={4} label={t("NoGLRowsFound")} />
            ) : (
              report.lines.map((line) => (
                <TableRow key={line.currency}>
                  <TableCell className="font-medium">{line.currency}</TableCell>
                  <TableCell className="text-right">{formatMoney(line.outputVatMinor, line.currency)}</TableCell>
                  <TableCell className="text-right">{formatMoney(line.inputVatMinor, line.currency)}</TableCell>
                  <TableCell className="text-right font-semibold">{formatMoney(line.netDueMinor, line.currency)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
    </div>
  );
}
