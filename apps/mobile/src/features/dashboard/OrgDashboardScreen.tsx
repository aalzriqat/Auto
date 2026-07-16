import { nativeRoutes, type MobileFoundationStringKey } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  api,
  type MobileDashboardStats,
  type MobileDashboardTimeRange,
  type MobileDataQualityStats,
  type MobileMyMembership,
  type MobileOrgSummary,
} from "../../convexApi";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import type { SemanticIconName } from "../../components/Icon";
import { LocaleToggle } from "../../components/LocaleToggle";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { SkeletonRow } from "../../components/SkeletonRow";
import { StatTile, type StatTileTone } from "../../components/StatTile";
import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../../theme";
import { WorkspaceModuleLauncher } from "../workspace/WorkspaceModuleLauncher";
import { SmoothAreaChart } from "./SmoothAreaChart";
import { TodayAgenda } from "./TodayAgenda";

const TIME_RANGES: ReadonlyArray<{
  value: MobileDashboardTimeRange;
  labelKey: "timeRangeDay" | "timeRangeMonth" | "timeRangeYear" | "timeRangeAllTime";
}> = [
  { value: "DAY", labelKey: "timeRangeDay" },
  { value: "MONTH", labelKey: "timeRangeMonth" },
  { value: "YEAR", labelKey: "timeRangeYear" },
  { value: "ALL_TIME", labelKey: "timeRangeAllTime" },
];

function useDashboardTypography() {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();

  return useMemo(
    () => ({
      body: getTypographyStyle("body", locale, fontsLoaded),
      caption: getTypographyStyle("caption", locale, fontsLoaded),
      display: getTypographyStyle("display", locale, fontsLoaded),
      heading: getTypographyStyle("heading", locale, fontsLoaded),
      label: getTypographyStyle("label", locale, fontsLoaded),
      title: getTypographyStyle("title", locale, fontsLoaded),
    }),
    [fontsLoaded, locale],
  );
}

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

type QuickActionTone = "success" | "warning" | "info" | "indigo";

const quickActionToneSoft: Record<QuickActionTone, "successSoft" | "warningSoft" | "infoSoft" | "indigoSoft"> = {
  success: "successSoft",
  warning: "warningSoft",
  info: "infoSoft",
  indigo: "indigoSoft",
};

const quickActionToneFg: Record<QuickActionTone, QuickActionTone> = {
  success: "success",
  warning: "warning",
  info: "info",
  indigo: "indigo",
};

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

function getGreeting(locale: string, hour: number): string {
  if (hour < 12) {
    return locale === "ar" ? "صباح الخير" : "Good morning";
  }
  if (hour < 17) {
    return locale === "ar" ? "طاب يومك" : "Good afternoon";
  }
  return locale === "ar" ? "مساء الخير" : "Good evening";
}

function FadeSlideIn({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 420,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function useCountUp(target: number, duration = 700): number {
  const [display, setDisplay] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    const listenerId = progress.addListener(({ value }) => {
      setDisplay(Math.round(value * target));
    });
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => {
      animation.stop();
      progress.removeListener(listenerId);
    };
  }, [target, duration, progress]);

  return display;
}

function getFirstName(fullName: string | undefined): string | null {
  const trimmed = fullName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function Header({ org }: { org: MobileOrgSummary }) {
  const router = useRouter();
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const greeting = getGreeting(locale, new Date().getHours());
  const me = useQuery(api.users.getMe, {});
  const firstName = getFirstName(me?.name);
  const orgName = org.name || t("untitledWorkspace");
  const subtitleLine = firstName ? `${firstName} · ${orgName}` : orgName;

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.home)}
      >
        <Icon color="text" name="back" size={20} />
      </Pressable>
      <View style={styles.headerText}>
        <Text numberOfLines={1} style={[type.title, styles.greetingText]}>
          {greeting}
        </Text>
        <Text numberOfLines={1} style={[type.caption, styles.greetingSubtitle]}>
          {subtitleLine}
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
  const type = useDashboardTypography();

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
            <Text style={[styles.segmentText, type.label, selected && styles.segmentTextSelected]}>
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
  const type = useDashboardTypography();
  const latestTrend = stats.salesTrend.at(-1);
  const trendPoints = stats.salesTrend.length > 0 ? stats.salesTrend.slice(-8) : [{ name: "0", Revenue: 0 }];
  const animatedRevenue = useCountUp(stats.salesVolumeThisMonth);
  const animatedSoldCount = useCountUp(stats.salesThisMonth);
  const [chartWidth, setChartWidth] = useState(0);

  return (
    <Card style={[styles.salesHero, { direction: textDirection }]}>
      <View style={styles.heroTopRow}>
        <View style={styles.heroTitleGroup}>
          <Text style={[styles.heroEyebrow, type.label]}>{t("salesOverview")}</Text>
          <Text style={[styles.heroTitle, type.display]}>{compactNumber(animatedRevenue, locale)}</Text>
          <Text style={[styles.heroSubtitle, type.caption]}>{t("revenue")}</Text>
        </View>
        <View style={styles.soldPill}>
          <Icon color="primaryDark" name="sales" size={18} />
          <Text style={[styles.soldValue, type.title]}>{plainNumber(animatedSoldCount, locale)}</Text>
          <Text style={[styles.soldLabel, type.caption]}>{t("vehiclesSold")}</Text>
        </View>
      </View>

      <TimeRangeControl value={timeRange} onChange={onChangeTimeRange} />

      <View
        style={styles.trendRow}
        onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}
      >
        {chartWidth > 0 ? (
          <SmoothAreaChart
            color={theme.colors.primary}
            height={110}
            values={trendPoints.map((point) => point.Revenue)}
            width={chartWidth}
          />
        ) : (
          <View style={{ height: 110 }} />
        )}
        <Text style={[styles.trendCaption, type.caption]}>
          {latestTrend?.name ? `${t("revenue")} ${latestTrend.name}` : t("revenue")}
        </Text>
      </View>
    </Card>
  );
}

