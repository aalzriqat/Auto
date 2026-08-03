import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { ProfileButton } from "../../components/ProfileButton";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  api,
  type MobileDashboardStats,
  type MobileDashboardTimeRange,
  type MobileDashboardTodayForRole,
  type MobileDataQualityStats,
  type MobileMyMembership,
  type MobileOrgSummary,
} from "../../convexApi";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import type { SemanticIconName } from "../../components/Icon";
import { FadeSlideIn } from "../../components/Motion";
import { NotificationBell } from "../../components/NotificationBell";
import { MemberAvatar } from "../../components/Avatar";
import { PresenceDot, PresencePill } from "../../components/Presence";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { SkeletonRow } from "../../components/SkeletonRow";
import { useLocale } from "../../providers/LocaleProvider";
import { type AppTheme } from "../../theme";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { WorkspaceModuleLauncher } from "../workspace/WorkspaceModuleLauncher";
import { compactNumber, plainNumber } from "./dashboardFormat";
import { useDashboardTypography } from "./dashboardTypography";
import {
  HOME_FAB_CLEARANCE,
  greetingKeyForHour,
  summarizeUpcomingPayments,
} from "./homeModel";
import {
  HomeAlerts,
  HomeDetailStat,
  HomeMarketplaceBanner,
  HomeOverviewCard,
  HomeQuickActions,
  HomeSearchRow,
  HomeShortcuts,
  HomeTaskCentre,
  HomeTwoUp,
  HomeUpcomingPayments,
  PanelHeading,
} from "./HomePanels";
import { SmoothAreaChart } from "./SmoothAreaChart";

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

function getFirstName(fullName: string | undefined): string | null {
  const trimmed = fullName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

type RoleStart = Readonly<{
  moduleId: "sales" | "leads" | "accounting";
  icon: SemanticIconName;
  titleKey: "roleStartSalesTitle" | "roleStartReceptionTitle" | "roleStartAccountantTitle";
  bodyKey: "roleStartSalesBody" | "roleStartReceptionBody" | "roleStartAccountantBody";
}>;

// Operational roles used to be hard-redirected straight into one module. Instead
// we land them on the dashboard and give them a prominent one-tap "start here"
// card into that same module — keeping the fast path but adding a role Today.
function getRoleStart(roleName: string | undefined): RoleStart | null {
  switch (roleName?.toUpperCase()) {
    case "SALES":
    case "SALESPERSON":
      return { moduleId: "sales", icon: "sales", titleKey: "roleStartSalesTitle", bodyKey: "roleStartSalesBody" };
    case "RECEPTION":
      return { moduleId: "leads", icon: "leads", titleKey: "roleStartReceptionTitle", bodyKey: "roleStartReceptionBody" };
    case "ACCOUNTANT":
      return { moduleId: "accounting", icon: "accounting", titleKey: "roleStartAccountantTitle", bodyKey: "roleStartAccountantBody" };
    default:
      return null;
  }
}

const FINANCE_PERMISSIONS: readonly string[] = ["view:sales", "view:reports", "view:finance"];
const VIEW_FINANCE_PERMISSION = "view:finance";
const VIEW_TASKS_PERMISSION = "view:tasks";
const APPROVE_REQUESTS_PERMISSION = "approve:requests";

function isOwner(myMembership: MobileMyMembership): boolean {
  return myMembership.roleName?.toUpperCase() === "OWNER";
}

function hasPermission(myMembership: MobileMyMembership, permission: string): boolean {
  return isOwner(myMembership) || (myMembership.permissions ?? []).includes(permission);
}

// The owner/manager "performance" numbers (the KPI row, the trend, the team
// panel) read permission-gated fields server-side; hide them for roles that
// would only ever see zeros so their home stays honest.
function showsPerformanceSection(myMembership: MobileMyMembership): boolean {
  if (isOwner(myMembership)) return true;
  return (myMembership.permissions ?? []).some((permission) =>
    FINANCE_PERMISSIONS.includes(permission),
  );
}

// `dashboard.todayForRole` is gated server-side on `view:finance` specifically
// (not the broader FINANCE_PERMISSIONS set above). Gate the panel + query on
// the caller's ACTUAL permission, not a role-name heuristic — a custom role
// literally named "ACCOUNTANT" without this permission must not mount the
// query (it would just error), and any role that DOES have the permission
// should see the panel regardless of its name.
function hasViewFinancePermission(myMembership: MobileMyMembership): boolean {
  return hasPermission(myMembership, VIEW_FINANCE_PERMISSION);
}

function Header({
  myMembership,
  org,
}: Readonly<{ myMembership: MobileMyMembership; org: MobileOrgSummary }>) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const me = useQuery(api.users.getMe, {});
  const firstName = getFirstName(me?.name);
  const greeting = t(greetingKeyForHour(new Date().getHours()));
  const separator = t("dealerHomeGreetingSeparator");
  const orgName = org.name || t("untitledWorkspace");
  const roleName = myMembership.roleName || t("unknownRole");

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.dealerWorkspaces)}
      >
        <Icon color="text" name="back" size={20} />
      </Pressable>
      <View style={styles.headerText}>
        <Text numberOfLines={1} style={[type.title, styles.greetingText]}>
          {firstName ? `${greeting}${separator}${firstName}` : greeting}
        </Text>
        <Text numberOfLines={1} style={[type.caption, styles.greetingSubtitle]}>
          {`${orgName} · ${roleName}`}
        </Text>
      </View>
      <View style={styles.headerActions}>
        <NotificationBell orgId={org._id} />
        <ProfileButton />
      </View>
    </View>
  );
}

