import { nativeRoutes } from "@autoflow/shared";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  api,
  type MobileDashboardStats,
  type MobileDashboardTimeRange,
  type MobileDashboardTodayForRole,
  type MobileNotification,
} from "../../convexApi";
import { Card } from "../../components/Card";
import { Icon, type SemanticIconName } from "../../components/Icon";
import { SkeletonRow } from "../../components/SkeletonRow";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { money } from "../workspace/modules/moduleShared";
import {
  canAccessNativeModule,
  getNativeModule,
  labelFor,
  type NativeModuleId,
} from "../workspace/nativeModules";
import { plainNumber } from "./dashboardFormat";
import { useDashboardTypography } from "./dashboardTypography";
import {
  buildAlertRows,
  countSearchResults,
  deriveOverviewKpis,
  deriveTaskCentre,
  isSearchQueryActive,
  shouldStackHomeColumns,
  type HomeAlertRow,
  type HomeUpcomingPayments as UpcomingPaymentsSummary,
} from "./homeModel";
import { ProgressRing } from "./ProgressRing";

/**
 * Tones an ICON may take on this screen.
 *
 * Deliberately excludes `warning`: measured against its own soft background it
 * is 2.86:1 in the light theme, under the 3:1 WCAG 1.4.11 floor for non-text.
 * Every tone here clears 3:1 in BOTH themes on its soft background AND on
 * `surfaceAlt` — the two backgrounds icons actually land on here.
 * (light / dark, on soft) success 3.00/6.98 · info 3.57/6.84 · indigo 5.10/4.90
 * · primary 4.24/4.23 · accent 3.11/4.09.
 */
type PanelTone = "primary" | "success" | "info" | "indigo" | "accent";

/** Tones usable as a CHIP BACKGROUND, where the content is text-coloured. */
type ChipTone = PanelTone | "warning";

const toneSoftToken: Record<ChipTone, keyof AppTheme["colors"]> = {
  primary: "primarySoft",
  success: "successSoft",
  warning: "warningSoft",
  info: "infoSoft",
  indigo: "indigoSoft",
  accent: "accentSoft",
};

const TIME_RANGES: ReadonlyArray<{
  value: MobileDashboardTimeRange;
  labelKey: "timeRangeDay" | "timeRangeMonth" | "timeRangeYear" | "timeRangeAllTime";
}> = [
  { value: "DAY", labelKey: "timeRangeDay" },
  { value: "MONTH", labelKey: "timeRangeMonth" },
  { value: "YEAR", labelKey: "timeRangeYear" },
  { value: "ALL_TIME", labelKey: "timeRangeAllTime" },
];

/** Day-to-day destinations, in the order they fill the five action tiles. */
const QUICK_ACTION_CANDIDATES: ReadonlyArray<{ moduleId: NativeModuleId; tone: PanelTone }> = [
  { moduleId: "vehicles", tone: "success" },
  { moduleId: "customers", tone: "indigo" },
  { moduleId: "leads", tone: "accent" },
  { moduleId: "expenses", tone: "primary" },
  { moduleId: "messages", tone: "info" },
  { moduleId: "tasks", tone: "accent" },
  { moduleId: "settings", tone: "indigo" },
];

const QUICK_ACTION_LIMIT = 5;

/**
 * Analysis destinations for the 2×2 shortcuts panel. These icons sit directly
 * on `surfaceAlt`, so the tones are the subset that clears 3:1 there in both
 * themes: info 3.59/6.98 · indigo 5.51/5.01 · primary 4.53/4.07 · accent
 * 3.12/4.20.
 */
const SHORTCUT_CANDIDATES: ReadonlyArray<{ moduleId: NativeModuleId; tone: PanelTone }> = [
  { moduleId: "reports", tone: "info" },
  { moduleId: "sales", tone: "indigo" },
  { moduleId: "accounting", tone: "primary" },
  { moduleId: "team", tone: "accent" },
  { moduleId: "commissions", tone: "info" },
  { moduleId: "applications", tone: "indigo" },
];