function MetricCard({
  title,
  value,
  caption,
  icon,
  tone,
}: {
  title: string;
  value: string;
  caption: string;
  icon: SemanticIconName;
  tone: StatTileTone;
}) {
  return (
    <StatTile
      caption={caption}
      icon={icon}
      label={title}
      style={styles.metricCard}
      tone={tone}
      value={value}
    />
  );
}

function DataQualityPanel({ dataQuality }: { dataQuality: MobileDataQualityStats }) {
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const total = getDataQualityTotal(dataQuality);

  if (total === 0) {
    return null;
  }

  return (
    <Card style={[styles.warningPanel, { direction: textDirection }]}>
      <Text style={[styles.panelTitle, type.label]}>{t("dataQualityUpper")}</Text>
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
    </Card>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  const type = useDashboardTypography();

  return (
    <View style={styles.metricPill}>
      <Text style={[styles.metricPillValue, type.heading]}>{value}</Text>
      <Text style={[styles.metricPillLabel, type.caption]}>{label}</Text>
    </View>
  );
}

// Mirrors the web team page's getLastSeenInfo tiers exactly (app/(dashboard)/[orgId]/team/page.tsx) —
// lastSeenAt is throttled server-side to a write at most every few minutes, so "active now"
// lines up with that window rather than claiming second-by-second accuracy.
function getPresenceInfo(
  t: (key: MobileFoundationStringKey) => string,
  lastSeenAt: number | undefined,
): { label: string; dotColor: string } {
  if (!lastSeenAt) {
    return { label: t("presenceOffline"), dotColor: theme.colors.subtleText };
  }
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000);
  if (minutes < 5) {
    return { label: t("presenceActiveNow"), dotColor: theme.colors.success };
  }
  if (minutes < 60) {
    return { label: t("presenceActiveMinutesAgo").replace("{0}", String(minutes)), dotColor: theme.colors.warning };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { label: t("presenceActiveHoursAgo").replace("{0}", String(hours)), dotColor: theme.colors.subtleText };
  }
  const days = Math.floor(hours / 24);
  return { label: t("presenceActiveDaysAgo").replace("{0}", String(days)), dotColor: theme.colors.subtleText };
}

function MemberAvatar({ imageUrl, name, size = 44 }: { imageUrl?: string; name: string; size?: number }) {
  const dimensionStyle = { width: size, height: size, borderRadius: size / 2 };

  if (imageUrl) {
    return <Image source={{ uri: imageUrl }} style={[styles.avatarImage, dimensionStyle]} />;
  }

  return (
    <View style={[styles.avatar, dimensionStyle]}>
      <Text style={styles.avatarText}>{name.slice(0, 2).toUpperCase() || "?"}</Text>
    </View>
  );
}

function PresenceDot({ lastSeenAt }: { lastSeenAt: number | undefined }) {
  const { t } = useLocale();
  const presence = getPresenceInfo(t, lastSeenAt);

  return (
    <View
      accessibilityLabel={presence.label}
      style={[styles.presenceDot, { backgroundColor: presence.dotColor }]}
    />
  );
}

function PresencePill({ lastSeenAt }: { lastSeenAt: number | undefined }) {
  const { t } = useLocale();
  const type = useDashboardTypography();
  const presence = getPresenceInfo(t, lastSeenAt);

  return (
    <View style={styles.presencePill}>
      <View style={[styles.presenceDot, { backgroundColor: presence.dotColor }]} />
      <Text numberOfLines={1} style={[styles.presencePillText, type.caption]}>
        {presence.label}
      </Text>
    </View>
  );
}

