import { nativeRoutes } from "@autoflow/shared";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I18nManager, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  api,
  type MobileDashboardStats,
  type MobileDashboardTimeRange,
  type MobileDashboardTodayForRole,
  type MobileNotification,
} from "../../convexApi";
import { Card } from "../../components/Card";
import { Icon, type SemanticIconName } from "../../components/Icon";
import { parseNotificationLink } from "../../components/NotificationBell";
import { SkeletonRow } from "../../components/SkeletonRow";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles, useThemeMode } from "../../providers/ThemeProvider";
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
  deriveKpiDelta,
  deriveOverviewKpis,
  deriveTaskCentre,
  isSearchQueryActive,
  readPreviousPeriod,
  shouldStackHomeColumns,
  taskRingSide,
  HOME_QUICK_ACTION_LABEL_LINES,
  type HomeAlertRow,
  type HomeKpiDelta,
  type HomeUpcomingPayments as UpcomingPaymentsSummary,
} from "./homeModel";
import { GradientSurface, GradientTile, HOME_RADIUS, IconGlow, toneBorder } from "./HomeVisuals";
import { ProgressRing } from "./ProgressRing";

/**
 * The five accents the mock gives the quick-action rail, keyed by module rather
 * than by position — which tiles a role sees depends on its permissions, and an
 * accent that shifted with the filtered list would make the rail a different
 * screen for every role.
 *
 * Sampled left→right from DESIGN-dark.png; the screen is RTL, so the *rightmost*
 * tile in the image is the first item in the list.
 *
 * Thirteen modules share five accents, so a rail filtered down to an unusual
 * permission set can repeat one. That is accepted rather than resolved by
 * assigning accents per rendered position: the alternative would mean the same
 * module wears a different colour for a manager than for an owner, which is a
 * worse property than two amber tiles. The accent is decorative — every tile
 * carries its own text label, and the labels are what disambiguate them.
 */
type HomeAccentToken = Extract<keyof AppTheme["colors"], `homeTile${string}`>;

const MODULE_ACCENTS: Partial<Record<NativeModuleId, HomeAccentToken>> = {
  vehicles: "homeTileGreen",
  customers: "homeTileAmber",
  leads: "homeTileViolet",
  expenses: "homeTileIndigo",
  messages: "homeTileBlue",
  tasks: "homeTileAmber",
  settings: "homeTileViolet",
  reports: "homeTileBlue",
  sales: "homeTileIndigo",
  accounting: "homeTileViolet",
  team: "homeTileBlue",
  commissions: "homeTileAmber",
  applications: "homeTileGreen",
};

const FALLBACK_ACCENT: HomeAccentToken = "homeTileBlue";

/**
 * How loud the icon halo is, per theme.
 *
 * The dark mock's glow is unmistakable — the accent's excess over the tile
 * background peaks around +28/255. The light mock barely lifts off white; the
 * same gradient at full strength would be a smudge. One multiplier keeps a
 * single gradient definition faithful to both.
 */
const GLOW_STRENGTH = { dark: 1, light: 0.34 } as const;

/** Halo diameter. The mock's falloff is gone by ~24dp from the icon's centre. */
const QUICK_ACTION_GLOW_SIZE = 46;

function accentTokenFor(moduleId: NativeModuleId): HomeAccentToken {
  return MODULE_ACCENTS[moduleId] ?? FALLBACK_ACCENT;
}

/** The four status chips, each with its own fill and its own text colour. */
type ChipTone = "danger" | "warning" | "info" | "success";

const chipTokens: Record<
  ChipTone,
  Readonly<{ surface: keyof AppTheme["colors"]; text: keyof AppTheme["colors"] }>
