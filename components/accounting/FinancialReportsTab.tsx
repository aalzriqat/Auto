"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dateInputToEndOfDayMs, dateInputToStartOfDayMs } from "./setup/types";
import { formatMinorAmount } from "./reports/FinancialReportShared";
import { BalanceSheetReport } from "./reports/BalanceSheetReport";
import { IncomeStatementReport } from "./reports/IncomeStatementReport";
import { TrialBalanceReport } from "./reports/TrialBalanceReport";

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function firstDayOfCurrentMonth(): string {
  const today = new Date();
  return dateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));
}

function todayInputDate(): string {
  return dateInputValue(new Date());
}

export function FinancialReportsTab() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const [fromDate, setFromDate] = useState(firstDayOfCurrentMonth);
  const [toDate, setToDate] = useState(todayInputDate);

  const fromDateMs = useMemo(() => dateInputToStartOfDayMs(fromDate), [fromDate]);
  const toDateMs = useMemo(() => dateInputToEndOfDayMs(toDate), [toDate]);
  const moneyLocale = locale === "ar" ? "ar-JO" : "en-US";
  const formatMoney = (amountMinor: number, currency: string) =>
    formatMinorAmount(amountMinor, currency, moneyLocale);

  const trialBalance = useQuery(
    api.accountingReports.trialBalance,
    activeOrgId ? { orgId: activeOrgId, toDate: toDateMs } : "skip"
  );
  const incomeStatement = useQuery(
    api.accountingReports.incomeStatement,
    activeOrgId ? { orgId: activeOrgId, fromDate: fromDateMs, toDate: toDateMs } : "skip"
  );
  const balanceSheet = useQuery(
    api.accountingReports.balanceSheet,
    activeOrgId ? { orgId: activeOrgId, asOfDate: toDateMs } : "skip"
  );

  if (!activeOrgId) return null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1.5">
          <Label>{t("StartDate")}</Label>
          <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("EndDate")}</Label>
          <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </div>
      </div>

      <Tabs defaultValue="trialBalance" className="space-y-4">
        <TabsList className="bg-slate-50">
          <TabsTrigger value="trialBalance">{t("TrialBalance")}</TabsTrigger>
          <TabsTrigger value="incomeStatement">{t("IncomeStatement")}</TabsTrigger>
          <TabsTrigger value="balanceSheet">{t("BalanceSheet")}</TabsTrigger>
        </TabsList>
        <TabsContent value="trialBalance" className="m-0">
          <TrialBalanceReport report={trialBalance} locale={locale} t={t} formatMoney={formatMoney} />
        </TabsContent>
        <TabsContent value="incomeStatement" className="m-0">
          <IncomeStatementReport report={incomeStatement} locale={locale} t={t} formatMoney={formatMoney} />
        </TabsContent>
        <TabsContent value="balanceSheet" className="m-0">
          <BalanceSheetReport report={balanceSheet} locale={locale} t={t} formatMoney={formatMoney} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