/**
 * The "view details" drawer under the overview card: the revenue trend and the
 * secondary counts that used to occupy their own always-visible section. All of
 * it is real `dashboard.stats` data — it is collapsed by default, not dropped.
 */
function HomeOverviewDetails({ stats }: Readonly<{ stats: MobileDashboardStats }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const [chartWidth, setChartWidth] = useState(0);
  const trend = stats.salesTrend ?? [];
  const trendPoints = trend.length > 0 ? trend.slice(-8) : [];

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="reports" title={t("salesOverview")} />
      <View
        style={styles.trendRow}
        onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}
      >
        {chartWidth > 0 && trendPoints.length > 0 ? (
          <SmoothAreaChart
            color={theme.colors.primary}
            height={104}
            values={trendPoints.map((point) => point.Revenue)}
            width={chartWidth}
          />
        ) : (
          <View style={styles.trendPlaceholder} />
        )}
        <Text style={[styles.trendCaption, type.caption]}>
          {trendPoints.at(-1)?.name
            ? `${t("revenue")} · ${trendPoints.at(-1)?.name}`
            : t("revenue")}
        </Text>
      </View>
      <View style={styles.detailGrid}>
        <HomeDetailStat
          caption={`${plainNumber(stats.availableVehicles, locale)} ${t("available")}`}
          label={t("vehiclesUpper")}
          value={plainNumber(stats.totalVehicles, locale)}
        />
        <HomeDetailStat
          caption={t("activeLeads")}
          label={t("leadsUpper")}
          value={plainNumber(stats.activeLeads, locale)}
        />
        <HomeDetailStat
          caption={t("activeStaff")}
          label={t("teamUpper")}
          value={plainNumber(stats.teamMembers, locale)}
        />
        <HomeDetailStat
          label={t("vehiclesSold")}
          value={compactNumber(stats.salesThisMonth, locale)}
        />
      </View>
    </Card>
  );
}

function DataQualityPanel({ dataQuality }: Readonly<{ dataQuality: MobileDataQualityStats | undefined }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  if (dataQuality === undefined || getDataQualityTotal(dataQuality) === 0) {
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

function MetricPill({ label, value }: Readonly<{ label: string; value: string }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.metricPill}>
      <Text style={[styles.metricPillValue, type.heading]}>{value}</Text>
      <Text style={[styles.metricPillLabel, type.caption]}>{label}</Text>
    </View>
  );
}

function TeamPanel({ stats }: Readonly<{ stats: MobileDashboardStats | undefined }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  if (stats === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="team" title={t("teamActivity")} />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const topTeamTasks = (stats.teamTasks ?? []).slice(0, 3);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="team" title={t("teamActivity")} />
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

function RoleStartCard({ orgId, start }: Readonly<{ orgId: string; start: RoleStart }>) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();

  return (
    <Card
      accessibilityLabel={t(start.titleKey)}
      onPress={() =>
        router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId: start.moduleId } })
      }
      style={[styles.roleStartCard, { direction: textDirection }]}
    >
      <View style={styles.roleStartIcon}>
        <Icon color="onPrimary" name={start.icon} size={22} />
      </View>
      <View style={styles.roleStartText}>
        <Text style={[styles.roleStartTitle, type.heading]}>{t(start.titleKey)}</Text>
        <Text style={[styles.roleStartBody, type.caption]}>{t(start.bodyKey)}</Text>
      </View>
      <Icon color="onPrimary" name="chevronForward" size={22} />
    </Card>
  );
}

