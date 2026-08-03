/// <reference types="jest" />

import { mobileFoundationStrings } from "@autoflow/shared";
import { fireEvent, render } from "@testing-library/react-native";
import { useQuery } from "convex/react";
import { Text } from "react-native";

const mockPush = jest.fn();

jest.mock("convex/react", () => ({
  useMutation: jest.fn(() => jest.fn()),
  usePaginatedQuery: jest.fn(() => ({ results: [], status: "Exhausted", loadMore: jest.fn() })),
  useQuery: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

import { api, type MobileDashboardStats, type MobileDashboardTodayForRole } from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import {
  HomeAlerts,
  HomeOverviewCard,
  HomeSearchRow,
  HomeTaskCentre,
  HomeTwoUp,
  HomeUpcomingPayments,
} from "./HomePanels";
import { plainNumber } from "./dashboardFormat";
import { summarizeUpcomingPayments } from "./homeModel";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const ar = mobileFoundationStrings.ar;

function wrap(node: React.ReactElement) {
  return <LocaleProvider>{node}</LocaleProvider>;
}

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

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseQuery.mockReturnValue(undefined as unknown as ReturnType<typeof useQuery>);
  mockPush.mockReset();
});

// The app's default locale is Arabic, so these assertions also prove the RTL
// string path is the one that renders.
describe("locale baseline", () => {
  test("renders Arabic copy by default", () => {
    expect(ar.dealerHomeAlerts).toBe("التنبيهات");
    expect(ar.dealerHomeAlerts).not.toBe(mobileFoundationStrings.en.dealerHomeAlerts);
  });
});

describe("HomeAlerts", () => {
  test("shows a skeleton, not the empty state, while notifications are loading", async () => {
    const rendered = await render(
      wrap(<HomeAlerts notifications={undefined} orgId="org1" pendingApprovals={0} />),
    );

    expect(rendered.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    expect(rendered.queryByText(ar.dealerHomeAlertsEmpty)).toBeNull();
  });

  test("shows the empty state only once the query has resolved to nothing", async () => {
    const rendered = await render(
      wrap(<HomeAlerts notifications={[]} orgId="org1" pendingApprovals={0} />),
    );

    expect(rendered.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(rendered.getByText(ar.dealerHomeAlertsEmpty)).toBeTruthy();
  });

  test("lists real notifications and opens the notifications module", async () => {
    const rendered = await render(
      wrap(
        <HomeAlerts
          notifications={[
            {
              _id: "n1",
              _creationTime: Date.now(),
              orgId: "org1",
              userId: "u1",
              isRead: false,
              title: "شيك مستحق",
            },
          ]}
          orgId="org1"
          pendingApprovals={0}
        />,
      ),
    );

    await fireEvent.press(rendered.getByLabelText("شيك مستحق"));
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: { orgId: "org1", moduleId: "notifications" } }),
    );
  });
});

