import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  api,
  type MobileDashboardStats,
  type MobileDashboardTimeRange,
  type MobileDataQualityStats,
  type MobileMyMembership,
  type MobileOrgSummary,
} from "../../convexApi";
import { LocaleToggle } from "../../components/LocaleToggle";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import { WorkspaceModuleLauncher } from "../workspace/WorkspaceModuleLauncher";

const TIME_RANGES: ReadonlyArray<{
  value: MobileDashboardTimeRange;
  labelKey: "timeRangeDay" | "timeRangeMonth" | "timeRangeYear" | "timeRangeAllTime";
}> = [
  { value: "DAY", labelKey: "timeRangeDay" },
  { value: "MONTH", labelKey: "timeRangeMonth" },
  { value: "YEAR", labelKey: "timeRangeYear" },
  { value: "ALL_TIME", labelKey: "timeRangeAllTime" },
];

function compactNumber(value: number, locale: "en" | "ar"): string {
  const safeValue = Number.isFinite(value) ? value : 0;

  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(safeValue);
  } catch {
    return Math.round(safeValue).toLocaleString();
  }
}

function plainNumber(value: number, locale: "en" | "ar"): string {
  const safeValue = Number.isFinite(value) ? value : 0;

  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
    }).format(safeValue);
  } catch {
    return Math.round(safeValue).toString();
  }
}

function getDataQualityTotal(dataQuality: MobileDataQualityStats): number {
  return (
    dataQuality.customersMissingPhone +
    dataQuality.customersMissingEmail +
    dataQuality.vehiclesWithVinWarning
  );
}

function getSafeOrgs(orgs: Array<MobileOrgSummary | null> | undefined): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

function getTrendBarHeight(revenue: number, maxRevenue: number): number {
  const normalizedRevenue = Math.max(0, revenue);
  const scale = Math.max(1, maxRevenue);
  return 10 + (normalizedRevenue / scale) * 38;
}

function Header({ org }: { org: MobileOrgSummary }) {
  const router = useRouter();
  const { isRtl, t, textDirection } = useLocale();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.home)}
      >
        <Text style={styles.backButtonText}>{isRtl ? ">" : "<"}</Text>
      </Pressable>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text numberOfLines={1} style={styles.orgName}>
          {org.name || "Untitled workspace"}
        </Text>
        <Text style={styles.roleText}>
          {t("roleLabel")}: {org.roleName || "UNKNOWN"}
        </Text>
      </View>
      <View style={styles.headerActions}>
        <LocaleToggle />
        <UserButton />
      </View>
    </View>
  );
}