const SHORTCUT_LIMIT = 4;

function useModulePush(orgId: string) {
  const router = useRouter();
  return (moduleId: NativeModuleId) =>
    router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId } });
}

function visibleModules(
  candidates: ReadonlyArray<{ moduleId: NativeModuleId; tone: PanelTone }>,
  permissions: readonly string[],
  roleName: string | undefined,
  limit: number,
) {
  const resolved = [];
  for (const candidate of candidates) {
    const definition = getNativeModule(candidate.moduleId);
    if (!definition) continue;
    if (!canAccessNativeModule(definition, permissions, roleName)) continue;
    resolved.push({ ...candidate, definition });
    if (resolved.length >= limit) break;
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shells
// ─────────────────────────────────────────────────────────────────────────────

export function PanelHeading({
  icon,
  title,
  trailing,
}: Readonly<{ icon: SemanticIconName; title: string; trailing?: ReactNode }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.panelHeading}>
      <Icon color="mutedText" name={icon} size={16} />
      <Text numberOfLines={1} style={[styles.panelTitle, type.heading]}>
        {title}
      </Text>
      <View style={styles.panelHeadingSpacer} />
      {trailing}
    </View>
  );
}

/** Full-width footer link, e.g. "View all tasks". */
export function PanelAction({
  label,
  onPress,
}: Readonly<{ label: string; onPress: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();
  const { textDirection } = useLocale();

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.panelAction, { direction: textDirection }, pressed && styles.pressed]}
      onPress={onPress}
    >
      <Text numberOfLines={1} style={[styles.panelActionText, type.label]}>
        {label}
      </Text>
      <Icon color="primary" name="chevronForward" size={15} />
    </Pressable>
  );
}

/**
 * Two panels side by side — but only where they fit.
 *
 * The design mock is 852px wide; the phones this ships to are 720px, which is a
 * 360dp screen and 328dp of usable container. Two 158dp columns cannot hold a
 * progress ring beside wrapped Arabic copy, so below the threshold the children
 * stack full width instead. Width comes from `onLayout` rather than
 * `Dimensions`, so a split-screen or foldable window is measured too.
 */
export function HomeTwoUp({
  first,
  second,
}: Readonly<{ first: ReactNode; second: ReactNode }>) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const stacked = shouldStackHomeColumns(width);

  return (
    <View
      style={stacked ? styles.twoUpStacked : styles.twoUpRow}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={stacked ? styles.twoUpFull : styles.twoUpHalf}>{first}</View>
      <View style={stacked ? styles.twoUpFull : styles.twoUpHalf}>{second}</View>
    </View>
  );
}

function PanelEmpty({ text }: Readonly<{ text: string }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();
  return <Text style={[styles.panelEmpty, type.body]}>{text}</Text>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search + period filter
// ─────────────────────────────────────────────────────────────────────────────

function SearchResultRow({
  caption,
  icon,
  onPress,
  title,
}: Readonly<{ caption: string; icon: SemanticIconName; onPress: () => void; title: string }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();
  const { textDirection } = useLocale();

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      style={({ pressed }) => [styles.searchRow, { direction: textDirection }, pressed && styles.pressed]}
      onPress={onPress}
    >
      <Icon color="subtleText" name={icon} size={18} />
      <View style={styles.searchRowText}>
        <Text numberOfLines={1} style={[styles.searchRowTitle, type.body]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.searchRowCaption, type.caption]}>
          {caption}
        </Text>
      </View>
      <Icon color="subtleText" name="chevronForward" size={15} />
    </Pressable>
  );
}

/**
 * Workspace search backed by `search.globalSearch` — the same permission-gated
 * query the web app uses. It stays skipped until the query clears the server's
 * own two-character floor, so typing one letter costs nothing.
 */
