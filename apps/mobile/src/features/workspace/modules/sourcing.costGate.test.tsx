/// <reference types="jest" />

/**
 * SCRUM-902: the mobile sourcing module needs view:cost_price as well as view:finance (the server requires the pair).
 * Without it the module sends no query and shows the note in the user's language; with it the list is requested.
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
import { SOURCING_COST_ACCESS_NOTE, SourcingModule } from "./sourcing";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

beforeEach(() => {
  mockUseQuery.mockClear();
  mockUseMutation.mockReturnValue(jest.fn() as never);
  mockUseQuery.mockReturnValue([] as never);
});
afterEach(() => jest.restoreAllMocks());

const mount = (permissions: string[]) =>
  render(
    <ThemeProvider>
      <LocaleProvider>
        <SourcingModule orgId="org_1" permissions={permissions} />
      </LocaleProvider>
    </ThemeProvider>,
  );

describe.each([["en"], ["ar"]] as const)("SCRUM-902 mobile sourcing cost gate (%s)", (locale) => {
  beforeEach(() => mockGetItem.mockResolvedValue(locale));

  test("finance without cost-price access: the note is shown and the list query is skipped", async () => {
    const view = await mount(["view:finance", "manage:finance"]);
    expect(await view.findByText(SOURCING_COST_ACCESS_NOTE[locale])).toBeTruthy();
    const listCalls = mockUseQuery.mock.calls.filter(([ref]) => ref === api.sourcingPayables.list);
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every(([, args]) => args === "skip")).toBe(true);
  });

  test("control: finance with cost-price access requests the list and shows no note", async () => {
    const view = await mount(["view:finance", "view:cost_price"]);
    expect(view.queryByText(SOURCING_COST_ACCESS_NOTE[locale])).toBeNull();
    expect(mockUseQuery.mock.calls.some(([ref, args]) => ref === api.sourcingPayables.list && args !== "skip")).toBe(true);
  });
});

test("the English and Arabic notes differ", () => {
  expect(SOURCING_COST_ACCESS_NOTE.en).not.toBe(SOURCING_COST_ACCESS_NOTE.ar);
});