function TimeRangeControl({
  value,
  onChange,
}: {
  value: MobileDashboardTimeRange;
  onChange: (value: MobileDashboardTimeRange) => void;
}) {
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.segmentedControl, { direction: textDirection }]}>
      {TIME_RANGES.map((range) => {
        const selected = range.value === value;
        return (
          <Pressable
            key={range.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && styles.pressed,
            ]}
            onPress={() => onChange(range.value)}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {t(range.labelKey)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SalesHero({
  stats,
  timeRange,
  onChangeTimeRange,
}: {
  stats: MobileDashboardStats;
  timeRange: MobileDashboardTimeRange;
  onChangeTimeRange: (value: MobileDashboardTimeRange) => void;
}) {
  const { locale, t, textDirection } = useLocale();
  const latestTrend = stats.salesTrend.at(-1);
  const trendPoints = stats.salesTrend.length > 0 ? stats.salesTrend.slice(-8) : [{ name: "0", Revenue: 0 }];
  const maxTrendRevenue = Math.max(...trendPoints.map((point) => point.Revenue), 1);

  return (
    <View style={[styles.salesHero, { direction: textDirection }]}>
      <View style={styles.heroTopRow}>
        <View style={styles.heroTitleGroup}>
          <Text style={styles.heroEyebrow}>{t("salesOverview")}</Text>
          <Text style={styles.heroTitle}>{compactNumber(stats.salesVolumeThisMonth, locale)}</Text>
          <Text style={styles.heroSubtitle}>{t("revenue")}</Text>
        </View>
        <View style={styles.soldPill}>
          <Text style={styles.soldValue}>{plainNumber(stats.salesThisMonth, locale)}</Text>
          <Text style={styles.soldLabel}>{t("vehiclesSold")}</Text>
        </View>
      </View>

      <TimeRangeControl value={timeRange} onChange={onChangeTimeRange} />

      <View style={styles.trendRow}>
        <View style={styles.trendLine}>
          {trendPoints.map((point, index) => {
            const height = getTrendBarHeight(point.Revenue, maxTrendRevenue);
            return <View key={`${point.name}-${index}`} style={[styles.trendBar, { height }]} />;
          })}
        </View>
        <Text style={styles.trendCaption}>
          {latestTrend?.name ? `${t("revenue")} ${latestTrend.name}` : t("revenue")}
        </Text>
      </View>
    </View>
  );
}

function MetricCard({
  title,
  value,
  caption,
  tone,
}: {
  title: string;
  value: string;
  caption: string;
  tone: "green" | "amber" | "blue" | "slate";
}) {
  const toneStyle = getMetricToneStyle(tone);

  return (
    <View style={[styles.metricCard, toneStyle]}>
      <Text style={styles.metricTitle}>{title}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.metricValue}>
        {value}
      </Text>
      <Text style={styles.metricCaption}>{caption}</Text>
    </View>
  );
}

function getMetricToneStyle(tone: "green" | "amber" | "blue" | "slate") {
  switch (tone) {
    case "green":
      return styles.greenMetric;
    case "amber":
      return styles.amberMetric;
    case "blue":
      return styles.blueMetric;
    case "slate":
      return styles.slateMetric;
  }
}

function DataQualityPanel({ dataQuality }: { dataQuality: MobileDataQualityStats }) {
  const { locale, t, textDirection } = useLocale();
  const total = getDataQualityTotal(dataQuality);

  if (total === 0) {
    return null;
  }

  return (
    <View style={[styles.warningPanel, { direction: textDirection }]}>
      <Text style={styles.panelTitle}>{t("dataQualityUpper")}</Text>
      <View style={styles.qualityGrid}>
        <MetricPill
          label={t("customersMissingPhone")}
          value={plainNumber(dataQuality.customersMissingPhone, locale)}
        />
        <MetricPill
          label={t("customersMissingEmail")}
          value={plainNumber(dataQuality.customersMissingEmail, locale)}
        />
        <MetricPill
          label={t("vehiclesVinWarning")}
          value={plainNumber(dataQuality.vehiclesWithVinWarning, locale)}
        />
      </View>
    </View>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricPill}>
      <Text style={styles.metricPillValue}>{value}</Text>
      <Text style={styles.metricPillLabel}>{label}</Text>
    </View>
  );
}

function TeamPanel({ stats }: { stats: MobileDashboardStats }) {
  const { locale, t, textDirection } = useLocale();
  const topTeamTasks = stats.teamTasks.slice(0, 3);

  return (
    <View style={[styles.panel, { direction: textDirection }]}>
      <Text style={styles.panelTitle}>{t("teamActivity")}</Text>
      {stats.topPerformer ? (
        <View style={styles.performerRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {stats.topPerformer.name.slice(0, 2).toUpperCase() || "AF"}
            </Text>
          </View>
          <View style={styles.performerText}>
            <Text style={styles.performerName}>{stats.topPerformer.name}</Text>
            <Text style={styles.performerMeta}>
              {t("topPerformer")} · {plainNumber(stats.topPerformer.deals, locale)}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.panelBody}>{t("noTopPerformer")}</Text>
      )}

      {topTeamTasks.length > 0 ? (
        <View style={styles.teamList}>
          {topTeamTasks.map((member, index) => (
            <View key={`${member.name}-${index}`} style={styles.teamRow}>
              <Text numberOfLines={1} style={styles.teamName}>
                {member.name}
              </Text>
              <Text style={styles.teamMeta}>
                {plainNumber(member.pending + member.overdue, locale)} {t("pending")}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.panelBody}>{t("noTeamActivity")}</Text>
      )}
    </View>
  );
}

function QuickActionRail({
  orgId,
  roleName,
}: Readonly<{
  orgId: string;
  roleName: string;
}>) {
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const isOwner = roleName.toUpperCase() === "OWNER";
  const actions = [
    {
      label: t("inventory"),
      moduleId: "vehicles",
    },
    {
      label: t("leads"),
      moduleId: "leads",
    },
    {
      label: t("messages"),
      moduleId: "messages",
    },
    {
      label: t("settings"),
      moduleId: isOwner ? "settings" : "team",
    },
  ];

  return (
    <View style={[styles.quickRail, { direction: textDirection }]}>
      {actions.map((action) => (
        <Pressable
          key={action.moduleId}
          accessibilityRole="button"
          style={({ pressed }) => [styles.quickRailItem, pressed && styles.pressed]}
          onPress={() =>
            router.push({
              pathname: "/org/[orgId]/module/[moduleId]",
              params: { orgId, moduleId: action.moduleId },
            })
          }
        >
          <Text numberOfLines={1} style={styles.quickRailText}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function DashboardContent({
  myMembership,
  org,
  stats,
  dataQuality,
  timeRange,
  onChangeTimeRange,
}: {
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
  stats: MobileDashboardStats;
  dataQuality: MobileDataQualityStats;
  timeRange: MobileDashboardTimeRange;
  onChangeTimeRange: (value: MobileDashboardTimeRange) => void;
}) {
  const { locale, t } = useLocale();
  const router = useRouter();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <Header org={org} />
      <QuickActionRail orgId={org._id} roleName={myMembership.roleName} />
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.marketplaceLink, pressed && styles.pressed]}
        onPress={() =>
          router.push({
            pathname: "/org/[orgId]/marketplace",
            params: { orgId: org._id },
          })
        }
      >
        <Text style={styles.marketplaceLinkTitle}>{t("dealerMarketplace")}</Text>
        <Text style={styles.marketplaceLinkBody}>{t("dealerMarketplaceSubtitle")}</Text>
      </Pressable>
      <SalesHero stats={stats} timeRange={timeRange} onChangeTimeRange={onChangeTimeRange} />

      <View style={styles.metricGrid}>
        <MetricCard
          title={t("vehiclesUpper")}
          value={plainNumber(stats.totalVehicles, locale)}
          caption={`${plainNumber(stats.availableVehicles, locale)} ${t("available")}`}
          tone="green"
        />
        <MetricCard
          title={t("leadsUpper")}
          value={plainNumber(stats.activeLeads, locale)}
          caption={t("activeLeads")}
          tone="amber"
        />
        <MetricCard
          title={t("teamUpper")}
          value={plainNumber(stats.teamMembers, locale)}
          caption={t("activeStaff")}
          tone="blue"
        />
        <MetricCard
          title={t("tasksUpper")}
          value={plainNumber(stats.taskStats.total, locale)}
          caption={`${plainNumber(stats.taskStats.overdue, locale)} ${t("overdue")}`}
          tone="slate"
        />
      </View>

      <DataQualityPanel dataQuality={dataQuality} />
      <WorkspaceModuleLauncher
        orgId={org._id}
        permissions={myMembership.permissions}
        roleName={myMembership.roleName}
      />
      <TeamPanel stats={stats} />
    </ScrollView>
  );
}

function InaccessibleWorkspaceState() {
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.emptyState, { direction: textDirection }]}>
      <Text style={styles.emptyTitle}>{t("inaccessibleWorkspaceTitle")}</Text>
      <Text style={styles.emptyBody}>{t("inaccessibleWorkspaceBody")}</Text>
      <Pressable
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.home)}
      >
        <Text style={styles.primaryButtonText}>{t("back")}</Text>
      </Pressable>
    </View>
  );
}

export function OrgDashboardScreen({ orgId }: Readonly<{ orgId: string | null }>) {
  const router = useRouter();
  const { t } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const canQuery = isLoaded && isSignedIn && !convexAuthLoading && isAuthenticated && Boolean(orgId);
  const orgs = useQuery(api.organizations.listMine, canQuery ? {} : "skip");
  const safeOrgs = useMemo(() => getSafeOrgs(orgs), [orgs]);
  const selectedOrg = safeOrgs.find((org) => org._id === orgId) ?? null;
  const [timeRange, setTimeRange] = useState<MobileDashboardTimeRange>("MONTH");
  const stats = useQuery(
    api.dashboard.stats,
    selectedOrg ? { orgId: selectedOrg._id, timeRange } : "skip",
  );
  const dataQuality = useQuery(
    api.dashboard.dataQualityStats,
    selectedOrg ? { orgId: selectedOrg._id } : "skip",
  );
  const myMembership = useQuery(
    api.memberships.getMyMembership,
    selectedOrg ? { orgId: selectedOrg._id } : "skip",
  );

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!selectedOrg || !myMembership) return;

    const role = myMembership.roleName?.toUpperCase();
    const moduleId =
      role === "SALES" || role === "SALESPERSON"
        ? "sales"
        : role === "RECEPTION"
          ? "leads"
          : role === "ACCOUNTANT"
            ? "accounting"
            : null;

    if (moduleId) {
      router.replace({
        pathname: "/org/[orgId]/module/[moduleId]",
        params: { orgId: selectedOrg._id, moduleId },
      });
    }
  }, [myMembership, router, selectedOrg]);

  if (!orgId || !isLoaded || convexAuthLoading || !isSignedIn || !isAuthenticated) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingSession")} />
      </Screen>
    );
  }

  if (orgs === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingWorkspace")} />
      </Screen>
    );
  }

  if (!selectedOrg) {
    return (
      <Screen>
        <InaccessibleWorkspaceState />
      </Screen>
    );
  }

  if (stats === undefined || dataQuality === undefined || myMembership === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("dashboardLoading")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <DashboardContent
        myMembership={myMembership}
        org={selectedOrg}
        stats={stats}
        dataQuality={dataQuality}
        timeRange={timeRange}
        onChangeTimeRange={setTimeRange}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  backButtonText: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 26,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  brand: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  orgName: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 30,
  },
  roleText: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  quickRail: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  quickRailItem: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  quickRailText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "900",
  },
  marketplaceLink: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: "#c7d2fe",
    backgroundColor: theme.colors.primarySoft,
    padding: theme.spacing.md,
  },
  marketplaceLinkTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "900",
  },
  marketplaceLinkBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 18,
  },
  salesHero: {
    gap: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.lg,
  },
  heroTopRow: {
    flexDirection: "row",
    gap: theme.spacing.md,
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  heroTitleGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  heroEyebrow: {
    color: "#a7f3d0",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: theme.colors.onPrimary,
    fontSize: 34,
    fontWeight: "900",
    lineHeight: 40,
  },
  heroSubtitle: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "700",
  },
  soldPill: {
    minWidth: 88,
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.12)",
    padding: theme.spacing.sm,
  },
  soldValue: {
    color: theme.colors.onPrimary,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
  },
  soldLabel: {
    color: "#cbd5e1",
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
  segmentedControl: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.08)",
    padding: theme.spacing.xs,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  segmentSelected: {
    backgroundColor: theme.colors.onPrimary,
  },
  segmentText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "800",
  },
  segmentTextSelected: {
    color: theme.colors.text,
  },
  trendRow: {
    gap: theme.spacing.sm,
  },
  trendLine: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.xs,
  },
  trendBar: {
    flex: 1,
    borderRadius: theme.radius.sm,
    backgroundColor: "#2dd4bf",
  },
  trendCaption: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "700",
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  metricCard: {
    width: "47.8%",
    minHeight: 132,
    justifyContent: "space-between",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    padding: theme.spacing.md,
  },
  greenMetric: {
    borderColor: "#bbf7d0",
    backgroundColor: "#dcfce7",
  },
  amberMetric: {
    borderColor: "#fed7aa",
    backgroundColor: "#ffedd5",
  },
  blueMetric: {
    borderColor: "#bae6fd",
    backgroundColor: "#e0f2fe",
  },
  slateMetric: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  metricTitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  metricValue: {
    color: theme.colors.text,
    fontSize: 34,
    fontWeight: "900",
    lineHeight: 40,
  },
  metricCaption: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  warningPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: "#fde68a",
    backgroundColor: "#fef3c7",
    padding: theme.spacing.md,
  },
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  panelBody: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
  },
  qualityGrid: {
    gap: theme.spacing.sm,
  },
  metricPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderRadius: theme.radius.sm,
    backgroundColor: "rgba(255,255,255,0.56)",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  metricPillValue: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  metricPillLabel: {
    flex: 1,
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  performerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "900",
  },
  performerText: {
    flex: 1,
    minWidth: 0,
  },
  performerName: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "800",
  },
  performerMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  teamList: {
    gap: theme.spacing.sm,
  },
  teamRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  teamName: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
  teamMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "900",
  },
  emptyBody: {
    color: theme.colors.mutedText,
    fontSize: 15,
    lineHeight: 22,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  pressed: {
    opacity: 0.82,
  },
});