> = {
  danger: { surface: "homeChipDangerSurface", text: "homeChipDangerText" },
  warning: { surface: "homeChipWarningSurface", text: "homeChipWarningText" },
  info: { surface: "homeChipInfoSurface", text: "homeChipInfoText" },
  success: { surface: "homeChipSuccessSurface", text: "homeChipSuccessText" },
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
const QUICK_ACTION_CANDIDATES: readonly NativeModuleId[] = [
  "vehicles",
  "customers",
  "leads",
  "expenses",
  "messages",
  "tasks",
  "settings",
];

const QUICK_ACTION_LIMIT = 5;

/** Analysis destinations for the 2×2 shortcuts panel. */
const SHORTCUT_CANDIDATES: readonly NativeModuleId[] = [
  "reports",
  "sales",
  "accounting",
  "team",
  "commissions",
  "applications",
];

const SHORTCUT_LIMIT = 4;

/** Long enough to swallow a burst of typing, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 250;

function useModulePush(orgId: string) {
  const router = useRouter();
  return (moduleId: NativeModuleId) =>
    router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId } });
}

function visibleModules(
  candidates: readonly NativeModuleId[],
  permissions: readonly string[],
  roleName: string | undefined,
  limit: number,
) {
  const resolved = [];
  for (const moduleId of candidates) {
    const definition = getNativeModule(moduleId);
    if (!definition) continue;
    if (!canAccessNativeModule(definition, permissions, roleName)) continue;
    resolved.push({ moduleId, accent: accentTokenFor(moduleId), definition });
    if (resolved.length >= limit) break;
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shells
// ─────────────────────────────────────────────────────────────────────────────

export function PanelHeading({
  icon,
  iconColor = "mutedText",
  title,
  titleColor,
  trailing,
}: Readonly<{
  icon: SemanticIconName;
  /** The mock tints a tinted panel's heading icon in that panel's tone. */
  iconColor?: keyof AppTheme["colors"];
  title: string;
  titleColor?: keyof AppTheme["colors"];
  trailing?: ReactNode;
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.panelHeading}>
      <Icon color={iconColor} name={icon} size={18} />
      <Text
        numberOfLines={1}
        style={[styles.panelTitle, type.heading, titleColor && { color: theme.colors[titleColor] }]}
      >
        {title}
      </Text>
      <View style={styles.panelHeadingSpacer} />
      {trailing}
    </View>
  );
}

/**
 * Full-width footer link, e.g. "View all tasks".
 *
 * The mock draws it as an outlined pill in the panel's own tone rather than as a
 * filled grey bar — green inside the payments card, amber inside the alerts
 * card, blue everywhere else.
 */
