/// <reference types="jest" />

/**
 * Visual-fidelity assertions for the dealer home screen.
 *
 * These do not check that "a card renders" — HomePanels.test.tsx already covers
 * behaviour. They check the specific things the first pass at this screen got
 * wrong against the design mock, so a future refactor that quietly falls back to
 * the app's muted tokens fails here rather than in review:
 *
 *   · five distinct accents on the quick-action rail, not one pastel blue
 *   · status-chip numerals in their own tone, not neutral `text`
 *   · a real gradient behind the marketplace banner, not a flat tint
 *   · the KPI delta present only when a previous-period total exists
 *   · the greeting and the quick-action labels surviving a 720px screen
 *   · the task ring off the corner the messenger FAB owns
 */

import { mobileFoundationStrings } from "@autoflow/shared";
import { render } from "@testing-library/react-native";
import { useQuery } from "convex/react";
import { I18nManager } from "react-native";

const mockPush = jest.fn();

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, signOut: jest.fn() }),
  useUser: () => ({ user: { fullName: "عبدالكريم الزريقات" } }),
}));

jest.mock("convex/react", () => ({
  useMutation: jest.fn(() => jest.fn()),
  usePaginatedQuery: jest.fn(() => ({ results: [], status: "Exhausted", loadMore: jest.fn() })),
  useQuery: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

import {
  api,
  type MobileDashboardStats,
  type MobileMyMembership,
  type MobileOrgSummary,
} from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { buildTheme } from "../../theme";
import {
  HomeMarketplaceBanner,
  HomeOverviewCard,
  HomeQuickActions,
  HomeTaskCentre,
} from "./HomePanels";
import { DealerHomeHeader } from "./OrgDashboardScreen";
import { HOME_QUICK_ACTION_LABEL_LINES } from "./homeModel";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const ar = mobileFoundationStrings.ar;
const light = buildTheme("light").colors;

/** Every permission the quick-action rail can ask for, so all five tiles show. */
const OWNER_PERMISSIONS = [
  "view:vehicles",
  "view:customers",
  "view:leads",
  "view:expenses",
  "view:tasks",
];

function wrap(node: React.ReactElement) {
  return (
    <ThemeProvider>
      <LocaleProvider>{node}</LocaleProvider>
    </ThemeProvider>
  );
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
    taskStats: { total: 12, pending: 3, completed: 7, overdue: 2 },
    teamTasks: [],
    topPerformer: null,
    ...overrides,
  };
}

type RenderedNode = Readonly<{
  props?: Record<string, unknown>;
  children?: readonly (RenderedNode | string | null)[] | null;
}>;

/**
 * Every prop object in the rendered host tree.
 *
 * Walks `toJSON()` rather than reaching for RNTL's `UNSAFE_*` type queries,
 * which do not survive across its major versions — and the things asserted here
 * (an SVG gradient stop, an icon's resolved colour) are host props, so the JSON
 * tree is exactly the right place to read them.
 */
function collectProps(node: RenderedNode | string | null | undefined): Record<string, unknown>[] {
  if (!node || typeof node === "string") return [];
  const own = node.props ? [node.props] : [];
  const children = node.children ?? [];
  return own.concat(...children.map((child) => collectProps(child as RenderedNode)));
}

function renderedProps(tree: unknown): Record<string, unknown>[] {
  return Array.isArray(tree)
    ? tree.flatMap((node) => collectProps(node as RenderedNode))
    : collectProps(tree as RenderedNode);
}

/**
 * react-native-svg flattens its `<Stop>` children into one `gradient` array of
 * [offset, packed ARGB, …] on the RNSVGLinearGradient / RNSVGRadialGradient
 * host node, so the colours have to be unpacked to be compared with the tokens
 * they came from.
 */
function gradientStopHexes(tree: unknown): string[] {
  return renderedProps(tree)
    .flatMap((props) => (Array.isArray(props.gradient) ? (props.gradient as number[]) : []))
    .filter((_value, index) => index % 2 === 1)
    .map((packed) => `#${((packed >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`);
}

/** Flattens a RN style prop (array | object | falsy) to one object. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (merged, entry) => ({ ...merged, ...flatten(entry) }),
      {},
    );
  }
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseQuery.mockReturnValue(undefined as unknown as ReturnType<typeof useQuery>);
  mockPush.mockReset();
});

describe("quick-action rail", () => {
  test("gives each tile its own accent instead of one shared tone", async () => {
    const rendered = await render(
      wrap(<HomeQuickActions orgId="org1" permissions={OWNER_PERMISSIONS} roleName="OWNER" />),
    );

    // Each tile's icon carries its accent as the resolved text colour.
    const colors = ["vehicles", "customers", "leads", "expenses", "messages"].map(
      (moduleId) => flatten(rendered.getByTestId(`quick-action-icon-${moduleId}`).props.style).color,
    );

    expect(colors.filter(Boolean).length).toBe(5);
    expect(new Set(colors).size).toBe(5);
    // And they are the mock's accents, not five shades of the app's blue.
    expect(colors).toEqual(
      expect.arrayContaining([light.homeTileGreen, light.homeTileAmber, light.homeTileViolet]),
    );
  });

  test("gives the label two lines so Customers and Leads stay distinguishable at 720px", async () => {
    const rendered = await render(
      wrap(<HomeQuickActions orgId="org1" permissions={OWNER_PERMISSIONS} roleName="OWNER" />),
    );

    // "العملاء" and "العملاء المحتملون" share a prefix. Clipped to one line at a
    // 59dp tile the second became "العملاء ا…", which reads as the first tile
    // repeated.
    const customers = rendered.getByText("العملاء");
    const leads = rendered.getByText("العملاء المحتملون");

    expect(customers.props.numberOfLines).toBe(HOME_QUICK_ACTION_LABEL_LINES);
    expect(leads.props.numberOfLines).toBe(HOME_QUICK_ACTION_LABEL_LINES);
    expect(HOME_QUICK_ACTION_LABEL_LINES).toBeGreaterThan(1);
  });
});

describe("task centre", () => {
  test("colours each status chip's numeral in its own tone", async () => {
    const rendered = await render(
      wrap(<HomeTaskCentre canViewTasks orgId="org1" stats={makeStats()} />),
    );

    const overdue = flatten(rendered.getByTestId("task-chip-danger").props.style);
    const inProgress = flatten(rendered.getByTestId("task-chip-warning").props.style);
    const completed = flatten(rendered.getByTestId("task-chip-success").props.style);

    expect(overdue.backgroundColor).toBe(light.homeChipDangerSurface);
    expect(inProgress.backgroundColor).toBe(light.homeChipWarningSurface);
    expect(completed.backgroundColor).toBe(light.homeChipSuccessSurface);

    // The numerals themselves — the previous pass rendered all three in
    // `theme.colors.text` because `warning` on `warningSoft` was 2.86:1.
    const numeralColors = [ar.overdue, ar.pending, ar.completed].map(
      (label) => flatten(rendered.getByText(label).props.style).color,
    );
    expect(numeralColors).toEqual([
      light.homeChipDangerText,
      light.homeChipWarningText,
      light.homeChipSuccessText,
    ]);
    expect(numeralColors).not.toContain(light.text);
    expect(numeralColors).not.toContain(light.mutedText);
  });

  test("keeps the progress ring off the corner the messenger FAB occupies", async () => {
    // The app never calls I18nManager.forceRTL, so on an English-locale device
    // `isRTL` is false while the Arabic panel direction is "rtl". Both the
    // panel's `start` and the FAB's `end` then resolve to the physical right.
    const originalIsRtl = I18nManager.isRTL;
    Object.defineProperty(I18nManager, "isRTL", { configurable: true, value: false });

    try {
      const rendered = await render(
        wrap(<HomeTaskCentre canViewTasks orgId="org1" stats={makeStats()} />),
      );
      const row = flatten(rendered.getByTestId("task-centre-top-row").props.style);
      expect(row.flexDirection).toBe("row-reverse");
    } finally {
      Object.defineProperty(I18nManager, "isRTL", { configurable: true, value: originalIsRtl });
    }
  });
});

describe("KPI deltas", () => {
  test("renders no delta at all while dashboard.stats carries no previous period", async () => {
    const rendered = await render(
      wrap(
        <HomeOverviewCard
          currency="JOD"
          detailsExpanded={false}
          stats={makeStats({ salesVolumeThisMonth: 45_250 })}
          onToggleDetails={jest.fn()}
        />,
      ),
    );

    // Neither a figure nor a reserved blank: the node is absent, so the column
    // closes up rather than leaving a gap where the mock's "+12% ↑" sits.
    expect(rendered.queryByTestId("kpi-delta-up")).toBeNull();
    expect(rendered.queryByTestId("kpi-delta-down")).toBeNull();
    expect(rendered.queryByText(/%/)).toBeNull();
  });

  test("renders the mock's coloured delta the moment a real previous total exists", async () => {
    const stats = {
      ...makeStats({
        salesVolumeThisMonth: 45_250,
        salesTrend: [{ name: "Aug 1", Revenue: 45_250, Profit: 16_900, Expenses: 8_350 }],
      }),
      previousPeriod: { sales: 40_402, expenses: 8_790 },
    } as MobileDashboardStats;

    const rendered = await render(
      wrap(
        <HomeOverviewCard
          currency="JOD"
          detailsExpanded={false}
          stats={stats}
          onToggleDetails={jest.fn()}
        />,
      ),
    );

    expect(flatten(rendered.getByTestId("kpi-delta-up").props.style).color).toBe(
      light.homeDeltaUp,
    );
    expect(flatten(rendered.getByTestId("kpi-delta-down").props.style).color).toBe(
      light.homeDeltaDown,
    );
    // Net profit has no previous total in this payload, so its delta stays away
    // rather than falling back to a zero.
    expect(rendered.queryAllByTestId("kpi-delta-up")).toHaveLength(1);
    expect(rendered.queryAllByTestId("kpi-delta-down")).toHaveLength(1);
  });
});

describe("marketplace banner", () => {
  test("paints a gradient rather than a flat primarySoft tint", async () => {
    const rendered = await render(wrap(<HomeMarketplaceBanner orgId="org1" />));

    const stopColors = gradientStopHexes(rendered.toJSON());

    expect(stopColors).toEqual(
      expect.arrayContaining([
        light.homeBannerFrom,
        light.homeBannerMid,
        light.homeBannerTo,
        light.homeBannerIconFrom,
        light.homeBannerIconTo,
      ]),
    );
    // The tint the previous pass used, which is what made it read as flat.
    expect(stopColors).not.toContain(light.primarySoft);
  });
});

describe("greeting", () => {
  const org = { _id: "org1", name: "Bloom Cars" } as MobileOrgSummary;
  const membership = { roleName: "OWNER", permissions: [] } as unknown as MobileMyMembership;

  test("keeps the owner's own name instead of truncating it on a 720px screen", async () => {
    // Only `users.getMe` answers: the notification bell shares this hook and
    // chokes on a non-array.
    mockUseQuery.mockImplementation(((reference: unknown) =>
      reference === api.users.getMe
        ? { name: "عبدالكريم الزريقات" }
        : undefined) as unknown as typeof useQuery);

    const rendered = await render(wrap(<DealerHomeHeader myMembership={membership} org={org} />));

    const greeting = rendered.getByText(/عبدالكريم/);
    // One line clipped this to "صباح الخير، Abd…" beside a 34dp back button, a
    // bell and an avatar on a 360dp screen.
    expect(greeting.props.numberOfLines).toBeGreaterThan(1);
    expect(greeting.props.children).toContain("عبدالكريم");
  });
});
