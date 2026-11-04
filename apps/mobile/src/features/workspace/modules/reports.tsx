import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { compactNumber, money, SegmentedControl, RecordCard, MetricCard, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export const REPORTS_COST_ACCESS_NOTE = {
  en: "This report shows what each car cost and what it earned. Your role needs cost-price access as well as report access to see it. Ask an administrator to update your role.",
  ar: "يعرض هذا التقرير تكلفة كل مركبة وما حققته من ربح. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية التقارير. اطلب من المسؤول تحديث دورك.",
} as const;

export function ReportsModule({ orgId, permissions }: { orgId: string; permissions: readonly string[] }) {
  const styles = useStyles();
  // SCRUM-902: the sales and inventory reports carry cost and profit; the server returns null without view:cost_price.
  const canSeeCost = permissions.includes("view:cost_price");
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
  const sales = useQuery(api.reports.getSalesAndProfitReport, canSeeCost ? { orgId, ...range } : "skip");
  const inventory = useQuery(api.reports.getInventoryReport, canSeeCost ? { orgId } : "skip");
  const expenses = useQuery(api.reports.getExpensesReport, canSeeCost ? { orgId, ...range } : "skip");
  const performance = useQuery(api.reports.getSalespersonPerformance, canSeeCost ? { orgId, ...range } : "skip");
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
      {!canSeeCost ? (
        <Text accessibilityRole="alert" style={styles.recordMeta}>
          {REPORTS_COST_ACCESS_NOTE[locale]}
        </Text>
      ) : null}
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "الإيراد" : "Revenue"} value={canSeeCost ? money(sales?.totalRevenue, locale) : "—"} caption={locale === "ar" ? "المبيعات" : "Sales"} />
        <MetricCard title={locale === "ar" ? "الربح" : "Profit"} value={canSeeCost ? money(sales?.totalProfit, locale) : "—"} caption={locale === "ar" ? "صافي" : "Net"} />
        <MetricCard title={locale === "ar" ? "المخزون" : "Inventory"} value={canSeeCost ? compactNumber(inventory?.availableCount ?? 0, locale) : "—"} caption={canSeeCost ? money(inventory?.totalValue, locale) : "—"} />
        <MetricCard title={locale === "ar" ? "المصاريف" : "Expenses"} value={canSeeCost ? money(expenses?.totalExpenses, locale) : "—"} caption={locale === "ar" ? "للفترة" : "Period"} />
        <MetricCard title={locale === "ar" ? "الفرص" : "Leads"} value={compactNumber(leads?.totalLeads ?? 0, locale)} caption={`${(leads?.overallConversionRate ?? 0).toFixed(1)}%`} />
        <MetricCard title={locale === "ar" ? "مبيعات الفريق" : "Team sales"} value={canSeeCost ? compactNumber(performance?.reduce((sum, row) => sum + row.vehiclesSold, 0) ?? 0, locale) : "—"} caption={locale === "ar" ? "سيارات" : "Vehicles"} />
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