export function PanelAction({
  label,
  onPress,
  tone = "primary",
}: Readonly<{ label: string; onPress: () => void; tone?: keyof AppTheme["colors"] }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();
  const { textDirection } = useLocale();
  const toneColor = theme.colors[tone];

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.panelAction,
        { borderColor: toneBorder(toneColor, 0.34), direction: textDirection },
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Text numberOfLines={1} style={[styles.panelActionText, type.label, { color: toneColor }]}>
        {label}
      </Text>
      <Icon color={tone} name="chevronForward" size={15} />
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
      testID="home-two-up"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={stacked ? styles.twoUpFull : styles.twoUpHalf} testID="home-two-up-first">
        {first}
      </View>
      <View style={stacked ? styles.twoUpFull : styles.twoUpHalf} testID="home-two-up-second">
        {second}
      </View>
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
  const [settledTerm, setSettledTerm] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  // Every distinct argument object tears down the live subscription and opens a
  // new one, and `search.globalSearch` runs four search-index scans per call.
  // Without this, typing "camry" fires four full searches. The two-character
  // floor governs when searching starts, not how often it restarts.
  useEffect(() => {
    const handle = setTimeout(() => setSettledTerm(term), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [term]);

  const active = isSearchQueryActive(settledTerm);
  const results = useQuery(
    api.search.globalSearch,
    active ? { orgId, query: settledTerm.trim() } : "skip",
  );
  // Still typing counts as loading, so the previous term's results are never
  // shown against the new one.
  const loading = (active && results === undefined) || term.trim() !== settledTerm.trim();
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

      {term.trim().length > 0 && !isSearchQueryActive(term) ? (
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

/**
 * The mock's "+12% ↑" / "−5% ↓".
 *
 * Rendered only from a real previous-period total. When `dashboard.stats`
 * carries none — ALL_TIME, an unreadable figure, a truncated one — this
 * collapses to nothing rather than to a reserved blank line: the KPI column is
 * a plain vertical stack with a gap, so an absent delta leaves no hole for the
 * eye to land in.
 */
function KpiDelta({ delta }: Readonly<{ delta: HomeKpiDelta | null }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const type = useDashboardTypography();

  if (!delta) {
    return null;
  }

  const rising = delta.direction === "up";
  // U+2212 MINUS SIGN, not a hyphen: it aligns with the digits and survives the
  // RTL bidi run instead of being reordered as punctuation.
  const sign = rising ? "+" : "−";

  return (
    <View style={styles.kpiDelta}>
      <Text
        numberOfLines={1}
        style={[styles.kpiDeltaText, type.caption, rising ? styles.kpiDeltaUp : styles.kpiDeltaDown]}
        testID={`kpi-delta-${delta.direction}`}
      >
        {`${sign}${plainNumber(delta.percent, locale)}%`}
      </Text>
      <Icon
        color={rising ? "homeDeltaUp" : "homeDeltaDown"}
        name={rising ? "arrowUp" : "arrowDown"}
        size={13}
      />
    </View>
  );
}

function KpiColumn({
  amount,
  delta,
  icon,
  iconToken,
  label,
  softToken,
}: Readonly<{
  amount: string;
  delta: HomeKpiDelta | null;
  icon: SemanticIconName;
  iconToken: keyof AppTheme["colors"];
  label: string;
  softToken: keyof AppTheme["colors"];
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();

  return (
    <View style={styles.kpiColumn}>
      <View style={styles.kpiHeadRow}>
        <View
          style={[
            styles.kpiIconShell,
            {
              backgroundColor: theme.colors[softToken],
              borderColor: toneBorder(theme.colors[iconToken], 0.22),
            },
          ]}
        >
          <Icon color={iconToken} name={icon} size={19} />
        </View>
        {/*
          One line that shrinks, never two that wrap.

          The mock puts the badge beside the label rather than above it, which
          on a 720px screen leaves this column ~95px wide. `numberOfLines={2}`
          let React Native fill that second line by breaking *inside* a word:
          "المصاريف" rendered as "المصاري" + an orphaned "ف". Arabic is cursive,
          so a mid-word break also severs the joined letterforms — it is not the
          Latin equivalent of an ugly hyphenation, it is malformed text. These
          labels are single words with no space to break at, so wrapping can
          only ever break badly.

          `adjustsFontSizeToFit` scales the glyphs down instead, which keeps the
          whole word intact and avoids the ellipsis that truncating would bring
          back.
        */}
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.75}
          numberOfLines={1}
          style={[styles.kpiLabel, type.caption]}
        >
          {label}
        </Text>
      </View>
      <Text numberOfLines={1} style={[styles.kpiValue, type.heading]}>
        {amount}
      </Text>
      <KpiDelta delta={delta} />
    </View>
  );
}

/**
 * The three headline figures, all from `dashboard.stats` for the selected
 * period.
 *
 * The mock's coloured "+12% ↑" delta under each figure comes from
 * `stats.previousPeriod` — the same three totals for the window before this
 * one. Nothing is derived from the trend series here: subtracting two of its
 * buckets would be a two-day comparison wearing a month-over-month label. When
 * a previous total is absent the delta collapses; see `readPreviousPeriod` in
 * homeModel for when that happens.
 */
export function HomeOverviewCard({
  currency,
  detailsExpanded,
  onToggleDetails,
  stats,
}: Readonly<{
  /** `undefined` until the workspace currency is known — see the skeleton below. */
  currency: string | undefined;
  detailsExpanded: boolean;
  onToggleDetails: () => void;
  stats: MobileDashboardStats | undefined;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();

  // Money cannot be rendered before its unit is known. Formatting in JOD and
  // then re-rendering in the real currency a tick later shows the dealer a
  // number that was briefly, confidently wrong.
  if (stats === undefined || currency === undefined) {
    return (
      <Card style={[styles.panel, { direction: textDirection }]}>
        <PanelHeading icon="calendar" title={t("dealerHomeTodayOverview")} />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const kpis = deriveOverviewKpis(stats);
  const previous = readPreviousPeriod(stats);

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
          delta={deriveKpiDelta(kpis.sales, previous?.sales)}
          icon="reports"
          iconToken="homeKpiSalesIcon"
          label={t("dealerHomeKpiSales")}
          softToken="homeKpiSalesSoft"
        />
        <View style={styles.kpiDivider} />
        <KpiColumn
          amount={money(kpis.expenses, locale, currency)}
          delta={deriveKpiDelta(kpis.expenses, previous?.expenses)}
          icon="finance"
          iconToken="homeKpiExpenseIcon"
          label={t("dealerHomeKpiExpenses")}
          softToken="homeKpiExpenseSoft"
        />
        <View style={styles.kpiDivider} />
        <KpiColumn
          amount={money(kpis.netProfit, locale, currency)}
          delta={deriveKpiDelta(kpis.netProfit, previous?.netProfit)}
          icon="trendUp"
          iconToken="homeKpiProfitIcon"
          label={t("dealerHomeKpiNetProfit")}
          softToken="homeKpiProfitSoft"
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
  const { mode } = useThemeMode();
  const glowStrength = GLOW_STRENGTH[mode];
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
      {actions.map((action) => {
        const accent = theme.colors[action.accent];
        return (
          <Pressable
            key={action.moduleId}
            accessibilityLabel={labelFor(action.definition.title, locale)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.quickRailItem,
              { borderColor: toneBorder(accent, glowStrength * 0.28) },
              pressed && styles.pressed,
            ]}
            onPress={() => pushModule(action.moduleId)}
          >
            {/* The mock has no badge behind these icons — it has a halo. The
                icon sits directly on the tile with the accent bleeding out
                around it, which is why reusing the flat `*Soft` chips read as
                pastel squares rather than as the design. */}
            <IconGlow color={accent} size={QUICK_ACTION_GLOW_SIZE} strength={glowStrength}>
              <Icon
                color={action.accent}
                name={action.definition.icon}
                size={23}
                testID={`quick-action-icon-${action.moduleId}`}
              />
            </IconGlow>
            <Text
              numberOfLines={HOME_QUICK_ACTION_LABEL_LINES}
              style={[styles.quickRailText, type.label]}
            >
              {labelFor(action.definition.title, locale)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task centre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status chip.
 *
 * The mock colours the numeral AND the label in the chip's own tone — red,
 * orange, blue, green — over a tint of the same hue. The previous pass rendered
 * both in neutral `text`/`mutedText` because `warning` on `warningSoft` measured
 * 2.86:1; the answer was a chip palette that clears AA rather than a neutral
 * chip. Every pair here is asserted at 4.5:1 by the tone-on-tint gate in
 * theme.test.ts.
 */
function TaskChip({ label, tone, value }: Readonly<{ label: string; tone: ChipTone; value: string }>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const type = useDashboardTypography();
  const tokens = chipTokens[tone];
  const toneColor = theme.colors[tokens.text];

  return (
    <View
      style={[
        styles.taskChip,
        {
          backgroundColor: theme.colors[tokens.surface],
          borderColor: toneBorder(toneColor, 0.28),
        },
      ]}
      testID={`task-chip-${tone}`}
    >
      <Text numberOfLines={1} style={[styles.taskChipValue, type.heading, { color: toneColor }]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[styles.taskChipLabel, type.caption, { color: toneColor }]}>
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
  const { isRtl, locale, t, textDirection } = useLocale();
  const type = useDashboardTypography();
  // Keeps the ring off the physical corner the messenger FAB owns. See
  // `taskRingSide` for why the panel's direction and the FAB's `end` can
  // resolve to the same side.
  const ringSide = taskRingSide(isRtl, I18nManager.isRTL);

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
          <View
            style={[styles.taskTopRow, ringSide === "end" && styles.taskTopRowFlipped]}
            testID="task-centre-top-row"
          >
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
            {/* Overdue is the mock's red chip, not its amber one: amber is the
                in-progress state, and work that is late is not "in progress". */}
            <TaskChip
              label={t("overdue")}
              tone="danger"
              value={plainNumber(summary.overdue, locale)}
            />
            <TaskChip
              label={t("pending")}
              tone="warning"
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
              <Icon color={shortcut.accent} name={shortcut.definition.icon} size={24} />
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
  // Three `Intl.DateTimeFormat` constructions; this panel re-renders whenever
  // any dashboard state changes, and the badge only moves with the locale and
  // the calendar day.
  const badge = useMemo(() => todayBadgeParts(locale, new Date()), [locale]);

  if (todayForRole === undefined) {
    return (
      <Card style={[styles.panel, styles.paymentPanel, { direction: textDirection }]}>
        <PanelHeading
          icon="calendar"
          iconColor="homePaymentPanelTone"
          title={t("dealerHomeUpcomingPayments")}
        />
        <SkeletonRow count={2} />
      </Card>
    );
  }

  const currency = todayForRole.currency;

  return (
    <Card style={[styles.panel, styles.paymentPanel, { direction: textDirection }]}>
      <PanelHeading
        icon="calendar"
        iconColor="homePaymentPanelTone"
        title={t("dealerHomeUpcomingPayments")}
      />
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
        tone="homePaymentPanelTone"
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

  const router = useRouter();
  const isApprovals = row.kind === "approvals";
  const title = isApprovals
    ? `${plainNumber(row.count, locale)} ${t("todayAgendaApprovalsWaiting")}`
    : row.title || t("dealerHomeAlertUntitled");
  const meta = isApprovals ? t("dealerHomeJustNow") : t(row.timeKey);
  const unread = isApprovals || row.unread;

  // A notification's own deep link, parsed by the same org-scoped helper the
  // notification bell uses — it rejects links belonging to another org or to an
  // unknown module, so a bad `link` falls back to the notifications list rather
  // than navigating somewhere the caller should not be.
  const deepLink = isApprovals ? null : parseNotificationLink(row.link, orgId);

  function openAlert() {
    if (isApprovals) {
      pushModule("approvals");
      return;
    }
    if (deepLink) {
      router.push({
        pathname: nativeRoutes.orgModule,
        params: { orgId, moduleId: deepLink.moduleId, highlightId: deepLink.highlightId },
      });
      return;
    }
    pushModule("notifications");
  }

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      style={({ pressed }) => [styles.alertRow, { direction: textDirection }, pressed && styles.pressed]}
      onPress={openAlert}
    >
      {/* The dark mock rings every bell in the panel's amber; the light mock
          leaves them neutral and marks unread rows with a coloured dot instead.
          `homeAlertPanelTone` is that amber in dark and the AA-safe amber text
          colour in light, so one token serves both. */}
      <Icon
        color={unread ? "homeAlertPanelTone" : "subtleText"}
        name="notifications"
        size={17}
      />
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
  /** `undefined` while the approvals query is in flight; `0` when it is skipped. */
  pendingApprovals: number | undefined;
}>) {
  const styles = useThemedStyles(makeStyles);
  const pushModule = useModulePush(orgId);
  const { t, textDirection } = useLocale();

  // Both inputs, not just notifications: if the notification list lands first,
  // an approver would see the panel render — or show its empty state — with the
  // approvals row still missing, and then watch it appear.
  if (notifications === undefined || pendingApprovals === undefined) {
    return (
      <Card style={[styles.panel, styles.alertPanel, { direction: textDirection }]}>
        <PanelHeading
          icon="notifications"
          iconColor="homeAlertPanelTone"
          title={t("dealerHomeAlerts")}
          titleColor="homeAlertPanelTone"
        />
        <SkeletonRow count={3} />
      </Card>
    );
  }

  const rows = buildAlertRows({ notifications, pendingApprovals, now: Date.now() });

  return (
    <Card style={[styles.panel, styles.alertPanel, { direction: textDirection }]}>
      <PanelHeading
        icon="notifications"
        iconColor="homeAlertPanelTone"
        title={t("dealerHomeAlerts")}
        titleColor="homeAlertPanelTone"
      />
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
        tone="homeAlertPanelTone"
        onPress={() => pushModule("notifications")}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace banner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The marketplace banner.
 *
 * Not a flat `primarySoft` tint: the mock runs a diagonal gradient across it and
 * lights the icon plaque with its own vertical gradient and a coloured shadow.
 * The gradient is an SVG paint server sitting behind the content, so the banner
 * keeps working as a `Card` — press feedback, accessibility role and all.
 */
export function HomeMarketplaceBanner({ orgId }: Readonly<{ orgId: string }>) {
  const theme = useAppTheme();
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
      <GradientSurface
        colors={[
          theme.colors.homeBannerFrom,
          theme.colors.homeBannerMid,
          theme.colors.homeBannerTo,
        ]}
        radius={HOME_RADIUS.panel}
      />
      <GradientTile
        colors={[theme.colors.homeBannerIconFrom, theme.colors.homeBannerIconTo]}
        radius={14}
        size={52}
      >
        <Icon color="onPrimary" name="marketplace" size={26} />
      </GradientTile>
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
      <Icon color="homeBannerCtaText" name="chevronForward" size={22} />
    </Card>
  );
}

/** Compact figure for the expanded "details" area of the overview card. */
export function HomeDetailStat({
  caption,
  label,
  value,
}: Readonly<{ caption?: string; label: string; value: string }>) {
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
      {caption ? (
        <Text numberOfLines={1} style={[styles.detailStatCaption, type.caption]}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  // Panels sit on `surface` over the screen's `background`. That pairing is the
  // app's elevation contract (1.116:1 in the light theme) — the design mock put
  // near-white cards on pure white, 1.009:1, which disappears in daylight. It is
  // the ONE place this screen departs from the mock; everything else below is
  // measured from it.
  panel: {
    gap: theme.spacing.md,
    borderRadius: HOME_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homeCardBorder,
    padding: 14,
  },
  // The dark mock washes the alerts card amber and the payments card green, and
  // leaves both white in the light mock. The tokens carry that difference.
  alertPanel: {
    backgroundColor: theme.colors.homeAlertPanel,
    borderColor: theme.colors.homeAlertPanelBorder,
  },
  paymentPanel: {
    backgroundColor: theme.colors.homePaymentPanel,
    borderColor: theme.colors.homePaymentPanelBorder,
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
  // An outlined pill in the panel's own tone, as drawn — not a filled grey bar.
  panelAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    minHeight: 40,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  panelActionText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
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
    borderRadius: HOME_RADIUS.panel,
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
    gap: 6,
  },
  // Icon and label share a line in the mock, with the figure below them.
  kpiHeadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  kpiDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    backgroundColor: theme.colors.homeCardBorder,
    marginHorizontal: theme.spacing.sm,
  },
  kpiIconShell: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: HOME_RADIUS.badge,
    borderWidth: StyleSheet.hairlineWidth,
  },
  kpiLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  // The mock's headline figure is ~1.45x its label. `heading` (17) alone read as
  // just another line of copy.
  kpiValue: {
    color: theme.colors.text,
    fontSize: 19,
    lineHeight: 26,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  kpiDelta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  kpiDeltaText: {
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  kpiDeltaUp: {
    color: theme.colors.homeDeltaUp,
  },
  kpiDeltaDown: {
    color: theme.colors.homeDeltaDown,
  },
  quickRail: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  // Five across, as drawn. On a 360dp phone that is 59dp per tile, which is why
  // the label below gets two lines instead of one — see
  // HOME_QUICK_ACTION_LABEL_LINES.
  quickRailItem: {
    flex: 1,
    minWidth: 0,
    minHeight: 92,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: HOME_RADIUS.tile,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 2,
    paddingVertical: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  quickRailText: {
    color: theme.colors.text,
    fontSize: 11,
    lineHeight: 14,
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
  // Puts the ring on the row's other end so it never lands under the messenger
  // FAB. See `taskRingSide`.
  taskTopRowFlipped: {
    flexDirection: "row-reverse",
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
    flexBasis: 72,
    alignItems: "center",
    gap: 2,
    borderRadius: HOME_RADIUS.nested,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  taskChipValue: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  taskChipLabel: {
    fontSize: 11,
    fontWeight: "700",
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
    borderRadius: HOME_RADIUS.nested,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homeChipBorder,
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
    minWidth: 84,
    alignItems: "center",
    gap: 2,
    borderRadius: HOME_RADIUS.nested,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homePaymentPanelBorder,
    backgroundColor: theme.colors.homePaymentPanelRow,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  dateBadgeMonth: {
    color: theme.colors.homePaymentPanelTone,
    fontSize: 12,
    fontWeight: "700",
  },
  dateBadgeDay: {
    color: theme.colors.text,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  dateBadgeWeekday: {
    color: theme.colors.homePaymentPanelTone,
    fontSize: 12,
    fontWeight: "600",
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
    borderRadius: HOME_RADIUS.nested,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homeAlertPanelBorder,
    backgroundColor: theme.colors.homeAlertPanelRow,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 10,
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
    borderRadius: HOME_RADIUS.panel,
    // The gradient is painted by GradientSurface behind the content; this fill
    // is only what shows through if the SVG layer somehow fails to mount.
    backgroundColor: theme.colors.homeBannerMid,
    overflow: "hidden",
    padding: 14,
  },
  marketplaceText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  marketplaceTitle: {
    color: theme.colors.homeBannerTitle,
    fontSize: 18,
    fontWeight: "700",
  },
  marketplaceBody: {
    color: theme.colors.homeBannerBody,
    lineHeight: 18,
  },
  // Outlined pill, as drawn — the previous solid white chip cut the banner in
  // two.
  marketplaceCta: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homeBannerCtaBorder,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 5,
    marginTop: 6,
  },
  marketplaceCtaText: {
    color: theme.colors.homeBannerCtaText,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "none",
  },
  detailStat: {
    flexGrow: 1,
    flexBasis: 128,
    gap: 2,
    borderRadius: HOME_RADIUS.nested,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.homeChipBorder,
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