function DashboardContent({
  myMembership,
  org,
  timeRange,
  onChangeTimeRange,
}: Readonly<{
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
  timeRange: MobileDashboardTimeRange;
  onChangeTimeRange: (value: MobileDashboardTimeRange) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const orgId = org._id;
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const roleStart = getRoleStart(myMembership.roleName);
  const showsPerformance = showsPerformanceSection(myMembership);
  const canViewFinanceToday = hasViewFinancePermission(myMembership);
  const canViewTasks = hasPermission(myMembership, VIEW_TASKS_PERMISSION);
  const canApprove = hasPermission(myMembership, APPROVE_REQUESTS_PERMISSION);

  // Every panel owns its own loading state, so the screen paints as soon as the
  // membership resolves instead of blocking behind the slowest query.
  const stats = useQuery(api.dashboard.stats, { orgId, timeRange });
  // Only the performance section reads this. Mounting it for every other role
  // would keep a live subscription open on a result nothing renders.
  const dataQuality = useQuery(
    api.dashboard.dataQualityStats,
    showsPerformance ? { orgId } : "skip",
  );
  // The workspace currency. `orgSettings.get` returns null (rather than
  // throwing) for a caller without `view:settings`, and `todayForRole` carries
  // the same value for finance roles — so between them every role that can see
  // the KPI row gets the real currency wherever the backend will disclose it.
  // "JOD" is the last resort AND the backend's own default (see
  // `getOrgTimezoneAndCurrency` in convex/dashboard.ts).
  const orgSettings = useQuery(api.orgSettings.get, { orgId });
  const todayForRole: MobileDashboardTodayForRole | undefined = useQuery(
    api.dashboard.todayForRole,
    canViewFinanceToday ? { orgId } : "skip",
  );
  const notifications = useQuery(api.notifications.list, { orgId });
  const pendingApprovals = useQuery(
    api.approvals.listPendingApprovals,
    canApprove ? { orgId } : "skip",
  );
  const upcomingPayments = useMemo(
    () => summarizeUpcomingPayments(todayForRole),
    [todayForRole],
  );
  const currency =
    orgSettings === undefined
      ? undefined
      : (orgSettings?.currency ?? todayForRole?.currency ?? "JOD");
  // `undefined` while the query is in flight, a real 0 when it is skipped, so
  // the alerts panel can tell "loading" from "nothing waiting".
  const pendingApprovalsCount = canApprove ? pendingApprovals?.length : 0;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.scrollContentFull}
    >
      <Header myMembership={myMembership} org={org} />
      <View style={styles.contentBody}>
        <HomeSearchRow
          orgId={orgId}
          timeRange={timeRange}
          onChangeTimeRange={onChangeTimeRange}
        />

        {showsPerformance ? (
          <FadeSlideIn delay={0}>
            <HomeOverviewCard
              currency={currency}
              detailsExpanded={detailsExpanded}
              stats={stats}
              onToggleDetails={() => setDetailsExpanded((previous) => !previous)}
            />
          </FadeSlideIn>
        ) : null}

        {showsPerformance && detailsExpanded && stats !== undefined ? (
          <FadeSlideIn delay={0}>
            <HomeOverviewDetails stats={stats} />
          </FadeSlideIn>
        ) : null}

        {roleStart ? (
          <FadeSlideIn delay={40}>
            <RoleStartCard orgId={orgId} start={roleStart} />
          </FadeSlideIn>
        ) : null}

        <FadeSlideIn delay={70}>
          <HomeQuickActions
            orgId={orgId}
            permissions={myMembership.permissions ?? []}
            roleName={myMembership.roleName}
          />
        </FadeSlideIn>

        <FadeSlideIn delay={110}>
          <HomeMarketplaceBanner orgId={orgId} />
        </FadeSlideIn>

        <FadeSlideIn delay={150}>
          <HomeTwoUp
            first={<HomeTaskCentre canViewTasks={canViewTasks} orgId={orgId} stats={stats} />}
            second={
              <HomeShortcuts
                orgId={orgId}
                permissions={myMembership.permissions ?? []}
                roleName={myMembership.roleName}
              />
            }
          />
        </FadeSlideIn>

        {canViewFinanceToday ? (
          <FadeSlideIn delay={190}>
            <HomeUpcomingPayments
              orgId={orgId}
              summary={upcomingPayments}
              todayForRole={todayForRole}
            />
          </FadeSlideIn>
        ) : null}

        <FadeSlideIn delay={230}>
          <HomeAlerts
            notifications={notifications}
            orgId={orgId}
            pendingApprovals={pendingApprovalsCount}
          />
        </FadeSlideIn>

        <FadeSlideIn delay={270}>
          <WorkspaceModuleLauncher
            orgId={orgId}
            permissions={myMembership.permissions}
            roleName={myMembership.roleName}
          />
        </FadeSlideIn>

        {showsPerformance ? (
          <FadeSlideIn delay={310} style={styles.performanceSection}>
            <DataQualityPanel dataQuality={dataQuality} />
            <TeamPanel stats={stats} />
          </FadeSlideIn>
        ) : null}
      </View>
    </ScrollView>
  );
}