describe("HomeTaskCentre", () => {
  test("shows a skeleton while dashboard.stats is loading", async () => {
    const rendered = await render(
      wrap(<HomeTaskCentre canViewTasks orgId="org1" stats={undefined} />),
    );

    expect(rendered.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    expect(rendered.queryByText(ar.dealerHomeTaskCentreEmpty)).toBeNull();
  });

  test("shows the empty state for a workspace with no tasks", async () => {
    const rendered = await render(
      wrap(<HomeTaskCentre canViewTasks orgId="org1" stats={makeStats()} />),
    );

    expect(rendered.getByText(ar.dealerHomeTaskCentreEmpty)).toBeTruthy();
  });

  test("renders the ring and exactly the three chips the backend can fill", async () => {
    const rendered = await render(
      wrap(
        <HomeTaskCentre
          canViewTasks
          orgId="org1"
          stats={makeStats({ taskStats: { total: 12, pending: 3, completed: 7, overdue: 2 } })}
        />,
      ),
    );

    // ar-JO formats digits as Arabic-Indic, which is what a dealer here reads.
    expect(rendered.getByText(`${plainNumber(7, "ar")}/${plainNumber(12, "ar")}`)).toBeTruthy();
    expect(rendered.getByText(ar.overdue)).toBeTruthy();
    expect(rendered.getByText(ar.pending)).toBeTruthy();
    expect(rendered.getByText(ar.completed)).toBeTruthy();
    // The mock's fourth chip is "in review". Task status server-side is
    // PENDING | COMPLETED | CANCELLED, so there is nothing to count.
    expect(rendered.queryByText("مراجعة")).toBeNull();
  });

  test("hides the 'view all tasks' link from a role that cannot open tasks", async () => {
    const rendered = await render(
      wrap(<HomeTaskCentre canViewTasks={false} orgId="org1" stats={makeStats()} />),
    );

    expect(rendered.queryByText(ar.dealerHomeViewAllTasks)).toBeNull();
  });
});

describe("HomeUpcomingPayments", () => {
  const populated: MobileDashboardTodayForRole = {
    collectionsDueToday: { count: 1, amount: 4_500 },
    chequesDueThisWeek: { count: 2, amount: 7_950 },
    overdueReceivables: { count: 0, amount: 0 },
    truncated: false,
    currency: "JOD",
  };

  test("shows a skeleton while todayForRole is loading", async () => {
    const rendered = await render(
      wrap(
        <HomeUpcomingPayments
          orgId="org1"
          summary={summarizeUpcomingPayments(undefined)}
          todayForRole={undefined}
        />,
      ),
    );

    expect(rendered.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    expect(rendered.queryByText(ar.dealerHomeUpcomingPaymentsEmpty)).toBeNull();
  });

  test("shows the empty state when nothing is due", async () => {
    const empty: MobileDashboardTodayForRole = {
      collectionsDueToday: { count: 0, amount: 0 },
      chequesDueThisWeek: { count: 0, amount: 0 },
      overdueReceivables: { count: 0, amount: 0 },
      truncated: false,
      currency: "JOD",
    };

    const rendered = await render(
      wrap(
        <HomeUpcomingPayments
          orgId="org1"
          summary={summarizeUpcomingPayments(empty)}
          todayForRole={empty}
        />,
      ),
    );

    expect(rendered.getByText(ar.dealerHomeUpcomingPaymentsEmpty)).toBeTruthy();
  });

  test("shows the combined count and total from the real buckets", async () => {
    const rendered = await render(
      wrap(
        <HomeUpcomingPayments
          orgId="org1"
          summary={summarizeUpcomingPayments(populated)}
          todayForRole={populated}
        />,
      ),
    );

    expect(
      rendered.getByText(`${plainNumber(3, "ar")} ${ar.dealerHomeUpcomingPaymentsCount}`),
    ).toBeTruthy();
    expect(rendered.getByText(ar.dealerHomeUpcomingPaymentsTotal)).toBeTruthy();
  });
});

describe("HomeOverviewCard", () => {
  test("shows a skeleton while dashboard.stats is loading", async () => {
    const rendered = await render(
      wrap(
        <HomeOverviewCard
          currency="JOD"
          detailsExpanded={false}
          stats={undefined}
          onToggleDetails={jest.fn()}
        />,
      ),
    );

    expect(rendered.getAllByTestId("skeleton-row").length).toBeGreaterThan(0);
    expect(rendered.queryByText(ar.dealerHomeKpiSales)).toBeNull();
  });

  test("renders the three KPI columns and toggles the details drawer", async () => {
    const onToggleDetails = jest.fn();
    const rendered = await render(
      wrap(
        <HomeOverviewCard
          currency="JOD"
          detailsExpanded={false}
          stats={makeStats({
            salesVolumeThisMonth: 45_250,
            salesTrend: [{ name: "Aug 1", Revenue: 45_250, Profit: 16_900, Expenses: 8_350 }],
          })}
          onToggleDetails={onToggleDetails}
        />,
      ),
    );

    expect(rendered.getByText(ar.dealerHomeKpiSales)).toBeTruthy();
    expect(rendered.getByText(ar.dealerHomeKpiExpenses)).toBeTruthy();
    expect(rendered.getByText(ar.dealerHomeKpiNetProfit)).toBeTruthy();

    await fireEvent.press(rendered.getByText(ar.dealerHomeViewDetails));
    expect(onToggleDetails).toHaveBeenCalledTimes(1);
  });
});

describe("HomeTwoUp", () => {
  function layout(width: number) {
    return { nativeEvent: { layout: { width, height: 200, x: 0, y: 0 } } };
  }

  test("stacks its children on a 720px (360dp) phone and goes side by side on a wider one", async () => {
    const rendered = await render(
      wrap(
        <HomeTwoUp
          first={<Text testID="first">first</Text>}
          second={<Text testID="second">second</Text>}
        />,
      ),
    );

    // 360dp screen minus the screen's 16dp gutters.
    await fireEvent(rendered.getByTestId("home-two-up"), "layout", layout(328));
    expect(rendered.getByTestId("home-two-up-first").props.style).toEqual(
      expect.objectContaining({ width: "100%" }),
    );

    // 412dp screen minus the same gutters.
    await fireEvent(rendered.getByTestId("home-two-up"), "layout", layout(380));
    expect(rendered.getByTestId("home-two-up-first").props.style).toEqual(
      expect.objectContaining({ flex: 1 }),
    );
  });
});

describe("HomeSearchRow", () => {
  function searchArgsFor(): unknown[] {
    return mockUseQuery.mock.calls
      .filter((call) => call[0] === api.search.globalSearch)
      .map((call) => call[1]);
  }

  test("does not fire the search query for a single character", async () => {
    const rendered = await render(
      wrap(<HomeSearchRow orgId="org1" timeRange="MONTH" onChangeTimeRange={jest.fn()} />),
    );

    await fireEvent.changeText(rendered.getByLabelText(ar.dealerHomeSearchLabel), "ب");

    expect(searchArgsFor().every((args) => args === "skip")).toBe(true);
    expect(rendered.getByText(ar.dealerHomeSearchHint)).toBeTruthy();
  });

  test("fires the search query with the trimmed term once it clears two characters", async () => {
    const rendered = await render(
      wrap(<HomeSearchRow orgId="org1" timeRange="MONTH" onChangeTimeRange={jest.fn()} />),
    );

    await fireEvent.changeText(rendered.getByLabelText(ar.dealerHomeSearchLabel), "  كامري  ");

    expect(searchArgsFor()).toContainEqual({ orgId: "org1", query: "كامري" });
  });

  test("reveals the period filter and reports the chosen range", async () => {
    const onChangeTimeRange = jest.fn();
    const rendered = await render(
      wrap(
        <HomeSearchRow orgId="org1" timeRange="MONTH" onChangeTimeRange={onChangeTimeRange} />,
      ),
    );

    expect(rendered.queryByText(ar.timeRangeYear)).toBeNull();
    await fireEvent.press(rendered.getByText(ar.dealerHomeFilter));
    await fireEvent.press(rendered.getByText(ar.timeRangeYear));

    expect(onChangeTimeRange).toHaveBeenCalledWith("YEAR");
  });
});
