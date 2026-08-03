import { FAB_SIZE } from "../../components/fabGeometry";
import { theme } from "../../theme";
import type {
  MobileDashboardStats,
  MobileDashboardTodayForRole,
  MobileGlobalSearchResult,
  MobileNotification,
} from "../../convexApi";

/**
 * Bottom padding the home scroll container needs so the floating messenger FAB
 * never covers its last control.
 *
 * `WorkspaceTabsLayout` parks the FAB `spacing.md` above the tab bar, so it
 * reaches `FAB_SIZE + spacing.md` into the screen's content area; the second
 * `spacing.md` is breathing room. The previous value here was `spacing.xxl`
 * (32), which left "view all alerts" sitting underneath it — and the FAB must
 * not move: it is a standing product requirement that it stays put.
 */
export const HOME_FAB_CLEARANCE = FAB_SIZE + theme.spacing.md * 2;

/**
 * Narrowest container that still fits the two-up rows (task centre + shortcuts).
 *
 * The design mock is 852px wide; the phones this ships to are 720px — a 360dp
 * screen. Minus the screen's 16dp gutters that leaves 328dp of container, and
 * two 158dp columns cannot hold a progress ring beside wrapped Arabic copy.
 * Below this width the rows stack instead of squeezing.
 */
export const HOME_TWO_COLUMN_MIN_WIDTH = 348;

/** `search.globalSearch` itself returns nothing under two characters. */
export const HOME_SEARCH_MIN_LENGTH = 2;

/** Rows the alerts panel shows before deferring to "view all". */
export const HOME_ALERT_LIMIT = 4;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Convex validates `v.number()`, and NaN passes it. Every figure on this screen
 * runs through here before it is added or divided, so one bad row degrades to a
 * zero instead of turning a whole card into "NaN".
 */