function TeamPanel({ stats }: { stats: MobileDashboardStats }) {
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const topTeamTasks = stats.teamTasks.slice(0, 3);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <Text style={[styles.panelTitle, type.label]}>{t("teamActivity")}</Text>
      {stats.topPerformer ? (
        <View style={styles.performerRow}>
          <MemberAvatar imageUrl={stats.topPerformer.imageUrl} name={stats.topPerformer.name} />
          <View style={styles.performerText}>
            <Text style={[styles.performerName, type.heading]}>{stats.topPerformer.name}</Text>
            <Text style={[styles.performerMeta, type.caption]}>
              {t("topPerformer")} · {plainNumber(stats.topPerformer.deals, locale)}
            </Text>
          </View>
          <PresencePill lastSeenAt={stats.topPerformer.lastSeenAt} />
        </View>
      ) : (
        <Text style={[styles.panelBody, type.body]}>{t("noTopPerformer")}</Text>
      )}

      {topTeamTasks.length > 0 ? (
        <View style={styles.teamList}>
          {topTeamTasks.map((member) => (
            <View key={member.userId} style={styles.teamRow}>
              <MemberAvatar imageUrl={member.imageUrl} name={member.name} size={30} />
              <Text numberOfLines={1} style={[styles.teamName, type.body]}>
                {member.name}
              </Text>
              <PresenceDot lastSeenAt={member.lastSeenAt} />
              <Text style={[styles.teamMeta, type.caption]}>
                {plainNumber(member.pending + member.overdue, locale)} {t("pending")}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={[styles.panelBody, type.body]}>{t("noTeamActivity")}</Text>
      )}
    </Card>
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
  const type = useDashboardTypography();
  const isOwner = roleName.toUpperCase() === "OWNER";
  const actions = [
    {
      icon: "vehicles",
      label: t("inventory"),
      moduleId: "vehicles",
      tone: "success",
    },
    {
      icon: "leads",
      label: t("leads"),
      moduleId: "leads",
      tone: "warning",
    },
    {
      icon: "messages",
      label: t("messages"),
      moduleId: "messages",
      tone: "info",
    },
    {
      icon: isOwner ? "settings" : "team",
      label: t("settings"),
      moduleId: isOwner ? "settings" : "team",
      tone: "indigo",
    },
  ] as const satisfies ReadonlyArray<{
    icon: SemanticIconName;
    label: string;
    moduleId: string;
    tone: QuickActionTone;
  }>;

  return (
    <View style={[styles.quickRail, { direction: textDirection }]}>
      {actions.map((action) => (
        <Pressable
          key={action.moduleId}
          accessibilityRole="button"
          style={({ pressed }) => [styles.quickRailItem, pressed && styles.pressed]}
          onPress={() =>
            router.push({
              pathname: nativeRoutes.orgModule,
              params: { orgId, moduleId: action.moduleId },
            })
          }
        >
          <View style={[styles.quickRailIconShell, { backgroundColor: theme.colors[quickActionToneSoft[action.tone]] }]}>
            <Icon color={quickActionToneFg[action.tone]} name={action.icon} size={20} />
          </View>
          <Text numberOfLines={1} style={[styles.quickRailText, type.label]}>
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
  const type = useDashboardTypography();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContentFull}>
      <Header org={org} />
      <View style={styles.contentBody}>
      <FadeSlideIn delay={0}>
        <TodayAgenda orgId={org._id} myMembership={myMembership} />
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <QuickActionRail orgId={org._id} roleName={myMembership.roleName} />
      </FadeSlideIn>
      <FadeSlideIn delay={140}>
      <Card
        accessibilityLabel={t("dealerMarketplace")}
        onPress={() =>
          router.push({
            pathname: nativeRoutes.orgMarketplace,
            params: { orgId: org._id },
          })
        }
        style={styles.marketplaceLink}
      >
        <View style={styles.marketplaceLinkIcon}>
          <Icon color="primary" name="marketplace" size={22} />
        </View>
        <View style={styles.marketplaceLinkText}>
          <Text style={[styles.marketplaceLinkTitle, type.heading]}>{t("dealerMarketplace")}</Text>
          <Text style={[styles.marketplaceLinkBody, type.caption]}>{t("dealerMarketplaceSubtitle")}</Text>
        </View>
        <Icon color="primary" name="chevronForward" size={22} />
      </Card>
      </FadeSlideIn>
      <FadeSlideIn delay={210} style={styles.performanceSection}>
      <Text style={[styles.performanceEyebrow, type.label]}>{t("performanceUpper")}</Text>
      <SalesHero stats={stats} timeRange={timeRange} onChangeTimeRange={onChangeTimeRange} />

      <View style={styles.metricGrid}>
        <MetricCard
          title={t("vehiclesUpper")}
          value={plainNumber(stats.totalVehicles, locale)}
          caption={`${plainNumber(stats.availableVehicles, locale)} ${t("available")}`}
          icon="vehicles"
          tone="success"
        />
        <MetricCard
          title={t("leadsUpper")}
          value={plainNumber(stats.activeLeads, locale)}
          caption={t("activeLeads")}
          icon="leads"
          tone="warning"
        />
        <MetricCard
          title={t("teamUpper")}
          value={plainNumber(stats.teamMembers, locale)}
          caption={t("activeStaff")}
          icon="team"
          tone="info"
        />
        <MetricCard
          title={t("tasksUpper")}
          value={plainNumber(stats.taskStats.total, locale)}
          caption={`${plainNumber(stats.taskStats.overdue, locale)} ${t("overdue")}`}
          icon="tasks"
          tone="primary"
        />
      </View>

      <DataQualityPanel dataQuality={dataQuality} />
      <WorkspaceModuleLauncher
        orgId={org._id}
        permissions={myMembership.permissions}
        roleName={myMembership.roleName}
      />
      <TeamPanel stats={stats} />
      </FadeSlideIn>
      </View>
    </ScrollView>
  );
}

function DashboardSkeleton({ org }: { org: MobileOrgSummary }) {
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContentFull}>
      <Header org={org} />
      <View style={styles.contentBody}>
        <Card style={[styles.skeletonPanel, { direction: textDirection }]}>
          <Text style={[styles.panelTitle, type.label]}>{t("dashboardLoading")}</Text>
          <SkeletonRow count={2} />
        </Card>
        <View style={styles.metricGrid}>
          <SkeletonRow count={4} />
        </View>
        <Card style={styles.skeletonPanel}>
          <SkeletonRow count={3} />
        </Card>
      </View>
    </ScrollView>
  );
}

function InaccessibleWorkspaceState() {
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.routeStateShell, { direction: textDirection }]}>
      <EmptyState
        actionLabel={t("back")}
        hint={t("inaccessibleWorkspaceBody")}
        icon="settings"
        onAction={() => router.replace(nativeRoutes.home)}
        title={t("inaccessibleWorkspaceTitle")}
      />
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
        pathname: nativeRoutes.orgModule,
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
        <DashboardSkeleton org={selectedOrg} />
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
  scrollContentFull: {
    paddingBottom: theme.spacing.xxl,
  },
  contentBody: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
  },
  performanceSection: {
    gap: theme.spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  backButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  greetingText: {
    color: theme.colors.text,
  },
  greetingSubtitle: {
    color: theme.colors.mutedText,
  },
  quickRail: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  quickRailItem: {
    flex: 1,
    minHeight: 76,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    paddingVertical: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  quickRailIconShell: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
  quickRailText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  marketplaceLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
  },
  marketplaceLinkIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
  },
  marketplaceLinkText: {
    flex: 1,
    minWidth: 0,
  },
  marketplaceLinkTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  marketplaceLinkBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 18,
  },
  performanceEyebrow: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: theme.spacing.xs,
  },
  salesHero: {
    gap: theme.spacing.lg,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    ...theme.shadows.md,
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
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: theme.colors.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 40,
  },
  heroSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "500",
  },
  soldPill: {
    minWidth: 88,
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
    padding: theme.spacing.sm,
  },
  soldValue: {
    color: theme.colors.primaryDark,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  soldLabel: {
    color: theme.colors.primaryDark,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
  },
  segmentedControl: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
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
    backgroundColor: theme.colors.surface,
    ...theme.shadows.sm,
  },
  segmentText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  segmentTextSelected: {
    color: theme.colors.text,
  },
  trendRow: {
    gap: theme.spacing.sm,
  },
  trendCaption: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "500",
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  metricCard: {
    width: "47.8%",
  },
  warningPanel: {
    gap: theme.spacing.md,
    borderColor: theme.colors.warning,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.warningSoft,
  },
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
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
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  metricPillValue: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
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
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarImage: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  presenceDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
  },
  presencePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  presencePillText: {
    color: theme.colors.mutedText,
    fontWeight: "600",
  },
  performerText: {
    flex: 1,
    minWidth: 0,
  },
  performerName: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "600",
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
    fontWeight: "600",
  },
  teamMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  routeStateShell: {
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  skeletonPanel: {
    borderRadius: theme.radius.lg,
  },
  pressed: {
    opacity: 0.82,
  },
});
