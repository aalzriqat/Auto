/// <reference types="jest" />

/**
 * SCRUM-902: the mobile reports module needs view:cost_price for the sales and inventory figures (the server returns null
 * without it). Without it the two queries are skipped, the cost tiles show a dash instead of a zero, and the note shows in
 * the user's language; with it both are requested and no note shows.
 */
import { render } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));

import { api } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { REPORTS_COST_ACCESS_NOTE, ReportsModule } from "./reports";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

beforeEach(() => {
  mockUseQuery.mockClear();
  mockUseMutation.mockReturnValue(jest.fn() as never);
  mockUseQuery.mockReturnValue(undefined as never);
});
afterEach(() => jest.restoreAllMocks());

const mount = (permissions: string[]) =>
  render(
    <ThemeProvider>
      <LocaleProvider>
        <ReportsModule orgId="org_1" permissions={permissions} />
      </LocaleProvider>
    </ThemeProvider>,
  );

const costRefs = [api.reports.getSalesAndProfitReport, api.reports.getInventoryReport];

describe.each([["en"], ["ar"]] as const)("SCRUM-902 mobile reports cost gate (%s)", (locale) => {
  beforeEach(() => mockGetItem.mockResolvedValue(locale));

  test("reports without cost-price access: the note is shown and the sales and inventory queries are skipped", async () => {
    const view = await mount(["view:reports"]);
    expect(await view.findByText(REPORTS_COST_ACCESS_NOTE[locale])).toBeTruthy();
    const costCalls = mockUseQuery.mock.calls.filter(([ref]) => costRefs.includes(ref as never));
    expect(costCalls.length).toBeGreaterThan(0);
    expect(costCalls.every(([, args]) => args === "skip")).toBe(true);
  });

  test("control: reports with cost-price access requests both and shows no note", async () => {
    const view = await mount(["view:reports", "view:cost_price"]);
    expect(view.queryByText(REPORTS_COST_ACCESS_NOTE[locale])).toBeNull();
    for (const ref of costRefs) {
      expect(mockUseQuery.mock.calls.some(([r, args]) => r === ref && args !== "skip")).toBe(true);
    }
  });
});

test("the English and Arabic notes differ", () => {
  expect(REPORTS_COST_ACCESS_NOTE.en).not.toBe(REPORTS_COST_ACCESS_NOTE.ar);
});