function safeNumber(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Two columns only once the container can actually hold them. An unmeasured
 * container reports 0 — stack in that case, so the first frame is never a
 * clipped two-up row that reflows a tick later.
 */
export function shouldStackHomeColumns(containerWidth: number): boolean {
  return !(Number.isFinite(containerWidth) && containerWidth >= HOME_TWO_COLUMN_MIN_WIDTH);
}

export type HomeOverviewKpis = Readonly<{
  sales: number;
  expenses: number;
  netProfit: number;
}>;

/**
 * The three KPI columns, entirely from `dashboard.stats`.
 *
 * `salesVolumeThisMonth` is the query's canonical revenue figure for the
 * selected `timeRange`; expenses and profit are only exposed per trend bucket,
 * so they are summed back up here. They deliberately do not reconcile as
 * `sales - expenses`: profit is booked against each vehicle's capitalized cost
 * and excludes expenses already capitalized into inventory, while the expenses
 * figure is every expense in the period. Both are correct; they answer
 * different questions.
 */
export function deriveOverviewKpis(stats: MobileDashboardStats | undefined): HomeOverviewKpis {
  const trend = stats?.salesTrend ?? [];
  let expenses = 0;
  let netProfit = 0;

  for (const point of trend) {
    expenses += safeNumber(point?.Expenses);
    netProfit += safeNumber(point?.Profit);
  }

  return {
    sales: safeNumber(stats?.salesVolumeThisMonth),
    expenses,
    netProfit,
  };
}

export type HomeTaskCentre = Readonly<{
  total: number;
  completed: number;
  overdue: number;
  inProgress: number;
  open: number;
  ratio: number;
}>;

/**
 * The task ring and its status chips.
 *
 * `open` adds the two real open buckets rather than computing `total -
 * completed`: `dashboard.stats` counts cancelled tasks inside `total`, so the
 * subtraction would quietly present cancelled work as outstanding.
 *
 * The mock also shows an "in review" chip. Task status server-side is
 * PENDING | COMPLETED | CANCELLED — there is no review state to count, so that
 * chip is not rendered rather than filled with a number that means nothing.
 */
export function deriveTaskCentre(stats: MobileDashboardStats | undefined): HomeTaskCentre {
  const total = safeNumber(stats?.taskStats?.total);
  const completed = safeNumber(stats?.taskStats?.completed);
  const overdue = safeNumber(stats?.taskStats?.overdue);
  const inProgress = safeNumber(stats?.taskStats?.pending);
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;

  return { total, completed, overdue, inProgress, open: overdue + inProgress, ratio };
}

export type HomeUpcomingPayments = Readonly<{
  count: number;
  amount: number;
  overdueCount: number;
  overdueAmount: number;
  isEmpty: boolean;
}>;

/**
 * "Upcoming payments" from `dashboard.todayForRole`: collections due today plus
 * post-dated cheques due this week are the money coming in, and overdue
 * receivables stay a separate line rather than being folded into a total that
 * would read as healthy.
 */
export function summarizeUpcomingPayments(
  today: MobileDashboardTodayForRole | undefined,
): HomeUpcomingPayments {
  const count =
    safeNumber(today?.collectionsDueToday?.count) + safeNumber(today?.chequesDueThisWeek?.count);
  const amount =
    safeNumber(today?.collectionsDueToday?.amount) + safeNumber(today?.chequesDueThisWeek?.amount);
  const overdueCount = safeNumber(today?.overdueReceivables?.count);
  const overdueAmount = safeNumber(today?.overdueReceivables?.amount);

  return {
    count,
    amount,
    overdueCount,
    overdueAmount,
    isEmpty: count === 0 && overdueCount === 0,
  };
}

export type HomeGreetingKey =
  | "dealerHomeGreetingMorning"
  | "dealerHomeGreetingAfternoon"
  | "dealerHomeGreetingEvening";

export function greetingKeyForHour(hour: number): HomeGreetingKey {
  if (hour < 12) return "dealerHomeGreetingMorning";
  if (hour < 17) return "dealerHomeGreetingAfternoon";
  return "dealerHomeGreetingEvening";
}

export type HomeAlertTimeKey = "dealerHomeJustNow" | "dealerHomeToday" | "dealerHomeEarlier";

function isSameCalendarDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Coarse "when" label for an alert. Calendar-day based, not a rolling window:
 * something logged at 23:30 last night is 14 hours old but it is not today, and
 * a dealer reading "Today" against yesterday's cheque would act on it wrongly.
 */
export function alertTimeKey(createdAt: number, now: number): HomeAlertTimeKey {
  const safeCreatedAt = safeNumber(createdAt);
  const age = now - safeCreatedAt;
  if (age < HOUR_MS) return "dealerHomeJustNow";
  if (isSameCalendarDay(safeCreatedAt, now)) return "dealerHomeToday";
  return "dealerHomeEarlier";
}

export type HomeAlertRow =
  | Readonly<{ key: string; kind: "approvals"; count: number }>
  | Readonly<{
    key: string;
    kind: "notification";
    title: string | undefined;
    unread: boolean;
    timeKey: HomeAlertTimeKey;
    link: string | undefined;
  }>;

/**
 * Alert rows for the panel. `undefined` notifications means the query has not
 * resolved yet and the caller renders a skeleton — an empty array here would be
 * indistinguishable from a genuinely quiet workspace, which is the "flashes
 * 'no results' while loading" bug Wave 1 fixed.
 */
export function buildAlertRows({
  notifications,
  pendingApprovals,
  now,
}: Readonly<{
  notifications: readonly MobileNotification[] | undefined;
  pendingApprovals: number;
  now: number;
}>): HomeAlertRow[] {
  if (notifications === undefined) return [];

  const rows: HomeAlertRow[] = [];
  if (pendingApprovals > 0) {
    rows.push({ key: "approvals", kind: "approvals", count: pendingApprovals });
  }

  for (const notification of notifications) {
    if (rows.length >= HOME_ALERT_LIMIT) break;
    if (notification?.isArchived === true) continue;
    rows.push({
      key: notification._id,
      kind: "notification",
      title: notification.title,
      unread: notification.isRead !== true,
      timeKey: alertTimeKey(notification._creationTime, now),
      link: notification.link,
    });
  }

  return rows;
}

export function isSearchQueryActive(raw: string): boolean {
  return raw.trim().length >= HOME_SEARCH_MIN_LENGTH;
}

export function countSearchResults(results: MobileGlobalSearchResult | undefined): number {
  return (
    (results?.vehicles ?? []).length +
    (results?.customers ?? []).length +
    (results?.leads ?? []).length
  );
}