function DashboardSkeleton() {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContentFull}>
      <View style={styles.contentBody}>
        <Card style={[styles.panel, { direction: textDirection }]}>
          <Text style={[styles.panelTitle, type.label]}>{t("dashboardLoading")}</Text>
          <SkeletonRow count={2} />
        </Card>
        <Card style={styles.panel}>
          <SkeletonRow count={3} />
        </Card>
      </View>
    </ScrollView>
  );
}

function InaccessibleWorkspaceState() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.routeStateShell, { direction: textDirection }]}>
      <EmptyState
        actionLabel={t("back")}
        hint={t("inaccessibleWorkspaceBody")}
        icon="settings"
        onAction={() => router.replace(nativeRoutes.dealerWorkspaces)}
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
  const myMembership = useQuery(
    api.memberships.getMyMembership,
    selectedOrg ? { orgId: selectedOrg._id } : "skip",
  );

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

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

  // Only the membership blocks the whole screen: it decides which panels the
  // caller may see at all, and which queries are safe to mount. Everything else
  // renders its own skeleton in place.
  if (myMembership === undefined) {
    return (
      <Screen>
        <DashboardSkeleton />
      </Screen>
    );
  }

  return (
    <Screen>
      <DashboardContent
        myMembership={myMembership}
        org={selectedOrg}
        timeRange={timeRange}
        onChangeTimeRange={setTimeRange}
      />
    </Screen>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContentFull: {
    // The floating messenger FAB is absolutely positioned over this screen. The
    // old `spacing.xxl` (32) left the last control — "view all alerts" — under
    // it. HOME_FAB_CLEARANCE is derived from the FAB's own size and offset.
    paddingBottom: HOME_FAB_CLEARANCE,
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
  trendRow: {
    gap: theme.spacing.sm,
  },
  trendPlaceholder: {
    height: 104,
  },
  trendCaption: {
    color: theme.colors.mutedText,
    fontWeight: "500",
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  roleStartCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  roleStartIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primaryDark,
  },
  roleStartText: {
    flex: 1,
    minWidth: 0,
  },
  roleStartTitle: {
    color: theme.colors.onPrimary,
    fontWeight: "700",
  },
  roleStartBody: {
    color: theme.colors.onPrimary,
    opacity: 0.85,
    lineHeight: 18,
  },
  warningPanel: {
    gap: theme.spacing.md,
    borderColor: theme.colors.warning,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.warningSoft,
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
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  metricPillLabel: {
    flex: 1,
    color: theme.colors.mutedText,
    fontWeight: "700",
  },
  performerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  performerText: {
    flex: 1,
    minWidth: 0,
  },
  performerName: {
    color: theme.colors.text,
    fontWeight: "600",
  },
  performerMeta: {
    color: theme.colors.mutedText,
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
    fontWeight: "600",
  },
  teamMeta: {
    color: theme.colors.mutedText,
    fontWeight: "700",
  },
  routeStateShell: {
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  pressed: {
    opacity: 0.82,
  },
});
