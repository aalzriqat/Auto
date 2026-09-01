/// <reference types="jest" />

import { render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { StyleSheet } from "react-native";

const mockPaginatedQuery = jest.fn();

jest.mock("convex/react", () => ({
  usePaginatedQuery: (...args: unknown[]) => mockPaginatedQuery(...args),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

import { api, type MobileLedgerTransaction } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { AccountingModule } from "./accounting";

const ORG_ID = "org_1";
const AR_NOTICE = "حركات نقدية — للعرض فقط، وليست دفتر الأستاذ العام";
const EN_NOTICE = "Cash movements — view only, not the General Ledger";

// Every affordance that used to write the cashbook from a phone, in both
// languages. Absence of these strings is the assertion this file exists for.
const WRITE_AFFORDANCES = [
  "Add entry",
  "إضافة قيد",
  "Edit",
  "تعديل",
  "Delete",
  "حذف",
  "Save",
  "حفظ",
];

const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

function makeRow(overrides: Partial<MobileLedgerTransaction> = {}): MobileLedgerTransaction {
  return {
    _id: "tx_1",
    orgId: ORG_ID,
    type: "IN",
    amount: 250,
    date: Date.UTC(2026, 0, 15),
    category: "COLLECTION_PAYMENT",
    description: "Down payment from Ahmad",
    vehicleLabel: "Toyota Camry 2022",
    customerName: "Ahmad",
    ...overrides,
  };
}

function renderModule() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <AccountingModule orgId={ORG_ID} />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("AccountingModule — cash movements are read-only", () => {
  beforeEach(() => {
    mockPaginatedQuery.mockReset();
    mockGetItem.mockReset();
    // jest.setup's default: no stored preference, so DEFAULT_LOCALE ("ar") wins.
    mockGetItem.mockResolvedValue(null);
  });

  test("renders a real cash movement, and offers no way to change it", async () => {
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow()],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    // ── Anti-vacuous half. Assert the row actually reached the tree BEFORE
    // asserting anything is absent. A FlatList that rendered nothing at all
    // would satisfy every "no write control" assertion below while proving
    // nothing, so the absence assertions are only meaningful once this passes.
    expect(screen.getByTestId("cash-movement-tx_1")).toBeTruthy();
    expect(screen.getByText("Down payment from Ahmad")).toBeTruthy();
    expect(screen.getByText(/COLLECTION_PAYMENT/)).toBeTruthy();

    // ── The property under test.
    for (const label of WRITE_AFFORDANCES) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // Nothing pressable at all: not merely "no button with that label", but no
    // mutation affordance reachable on the screen. `Exhausted` means the list
    // footer contributes no Load-more button, so this count is the module's own.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("states in Arabic that this is not the General Ledger", async () => {
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow()],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    expect(screen.getByTestId("cash-movement-tx_1")).toBeTruthy();
    expect(screen.getByTestId("cash-movements-notice")).toBeTruthy();
    expect(screen.getByText(AR_NOTICE)).toBeTruthy();
  });

  test("states in English that this is not the General Ledger", async () => {
    mockGetItem.mockResolvedValue("en");
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow()],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    // The locale arrives asynchronously from SecureStore, so the English copy
    // replaces the Arabic default only after that promise resolves.
    await waitFor(() => expect(screen.getByText(EN_NOTICE)).toBeTruthy());
    expect(screen.getByTestId("cash-movement-tx_1")).toBeTruthy();
    expect(screen.getByText("Down payment from Ahmad")).toBeTruthy();
    for (const label of WRITE_AFFORDANCES) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("falls back to the customer when a movement has no vehicle", async () => {
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow({ _id: "tx_2", vehicleLabel: undefined, customerName: "Layla", description: "Refund issued" })],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    expect(screen.getByTestId("cash-movement-tx_2")).toBeTruthy();
    expect(screen.getByText(/· Layla$/)).toBeTruthy();
  });

  test("shows a dash when a movement has neither vehicle nor customer", async () => {
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow({ _id: "tx_3", vehicleLabel: undefined, customerName: undefined, description: "Unlinked movement" })],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    expect(screen.getByTestId("cash-movement-tx_3")).toBeTruthy();
    expect(screen.getByText(/· -$/)).toBeTruthy();
  });

  test("keeps the disclaimer visible when there is nothing to show", async () => {
    mockPaginatedQuery.mockReturnValue({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const screen = await renderModule();

    // An empty screen must still say what it is; the caveat is a property of
    // the surface, not of the rows.
    expect(screen.getByText(AR_NOTICE)).toBeTruthy();
    expect(screen.getByText("لا توجد حركات نقدية.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("reads the cash movements scoped to the caller's org", async () => {
    const loadMore = jest.fn();
    mockPaginatedQuery.mockReturnValue({ results: [], status: "Exhausted", loadMore, isLoading: false });

    await renderModule();

    expect(mockPaginatedQuery).toHaveBeenCalledWith(
      api.transactions.list,
      { orgId: ORG_ID },
      { initialNumItems: 25 },
    );
  });
});

describe("the caution rule leads the reading direction", () => {
  // `borderStartWidth` resolves against the Yoga node's layout direction, which
  // falls back to the NATIVE `I18nManager.isRTL`. This app never calls
  // `forceRTL` — `LocaleProvider` only calls `allowRTL(true)` — so an Arabic UI
  // on an English-locale device has `textDirection: "rtl"` while `isRTL` is
  // false. `apps/mobile/src/features/dashboard/homeModel.ts` documents that
  // exact divergence and compensates for it. `DEFAULT_LOCALE` is "ar", so a
  // first-run user on an English-locale phone is precisely that case.
  //
  // The rule therefore has to be keyed off the APP locale and expressed as a
  // physical edge, the way `SummaryRow` in moduleShared already does it. A
  // logical edge cannot satisfy this, and jest performs no Yoga layout, so
  // asserting the resolved physical property is the only check that can fail
  // when the rule lands on the trailing side.
  async function noticeStyle(stored: string | null) {
    mockGetItem.mockResolvedValue(stored);
    mockPaginatedQuery.mockReturnValue({
      results: [makeRow()],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });
    const screen = await renderModule();
    await waitFor(() =>
      expect(screen.getByText(stored === "en" ? EN_NOTICE : AR_NOTICE)).toBeTruthy(),
    );
    return StyleSheet.flatten(screen.getByTestId("cash-movements-notice").props.style);
  }

  test("sits on the right in Arabic and the left in English", async () => {
    const ar = await noticeStyle(null);
    const en = await noticeStyle("en");

    // Leading edge for right-to-left reading is the physical right.
    expect(ar.borderRightWidth).toBe(3);
    expect(ar.borderLeftWidth).toBeUndefined();

    expect(en.borderLeftWidth).toBe(3);
    expect(en.borderRightWidth).toBeUndefined();

    // The control: the two must actually differ. A rule that ignores the locale
    // produces an identical style object in both, which is the defect itself.
    expect(ar).not.toEqual(en);
  });
});

describe("mobile Convex contract — the client holds no cashbook write", () => {
  test("the client exposes only the read projection", () => {
    // The runtime surface an installed build would actually address. The
    // cross-surface source proof — that the client emits no "transactions:add"
    // string while the backend still exports one during stage 53-A — lives in
    // scripts/convexApiContract.test.ts, which can read both trees.
    expect(Object.keys(api.transactions)).toEqual(["list"]);
  });
});
