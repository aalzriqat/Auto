/// <reference types="jest" />

import type {
  MobileDashboardStats,
  MobileDashboardTodayForRole,
  MobileNotification,
} from "../../convexApi";
import {
  HOME_ALERT_LIMIT,
  HOME_SEARCH_MIN_LENGTH,
  HOME_TWO_COLUMN_MIN_WIDTH,
  alertTimeKey,
  buildAlertRows,
  countSearchResults,
  deriveOverviewKpis,
  deriveTaskCentre,
  greetingKeyForHour,
  isSearchQueryActive,
  shouldStackHomeColumns,
  summarizeUpcomingPayments,
} from "./homeModel";

function makeStats(overrides: Partial<MobileDashboardStats> = {}): MobileDashboardStats {
  return {
    totalVehicles: 0,
    availableVehicles: 0,
    activeLeads: 0,
    salesThisMonth: 0,
    salesVolumeThisMonth: 0,
    teamMembers: 0,
    salesTrend: [],
    truncated: { vehicles: false, sales: false, members: false },
    taskStats: { total: 0, pending: 0, completed: 0, overdue: 0 },
    teamTasks: [],
    topPerformer: null,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<MobileNotification> = {}): MobileNotification {
  return {
    _id: "n1",
    _creationTime: 1_700_000_000_000,
    orgId: "org1",
    userId: "user1",
    isRead: false,
    ...overrides,
  };
}

describe("shouldStackHomeColumns", () => {
  test("stacks before the container has been measured", () => {
    // An unmeasured container is 0 wide. Laying two columns out at 0 and
    // reflowing is the clipped-first-frame bug; stacking first is safe.
    expect(shouldStackHomeColumns(0)).toBe(true);
  });

  test("stacks on a 360dp phone (the 720px devices the design was checked against)", () => {
    // 360dp screen minus the screen's 16dp gutters on both sides.
    expect(shouldStackHomeColumns(360 - 32)).toBe(true);
  });

  test("uses two columns once each column clears the minimum", () => {
    expect(shouldStackHomeColumns(HOME_TWO_COLUMN_MIN_WIDTH)).toBe(false);
    expect(shouldStackHomeColumns(412 - 32)).toBe(false);
  });

  test("treats the threshold itself as wide enough, one dp under as too narrow", () => {
    expect(shouldStackHomeColumns(HOME_TWO_COLUMN_MIN_WIDTH - 1)).toBe(true);
  });

  test("stacks rather than throwing when the measurement is not a number", () => {
    expect(shouldStackHomeColumns(Number.NaN)).toBe(true);
  });
});

describe("deriveOverviewKpis", () => {
  test("returns zeros while the query is still loading", () => {
    expect(deriveOverviewKpis(undefined)).toEqual({ sales: 0, expenses: 0, netProfit: 0 });
  });

  test("reads sales from the canonical volume field and sums the trend for cost and profit", () => {
    const stats = makeStats({
      salesVolumeThisMonth: 45_250,
      salesTrend: [
        { name: "Aug 1", Revenue: 20_000, Profit: 9_000, Expenses: 3_000 },
        { name: "Aug 2", Revenue: 25_250, Profit: 7_900, Expenses: 5_350 },
      ],
    });

    expect(deriveOverviewKpis(stats)).toEqual({
      sales: 45_250,
      expenses: 8_350,
      netProfit: 16_900,
    });
  });

  test("keeps a negative net profit negative instead of clamping it to zero", () => {
    const stats = makeStats({
      salesVolumeThisMonth: 1_000,
      salesTrend: [{ name: "Aug 1", Revenue: 1_000, Profit: -4_200, Expenses: 5_200 }],
    });

    expect(deriveOverviewKpis(stats).netProfit).toBe(-4_200);
  });

  test("survives a trend row whose numbers are missing or non-finite", () => {
    const stats = makeStats({
      salesVolumeThisMonth: Number.NaN,
      salesTrend: [
        { name: "Aug 1", Revenue: 10, Profit: Number.NaN, Expenses: 40 },
        { name: "Aug 2" } as MobileDashboardStats["salesTrend"][number],
      ],
    });

    expect(deriveOverviewKpis(stats)).toEqual({ sales: 0, expenses: 40, netProfit: 0 });
  });

  test("treats a missing trend array as an empty period", () => {
    const stats = makeStats({ salesVolumeThisMonth: 500 });
    delete (stats as { salesTrend?: unknown }).salesTrend;

    expect(deriveOverviewKpis(stats)).toEqual({ sales: 500, expenses: 0, netProfit: 0 });
  });
});

describe("deriveTaskCentre", () => {
  test("returns an empty, non-dividing summary while loading", () => {
    expect(deriveTaskCentre(undefined)).toEqual({
      total: 0,
      completed: 0,
      overdue: 0,
      inProgress: 0,
      open: 0,
      ratio: 0,
    });
  });

  test("reports completion as completed over total, not open over total", () => {
    const summary = deriveTaskCentre(
      makeStats({ taskStats: { total: 12, pending: 3, completed: 7, overdue: 2 } }),
    );

    expect(summary.completed).toBe(7);
    expect(summary.total).toBe(12);
    expect(summary.ratio).toBeCloseTo(7 / 12);
    // open is the two real open buckets added, never `total - completed` —
    // `total` also counts cancelled rows server-side.
    expect(summary.open).toBe(5);
  });

  test("does not divide by zero when the org has no tasks", () => {
    const summary = deriveTaskCentre(
      makeStats({ taskStats: { total: 0, pending: 0, completed: 0, overdue: 0 } }),
    );

    expect(summary.ratio).toBe(0);
    expect(Number.isFinite(summary.ratio)).toBe(true);
  });

  test("clamps the ratio into 0..1 if the backend ever reports more completed than total", () => {
    const summary = deriveTaskCentre(
      makeStats({ taskStats: { total: 2, pending: 0, completed: 5, overdue: 0 } }),
    );

    expect(summary.ratio).toBe(1);
  });
});

describe("summarizeUpcomingPayments", () => {
  test("is empty while the finance query is still loading", () => {
    expect(summarizeUpcomingPayments(undefined)).toEqual({
      count: 0,
      amount: 0,
      overdueCount: 0,
      overdueAmount: 0,
      isEmpty: true,
    });
  });

  test("adds collections due today to cheques due this week and keeps overdue separate", () => {
    const today: MobileDashboardTodayForRole = {
      collectionsDueToday: { count: 1, amount: 4_500 },
      chequesDueThisWeek: { count: 2, amount: 7_950 },
      overdueReceivables: { count: 4, amount: 12_000 },
      truncated: false,
      currency: "JOD",
    };

    expect(summarizeUpcomingPayments(today)).toEqual({
      count: 3,
      amount: 12_450,
      overdueCount: 4,
      overdueAmount: 12_000,
      isEmpty: false,
    });
  });

  test("is not empty when only overdue receivables exist", () => {
    const today: MobileDashboardTodayForRole = {
      collectionsDueToday: { count: 0, amount: 0 },
      chequesDueThisWeek: { count: 0, amount: 0 },
      overdueReceivables: { count: 2, amount: 900 },
      truncated: false,
      currency: "JOD",
    };

    expect(summarizeUpcomingPayments(today).isEmpty).toBe(false);
  });

  test("is empty when every bucket is zero", () => {
    const today: MobileDashboardTodayForRole = {
      collectionsDueToday: { count: 0, amount: 0 },
      chequesDueThisWeek: { count: 0, amount: 0 },
      overdueReceivables: { count: 0, amount: 0 },
      truncated: false,
      currency: "JOD",
    };

    expect(summarizeUpcomingPayments(today).isEmpty).toBe(true);
  });
});

describe("greetingKeyForHour", () => {
  test("maps the day into three greetings", () => {
    expect(greetingKeyForHour(0)).toBe("dealerHomeGreetingMorning");
    expect(greetingKeyForHour(11)).toBe("dealerHomeGreetingMorning");
    expect(greetingKeyForHour(12)).toBe("dealerHomeGreetingAfternoon");
    expect(greetingKeyForHour(16)).toBe("dealerHomeGreetingAfternoon");
    expect(greetingKeyForHour(17)).toBe("dealerHomeGreetingEvening");
    expect(greetingKeyForHour(23)).toBe("dealerHomeGreetingEvening");
  });
});

describe("alertTimeKey", () => {
  const now = new Date(2026, 7, 3, 14, 0, 0).getTime();

  test("calls the last hour 'just now'", () => {
    expect(alertTimeKey(now - 59 * 60_000, now)).toBe("dealerHomeJustNow");
  });

  test("calls anything else on the same calendar day 'today'", () => {
    const sameDayEarly = new Date(2026, 7, 3, 1, 0, 0).getTime();
    expect(alertTimeKey(sameDayEarly, now)).toBe("dealerHomeToday");
  });

  test("uses the calendar day, not a rolling 24 hours", () => {
    // 23:30 yesterday is 14.5h old — inside a rolling 24h window, but it is
    // NOT today, and labelling it "Today" is the bug this test pins.
    const lateYesterday = new Date(2026, 7, 2, 23, 30, 0).getTime();
    expect(alertTimeKey(lateYesterday, now)).toBe("dealerHomeEarlier");
  });

  test("treats a clock-skewed future timestamp as just now instead of 'earlier'", () => {
    expect(alertTimeKey(now + 60_000, now)).toBe("dealerHomeJustNow");
  });
});

describe("buildAlertRows", () => {
  test("returns nothing while notifications are still loading", () => {
    expect(buildAlertRows({ notifications: undefined, pendingApprovals: 0, now: 1 })).toEqual([]);
  });

  test("puts waiting approvals above notifications", () => {
    const rows = buildAlertRows({
      notifications: [makeNotification({ _id: "n1", title: "Cheque due" })],
      pendingApprovals: 3,
      now: 1_700_000_000_000,
    });

    expect(rows[0]).toEqual({ key: "approvals", kind: "approvals", count: 3 });
    expect(rows[1]).toEqual(
      expect.objectContaining({ kind: "notification", title: "Cheque due" }),
    );
  });

  test("omits the approvals row when nothing is waiting", () => {
    const rows = buildAlertRows({
      notifications: [makeNotification()],
      pendingApprovals: 0,
      now: 1_700_000_000_000,
    });

    expect(rows.every((row) => row.kind === "notification")).toBe(true);
  });

  test("caps the panel and counts the approvals row against the cap", () => {
    const notifications = Array.from({ length: 10 }, (_, index) =>
      makeNotification({ _id: `n${index}` }),
    );

    const rows = buildAlertRows({ notifications, pendingApprovals: 2, now: 1_700_000_000_000 });

    expect(rows).toHaveLength(HOME_ALERT_LIMIT);
    expect(rows.filter((row) => row.kind === "notification")).toHaveLength(HOME_ALERT_LIMIT - 1);
  });

  test("drops archived notifications even if the server ever returns one", () => {
    const rows = buildAlertRows({
      notifications: [
        makeNotification({ _id: "archived", isArchived: true }),
        makeNotification({ _id: "live", title: "Live" }),
      ],
      pendingApprovals: 0,
      now: 1_700_000_000_000,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ key: "live" }));
  });

  test("carries the unread flag and the deep link through unchanged", () => {
    const rows = buildAlertRows({
      notifications: [
        makeNotification({ _id: "n1", isRead: true, link: "/org1/accounting" }),
      ],
      pendingApprovals: 0,
      now: 1_700_000_000_000,
    });

    expect(rows[0]).toEqual({
      key: "n1",
      kind: "notification",
      title: undefined,
      unread: false,
      timeKey: "dealerHomeJustNow",
      link: "/org1/accounting",
    });
  });
});

describe("search helpers", () => {
  test("does not fire a query until the server's own two-character floor is met", () => {
    expect(HOME_SEARCH_MIN_LENGTH).toBe(2);
    expect(isSearchQueryActive("")).toBe(false);
    expect(isSearchQueryActive("  a  ")).toBe(false);
    expect(isSearchQueryActive("ab")).toBe(true);
    expect(isSearchQueryActive("  bmw ")).toBe(true);
  });

  test("counts every result bucket, tolerating a partial payload", () => {
    expect(countSearchResults(undefined)).toBe(0);
    expect(countSearchResults({ vehicles: [], customers: [], leads: [] })).toBe(0);
    expect(
      countSearchResults({
        vehicles: [{ id: "v1", make: "BMW", model: "X5", year: 2024, status: "AVAILABLE" }],
        customers: [{ id: "c1", firstName: "A", lastName: "B" }],
        leads: [{ id: "l1", stage: "NEW", customerId: "c1", customerName: "A B" }],
      }),
    ).toBe(3);
  });
});
