import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { compactNumber, money, SegmentedControl, RecordCard, MetricCard, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function ReportsModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const [period, setPeriod] = useState<"MONTH" | "YEAR">("MONTH");
  const range = useMemo(() => {
    const now = new Date();
    const start = period === "MONTH"
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getFullYear(), 0, 1);
    const end = period === "MONTH"
      ? new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      : new Date(now.getFullYear(), 11, 31, 23, 59, 59);
    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [period]);
  const sales = useQuery(api.reports.getSalesAndProfitReport, { orgId, ...range });
  const inventory = useQuery(api.reports.getInventoryReport, { orgId });
  const expenses = useQuery(api.reports.getExpensesReport, { orgId, ...range });
  const performance = useQuery(api.reports.getSalespersonPerformance, { orgId, ...range });
  const leads = useQuery(api.reports.getLeadConversionReport, { orgId, ...range });

  return (
    <ModuleScroll>
      <SegmentedControl
        options={[
          { label: locale === "ar" ? "الشهر" : "Month", value: "MONTH" },
          { label: locale === "ar" ? "السنة" : "Year", value: "YEAR" },
        ]}
        value={period}
        onChange={setPeriod}
      />
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "الإيراد" : "Revenue"} value={money(sales?.totalRevenue, locale)} caption={locale === "ar" ? "المبيعات" : "Sales"} />
        <MetricCard title={locale === "ar" ? "الربح" : "Profit"} value={money(sales?.totalProfit, locale)} caption={locale === "ar" ? "صافي" : "Net"} />
        <MetricCard title={locale === "ar" ? "المخزون" : "Inventory"} value={compactNumber(inventory?.availableCount ?? 0, locale)} caption={money(inventory?.totalValue, locale)} />
        <MetricCard title={locale === "ar" ? "المصاريف" : "Expenses"} value={money(expenses?.totalExpenses, locale)} caption={locale === "ar" ? "للفترة" : "Period"} />
        <MetricCard title={locale === "ar" ? "الفرص" : "Leads"} value={compactNumber(leads?.totalLeads ?? 0, locale)} caption={`${(leads?.overallConversionRate ?? 0).toFixed(1)}%`} />
        <MetricCard title={locale === "ar" ? "مبيعات الفريق" : "Team sales"} value={compactNumber(performance?.reduce((sum, row) => sum + row.vehiclesSold, 0) ?? 0, locale)} caption={locale === "ar" ? "سيارات" : "Vehicles"} />
      </View>
      <Text style={styles.sectionTitle}>{locale === "ar" ? "أفضل الأداء" : "Top performance"}</Text>
      {(performance ?? []).slice(0, 5).map((row) => (
        <RecordCard key={row.userId}>
          <Text style={styles.recordTitle}>{row.userName}</Text>
          <Text style={styles.recordMeta}>{row.vehiclesSold} · {money(row.totalRevenue, locale)} · {money(row.totalProfit, locale)}</Text>
        </RecordCard>
      ))}
    </ModuleScroll>
  );
}