export function HomeSearchRow({
  orgId,
  timeRange,
  onChangeTimeRange,
}: Readonly<{
  orgId: string;
  timeRange: MobileDashboardTimeRange;
  onChangeTimeRange: (value: MobileDashboardTimeRange) => void;
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const [term, setTerm] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const active = isSearchQueryActive(term);
  const results = useQuery(
    api.search.globalSearch,
    active ? { orgId, query: term.trim() } : "skip",
  );
  const loading = active && results === undefined;
  const total = countSearchResults(results);

  return (
    <View style={styles.searchSection}>
      <View style={[styles.searchRowShell, { direction: textDirection }]}>
        <View style={styles.searchField}>
          <Icon color="subtleText" name="search" size={18} />
          <TextInput
            accessibilityLabel={t("dealerHomeSearchLabel")}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("dealerHomeSearchPlaceholder")}
            placeholderTextColor={theme.colors.subtleText}
            returnKeyType="search"
            style={[styles.searchInput, type.body]}
            value={term}
            onChangeText={setTerm}
          />
          {term.length > 0 ? (
            <Pressable
              accessibilityLabel={t("workspaceClearSearch")}
              accessibilityRole="button"
              style={({ pressed }) => [pressed && styles.pressed]}
              onPress={() => setTerm("")}
            >
              <Icon color="subtleText" name="close" size={17} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityHint={t("dealerHomeFilterHint")}
          accessibilityRole="button"
          accessibilityState={{ expanded: filterOpen }}
          style={({ pressed }) => [
            styles.filterButton,
            filterOpen && styles.filterButtonActive,
            pressed && styles.pressed,
          ]}
          onPress={() => setFilterOpen((previous) => !previous)}
        >
          <Icon color="primary" name="filter" size={17} />
          <Text numberOfLines={1} style={[styles.filterButtonText, type.label]}>
            {t("dealerHomeFilter")}
          </Text>
        </Pressable>
      </View>

      {filterOpen ? (
        <View style={[styles.segmentedControl, { direction: textDirection }]}>
          {TIME_RANGES.map((range) => {
            const selected = range.value === timeRange;
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
                onPress={() => onChangeTimeRange(range.value)}
              >
                <Text style={[styles.segmentText, type.label, selected && styles.segmentTextSelected]}>
                  {t(range.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {term.trim().length > 0 && !active ? (
        <Card style={styles.searchResults}>
          <PanelEmpty text={t("dealerHomeSearchHint")} />
        </Card>
      ) : null}

      {loading ? (
        <Card style={styles.searchResults}>
          <SkeletonRow count={2} />
        </Card>
      ) : null}

      {active && !loading ? (
        <Card style={styles.searchResults}>
          {total === 0 ? <PanelEmpty text={t("dealerHomeSearchEmpty")} /> : null}
          {(results?.vehicles ?? []).map((vehicle) => (
            <SearchResultRow
              key={`vehicle-${vehicle.id}`}
              caption={t("vehiclesUpper")}
              icon="vehicles"
              title={`${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()}
              onPress={() =>
                router.push({
                  pathname: "/org/[orgId]/vehicles/[vehicleId]" as never,
                  params: { orgId, vehicleId: vehicle.id },
                })
              }
            />
          ))}
          {(results?.customers ?? []).map((customer) => (
            <SearchResultRow
              key={`customer-${customer.id}`}
              caption={t("dealerHomeCustomers")}
              icon="customers"
              title={`${customer.firstName} ${customer.lastName}`.trim()}
              onPress={() =>
                router.push({
                  pathname: "/org/[orgId]/customers/[customerId]" as never,
                  params: { orgId, customerId: customer.id },
                })
              }
            />
          ))}
          {(results?.leads ?? []).map((lead) => (
            <SearchResultRow
              key={`lead-${lead.id}`}
              caption={t("leadsUpper")}
              icon="leads"
              title={lead.customerName}
              onPress={() =>
                router.push({
                  pathname: nativeRoutes.orgModule,
                  params: { orgId, moduleId: "leads", highlightId: lead.id },
                })
              }
            />
          ))}
        </Card>
      ) : null}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Today's overview
// ─────────────────────────────────────────────────────────────────────────────

function KpiColumn({
  amount,
  icon,
  label,
  tone,
}: Readonly<{ amount: string; icon: SemanticIconName; label: string; tone: PanelTone }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.kpiColumn}>
      <View style={[styles.kpiIconShell, { backgroundColor: theme.colors[toneSoftToken[tone]] }]}>
        <Icon color={tone} name={icon} size={18} />
      </View>
      <Text numberOfLines={2} style={[styles.kpiLabel, type.caption]}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.kpiValue, type.heading]}>
        {amount}
      </Text>
    </View>
  );
}

/**
 * The three headline figures, all from `dashboard.stats` for the selected
 * period.
 *
 * The mock also shows a coloured "+12% ↑" delta beside each figure. There is no
 * previous-period total anywhere in the backend to compute one from, and the
 * only way to fake it from this payload would be to compare two arbitrary
 * buckets of a sparse trend series and label the result a month-over-month
 * change. The delta is left out rather than invented — see the PR description
 * for the `dashboard.stats` change that would make it real.
 */
export function HomeOverviewCard({
  currency,
  detailsExpanded,
  onToggleDetails,
  stats,
}: Readonly<{
  currency: string;
  detailsExpanded: boolean;
  onToggleDetails: () => void;
  stats: MobileDashboardStats | undefined;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  if (stats === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="calendar" title={t("dealerHomeTodayOverview")} />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const kpis = deriveOverviewKpis(stats);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading
        icon="calendar"
        title={t("dealerHomeTodayOverview")}
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsExpanded }}
            style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
            onPress={onToggleDetails}
          >
            <Text numberOfLines={1} style={[styles.inlineActionText, type.label]}>
              {detailsExpanded ? t("dealerHomeHideDetails") : t("dealerHomeViewDetails")}
            </Text>
            <Icon color="primary" name={detailsExpanded ? "chevronUp" : "chevronDown"} size={14} />
          </Pressable>
        }
      />
      <View style={styles.kpiRow}>
        <KpiColumn
          amount={money(kpis.sales, locale, currency)}
          icon="sales"
          label={t("dealerHomeKpiSales")}
          tone="info"
        />
        <View style={styles.kpiDivider} />
        <KpiColumn
          amount={money(kpis.expenses, locale, currency)}
          icon="expenses"
          label={t("dealerHomeKpiExpenses")}
          tone="accent"
        />
        <View style={styles.kpiDivider} />
        <KpiColumn
          amount={money(kpis.netProfit, locale, currency)}
          icon="reports"
          label={t("dealerHomeKpiNetProfit")}
          tone="success"
        />
      </View>
      {stats.truncated?.sales ? (
        <Text style={[styles.panelNote, type.caption]}>{t("todayForRolePartialTotal")}</Text>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick actions
// ─────────────────────────────────────────────────────────────────────────────

export function HomeQuickActions({
  orgId,
  permissions,
  roleName,
}: Readonly<{ orgId: string; permissions: readonly string[]; roleName: string | undefined }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { locale, textDirection } = useLocale();
  const type = useDashboardTypography();
  const actions = visibleModules(QUICK_ACTION_CANDIDATES, permissions, roleName, QUICK_ACTION_LIMIT);

  if (actions.length === 0) {
    return null;
  }

  return (
    <View style={[styles.quickRail, { direction: textDirection }]}>
      {actions.map((action) => (
        <Pressable
          key={action.moduleId}
          accessibilityLabel={labelFor(action.definition.title, locale)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.quickRailItem, pressed && styles.pressed]}
          onPress={() => pushModule(action.moduleId)}
        >
          <View
            style={[
              styles.quickRailIconShell,
              { backgroundColor: theme.colors[toneSoftToken[action.tone]] },
            ]}
          >
            <Icon color={action.tone} name={action.definition.icon} size={19} />
          </View>
          <Text numberOfLines={1} style={[styles.quickRailText, type.label]}>
            {labelFor(action.definition.title, locale)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task centre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status chip. The tone tints the background only — the number renders in
 * `text` and the label in `mutedText`, which measure 12.3–16.3:1 and 4.7–6.4:1
 * on these tints. Colouring the number with its own tone would put
 * `warning` on `warningSoft` at 2.86:1 in the light theme.
 */
function TaskChip({ label, tone, value }: Readonly<{ label: string; tone: ChipTone; value: string }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={[styles.taskChip, { backgroundColor: theme.colors[toneSoftToken[tone]] }]}>
      <Text numberOfLines={1} style={[styles.taskChipValue, type.heading]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[styles.taskChipLabel, type.caption]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Task ring plus a status breakdown.
 *
 * The mock shows four chips — overdue, in progress, in review, completed. Task
 * status server-side is PENDING | COMPLETED | CANCELLED; there is no review
 * state, so that chip is absent rather than filled with a number that would
 * mean nothing.
 */
export function HomeTaskCentre({
  canViewTasks,
  orgId,
  stats,
}: Readonly<{ canViewTasks: boolean; orgId: string; stats: MobileDashboardStats | undefined }>) {
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  if (stats === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="tasks" title={t("dealerHomeTaskCentre")} />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const summary = deriveTaskCentre(stats);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="tasks" title={t("dealerHomeTaskCentre")} />
      {summary.total === 0 ? (
        <PanelEmpty text={t("dealerHomeTaskCentreEmpty")} />
      ) : (
        <>
          <View style={styles.taskTopRow}>
            <ProgressRing
              caption={t("dealerHomeTasksCompletedCaption")}
              label={`${plainNumber(summary.completed, locale)}/${plainNumber(summary.total, locale)}`}
              ratio={summary.ratio}
            />
            <Text style={[styles.taskBody, type.body]}>
              {summary.open > 0
                ? `${plainNumber(summary.open, locale)} ${t("dealerHomeTaskCentreBody")}`
                : t("dealerHomeTaskCentreDone")}
            </Text>
          </View>
          <View style={styles.taskChipRow}>
            <TaskChip
              label={t("overdue")}
              tone="warning"
              value={plainNumber(summary.overdue, locale)}
            />
            <TaskChip
              label={t("pending")}
              tone="info"
              value={plainNumber(summary.inProgress, locale)}
            />
            <TaskChip
              label={t("completed")}
              tone="success"
              value={plainNumber(summary.completed, locale)}
            />
          </View>
        </>
      )}
      {canViewTasks ? (
        <PanelAction label={t("dealerHomeViewAllTasks")} onPress={() => pushModule("tasks")} />
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shortcuts & reports
// ─────────────────────────────────────────────────────────────────────────────

export function HomeShortcuts({
  orgId,
  permissions,
  roleName,
}: Readonly<{ orgId: string; permissions: readonly string[]; roleName: string | undefined }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  const shortcuts = visibleModules(SHORTCUT_CANDIDATES, permissions, roleName, SHORTCUT_LIMIT);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="reports" title={t("dealerHomeShortcuts")} />
      {shortcuts.length === 0 ? (
        <PanelEmpty text={t("dealerHomeShortcutsEmpty")} />
      ) : (
        <View style={styles.shortcutGrid}>
          {shortcuts.map((shortcut) => (
            <Pressable
              key={shortcut.moduleId}
              accessibilityLabel={labelFor(shortcut.definition.title, locale)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.shortcutTile, pressed && styles.pressed]}
              onPress={() => pushModule(shortcut.moduleId)}
            >
              <Icon color={shortcut.tone} name={shortcut.definition.icon} size={20} />
              <Text numberOfLines={1} style={[styles.shortcutTitle, type.body]}>
                {labelFor(shortcut.definition.title, locale)}
              </Text>
              <Text numberOfLines={2} style={[styles.shortcutBody, type.caption]}>
                {labelFor(shortcut.definition.subtitle, locale)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upcoming payments
// ─────────────────────────────────────────────────────────────────────────────

function todayBadgeParts(locale: "en" | "ar", now: Date) {
  const tag = locale === "ar" ? "ar-JO" : "en-US";
  const safe = (options: Intl.DateTimeFormatOptions, fallback: string) => {
    try {
      return new Intl.DateTimeFormat(tag, options).format(now);
    } catch {
      return fallback;
    }
  };

  return {
    day: safe({ day: "numeric" }, String(now.getDate())),
    month: safe({ month: "long" }, ""),
    weekday: safe({ weekday: "long" }, ""),
  };
}

/**
 * Collections due today and cheques due this week, from `dashboard.todayForRole`
 * — the same query the previous accountant panel used, laid out as the design's
 * date badge + count + total. Overdue receivables keep their own line so they
 * are never folded into a total that reads as healthy.
 */
export function HomeUpcomingPayments({
  orgId,
  summary,
  todayForRole,
}: Readonly<{
  orgId: string;
  summary: UpcomingPaymentsSummary;
  todayForRole: MobileDashboardTodayForRole | undefined;
}>) {
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  if (todayForRole === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="calendar" title={t("dealerHomeUpcomingPayments")} />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const currency = todayForRole.currency;
  const badge = todayBadgeParts(locale, new Date());

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="calendar" title={t("dealerHomeUpcomingPayments")} />
      {summary.isEmpty ? (
        <PanelEmpty text={t("dealerHomeUpcomingPaymentsEmpty")} />
      ) : (
        <View style={styles.paymentsRow}>
          <View style={styles.dateBadge}>
            <Text numberOfLines={1} style={[styles.dateBadgeMonth, type.caption]}>
              {badge.month}
            </Text>
            <Text numberOfLines={1} style={[styles.dateBadgeDay, type.title]}>
              {badge.day}
            </Text>
            <Text numberOfLines={1} style={[styles.dateBadgeWeekday, type.caption]}>
              {badge.weekday}
            </Text>
          </View>
          <View style={styles.paymentsText}>
            <Text numberOfLines={2} style={[styles.paymentsCount, type.body]}>
              {`${plainNumber(summary.count, locale)} ${t("dealerHomeUpcomingPaymentsCount")}`}
            </Text>
            <Text numberOfLines={1} style={[styles.paymentsTotalLabel, type.caption]}>
              {t("dealerHomeUpcomingPaymentsTotal")}
            </Text>
            <Text numberOfLines={1} style={[styles.paymentsTotal, type.title]}>
              {money(summary.amount, locale, currency)}
            </Text>
            {summary.overdueCount > 0 ? (
              <Text numberOfLines={2} style={[styles.paymentsOverdue, type.caption]}>
                {`${t("overdueReceivables")}: ${money(summary.overdueAmount, locale, currency)} · ${plainNumber(summary.overdueCount, locale)}`}
              </Text>
            ) : null}
          </View>
        </View>
      )}
      {todayForRole.truncated ? (
        <Text style={[styles.panelNote, type.caption]}>{t("todayForRolePartialTotal")}</Text>
      ) : null}
      <PanelAction
        label={t("dealerHomeViewUpcomingPayments")}
        onPress={() => pushModule("accounting")}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────────────

function AlertRow({ orgId, row }: Readonly<{ orgId: string; row: HomeAlertRow }>) {
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  const isApprovals = row.kind === "approvals";
  const title = isApprovals
    ? `${plainNumber(row.count, locale)} ${t("todayAgendaApprovalsWaiting")}`
    : row.title || t("dealerHomeAlertUntitled");
  const meta = isApprovals ? t("dealerHomeJustNow") : t(row.timeKey);
  const unread = isApprovals || row.unread;

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      style={({ pressed }) => [styles.alertRow, { direction: textDirection }, pressed && styles.pressed]}
      onPress={() => pushModule(isApprovals ? "approvals" : "notifications")}
    >
      {/* `accent`, not `warning`: this icon sits on `surfaceAlt`, where warning
          measures 2.79:1 in the light theme and accent measures 3.12:1. */}
      <Icon color={unread ? "accent" : "subtleText"} name="notifications" size={16} />
      <Text numberOfLines={2} style={[styles.alertTitle, type.body]}>
        {title}
      </Text>
      <Text numberOfLines={1} style={[styles.alertMeta, type.caption]}>
        {meta}
      </Text>
    </Pressable>
  );
}

/**
 * Everything asking for attention: pending approvals first, then the caller's
 * own unarchived notifications. `notifications` stays `undefined` until the
 * query resolves so the panel shows a skeleton — rendering the empty state
 * while loading is the "flashes 'no results'" regression Wave 1 fixed.
 */
export function HomeAlerts({
  notifications,
  orgId,
  pendingApprovals,
}: Readonly<{
  notifications: readonly MobileNotification[] | undefined;
  orgId: string;
  pendingApprovals: number;
}>) {
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { t, textDirection } = useLocale();

  if (notifications === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="notifications" title={t("dealerHomeAlerts")} />
        <SkeletonRow count={3} />
      </Card>
    );
  }

  const rows = buildAlertRows({ notifications, pendingApprovals, now: Date.now() });

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <PanelHeading icon="notifications" title={t("dealerHomeAlerts")} />
      {rows.length === 0 ? (
        <PanelEmpty text={t("dealerHomeAlertsEmpty")} />
      ) : (
        <View style={styles.alertList}>
          {rows.map((row) => (
            <AlertRow key={row.key} orgId={orgId} row={row} />
          ))}
        </View>
      )}
      <PanelAction
        label={t("dealerHomeViewAllAlerts")}
        onPress={() => pushModule("notifications")}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace banner
// ─────────────────────────────────────────────────────────────────────────────

export function HomeMarketplaceBanner({ orgId }: Readonly<{ orgId: string }>) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const type = useDashboardTypography();

  return (
    <Card
      accessibilityLabel={t("dealerMarketplace")}
      style={[styles.marketplaceBanner, { direction: textDirection }]}
      onPress={() =>
        router.push({ pathname: nativeRoutes.orgMarketplace, params: { orgId } })
      }
    >
      <View style={styles.marketplaceIcon}>
        <Icon color="primary" name="marketplace" size={24} />
      </View>
      <View style={styles.marketplaceText}>
        <Text numberOfLines={1} style={[styles.marketplaceTitle, type.heading]}>
          {t("dealerMarketplace")}
        </Text>
        <Text numberOfLines={2} style={[styles.marketplaceBody, type.caption]}>
          {t("dealerMarketplaceSubtitle")}
        </Text>
        <View style={styles.marketplaceCta}>
          <Text numberOfLines={1} style={[styles.marketplaceCtaText, type.label]}>
            {t("dealerHomeOpenMarketplace")}
          </Text>
        </View>
      </View>
      <Icon color="primary" name="chevronForward" size={20} />
    </Card>
  );
}

/** Compact figure for the expanded "details" area of the overview card. */
export function HomeDetailStat({
  caption,
  label,
  value,
}: Readonly<{ caption: string; label: string; value: string }>) {
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.detailStat}>
      <Text numberOfLines={1} style={[styles.detailStatLabel, type.caption]}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.detailStatValue, type.heading]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[styles.detailStatCaption, type.caption]}>
        {caption}
      </Text>
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  // Panels sit on `surface` over the screen's `background`. That pairing is the
  // app's elevation contract (1.116:1 in the light theme) — the design mock put
  // near-white cards on pure white, 1.009:1, which disappears in daylight.
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
  },
  panelHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  panelHeadingSpacer: {
    flex: 1,
    minWidth: 0,
  },
  panelTitle: {
    flexShrink: 1,
    color: theme.colors.text,
    fontWeight: "700",
  },
  panelEmpty: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
  },
  panelNote: {
    color: theme.colors.mutedText,
    fontStyle: "italic",
  },
  panelAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    // Nested surface inside a card: `surfaceAlt` on `surface` is 1.140:1, so the
    // control reads as a control without needing a hairline to survive.
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  panelActionText: {
    flexShrink: 1,
    color: theme.colors.primary,
    fontWeight: "700",
    textTransform: "none",
  },
  inlineAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  inlineActionText: {
    color: theme.colors.primary,
    fontWeight: "700",
    textTransform: "none",
  },
  twoUpRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing.md,
  },
  twoUpStacked: {
    gap: theme.spacing.lg,
  },
  twoUpHalf: {
    flex: 1,
    minWidth: 0,
  },
  twoUpFull: {
    width: "100%",
  },
  searchSection: {
    gap: theme.spacing.sm,
  },
  searchRowShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  searchField: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    ...theme.shadows.sm,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.text,
    paddingVertical: theme.spacing.sm,
  },
  filterButton: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    ...theme.shadows.sm,
  },
  filterButtonActive: {
    backgroundColor: theme.colors.primarySoft,
  },
  filterButtonText: {
    color: theme.colors.primary,
    fontWeight: "700",
    textTransform: "none",
  },
  searchResults: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  searchRowText: {
    flex: 1,
    minWidth: 0,
  },
  searchRowTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  searchRowCaption: {
    color: theme.colors.mutedText,
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
    fontWeight: "600",
    textTransform: "none",
  },
  segmentTextSelected: {
    color: theme.colors.text,
  },
  kpiRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  kpiColumn: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  kpiDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing.sm,
  },
  kpiIconShell: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  kpiLabel: {
    color: theme.colors.mutedText,
    fontWeight: "600",
  },
  kpiValue: {
    color: theme.colors.text,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  quickRail: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  quickRailItem: {
    flex: 1,
    minWidth: 0,
    minHeight: 78,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 2,
    paddingVertical: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  quickRailIconShell: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
  quickRailText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0,
    textAlign: "center",
    textTransform: "none",
  },
  taskTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  taskBody: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
  },
  taskChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  taskChip: {
    flexGrow: 1,
    flexBasis: 78,
    alignItems: "center",
    gap: 2,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  taskChipValue: {
    color: theme.colors.text,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  taskChipLabel: {
    color: theme.colors.mutedText,
    fontWeight: "600",
    textAlign: "center",
  },
  shortcutGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  shortcutTile: {
    flexGrow: 1,
    flexBasis: 128,
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.sm,
  },
  shortcutTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  shortcutBody: {
    color: theme.colors.mutedText,
  },
  paymentsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  dateBadge: {
    minWidth: 78,
    alignItems: "center",
    gap: 2,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  dateBadgeMonth: {
    color: theme.colors.mutedText,
    fontWeight: "600",
  },
  dateBadgeDay: {
    color: theme.colors.text,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  dateBadgeWeekday: {
    color: theme.colors.mutedText,
  },
  paymentsText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  paymentsCount: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  paymentsTotalLabel: {
    color: theme.colors.mutedText,
  },
  paymentsTotal: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  paymentsOverdue: {
    color: theme.colors.danger,
    fontWeight: "600",
  },
  alertList: {
    gap: theme.spacing.xs,
  },
  alertRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  alertTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  alertMeta: {
    color: theme.colors.mutedText,
  },
  marketplaceBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
  },
  marketplaceIcon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
  },
  marketplaceText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  marketplaceTitle: {
    color: theme.colors.text,
    fontWeight: "700",
  },
  marketplaceBody: {
    color: theme.colors.mutedText,
    lineHeight: 18,
  },
  marketplaceCta: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  marketplaceCtaText: {
    color: theme.colors.primary,
    fontWeight: "700",
    textTransform: "none",
  },
  detailStat: {
    flexGrow: 1,
    flexBasis: 128,
    gap: 2,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.sm,
  },
  detailStatLabel: {
    color: theme.colors.mutedText,
    fontWeight: "700",
  },
  detailStatValue: {
    color: theme.colors.text,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  detailStatCaption: {
    color: theme.colors.mutedText,
  },
  pressed: {
    opacity: 0.82,
  },
});
