/// <reference types="jest" />

/**
 * SCRUM-778: the two mobile screens that carry the commission mode drive the
 * real components. An org that never chose a mode shows AUTO_MEMBER, the other
 * settings are saved before the mode door is called, a refused settings save
 * never reaches the mode door, and a refused mode change is reported truthfully.
 */
import { fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  usePaginatedQuery: jest.fn(),
  useQuery: jest.fn(),
}));
jest.mock("./moduleShared", () => {
  const actual = jest.requireActual("./moduleShared");
  return {
    ...actual,
    // A plain input keeps the test on the screen's save logic instead of the select modal.
    SelectField: ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => {
      const { TextInput: Input } = jest.requireActual("react-native");
      return <Input testID={`select-${label}`} value={value} onChangeText={onChange} />;
    },
  };
});

import { api } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { saveResultMessage } from "./commissionModeSave";
import { CommissionSettingsModule } from "./commissionSettings";
import { SettingsModule } from "./settings";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

const upsert = jest.fn();
const setMode = jest.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const MEMBERSHIP = { roleName: "Owner", permissions: ["view:settings"] } as never;
const ORG = { _id: "org_1", name: "Bloom Cars" } as never;

function withProviders(node: React.ReactElement) {
  return (
    <ThemeProvider>
      <LocaleProvider>{node}</LocaleProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue(null);
  setMode.mockReset().mockResolvedValue(null);
  mockGetItem.mockResolvedValue("en");
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockUseMutation.mockImplementation(((ref: unknown) =>
    ref === api.orgSettings.upsert ? upsert : ref === api.orgSettings.setCommissionMode ? setMode : jest.fn()) as unknown as typeof useMutation);
});
afterEach(() => jest.restoreAllMocks());

describe("commission settings screen", () => {
  test("shows a loading state until settings arrive", async () => {
    mockUseQuery.mockReturnValue(undefined as never);
    const view = await render(withProviders(<CommissionSettingsModule orgId="org_1" />));
    expect(view.queryByTestId("select-Commission mode")).toBeNull();
  });

  test("an org with no stored mode shows AUTO_MEMBER and a same-mode save leaves the mode door alone", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1", commissionTiers: [{ minProfitAmount: 1000, commissionPct: 7.5 }, { minProfitAmount: 0, commissionPct: 5 }] } as never);
    const view = await render(withProviders(<CommissionSettingsModule orgId="org_1" />));
    expect(view.getByTestId("select-Commission mode").props.value).toBe("AUTO_MEMBER");
    // Existing tiers load sorted by profit, one per line, and drive the preview rate.
    expect(view.getByDisplayValue("0,5\n1000,7.5")).toBeTruthy();
    expect(view.getByText("Rate: 7.5%")).toBeTruthy();

    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(upsert).toHaveBeenCalledWith({
      orgId: "org_1",
      commissionTiers: [{ minProfitAmount: 0, commissionPct: 5 }, { minProfitAmount: 1000, commissionPct: 7.5 }],
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("AutoFlow", saveResultMessage("saved", "en"));
  });

  test("a deliberate choice saves the tiers first, then calls the mode door", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1" } as never);
    const view = await render(withProviders(<CommissionSettingsModule orgId="org_1" />));
    await fireEvent.changeText(view.getByTestId("select-Commission mode"), "MANUAL");
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(setMode).toHaveBeenCalledWith({ orgId: "org_1", commissionMode: "MANUAL" });
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(setMode.mock.invocationCallOrder[0]);
  });

  test("a refused tiers save never reaches the mode door", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1" } as never);
    upsert.mockRejectedValue(new Error("refused"));
    const view = await render(withProviders(<CommissionSettingsModule orgId="org_1" />));
    await fireEvent.changeText(view.getByTestId("select-Commission mode"), "MANUAL");
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(setMode).not.toHaveBeenCalled();
  });

  test("a refused mode change after the save is reported as such", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1" } as never);
    setMode.mockRejectedValue(new Error("owner only"));
    const view = await render(withProviders(<CommissionSettingsModule orgId="org_1" />));
    await fireEvent.changeText(view.getByTestId("select-Commission mode"), "MANUAL");
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(Alert.alert).toHaveBeenCalledWith("AutoFlow", saveResultMessage("settingsSavedModeFailed", "en"));
  });
});

describe("general settings screen", () => {
  const renderSettings = () => render(withProviders(<SettingsModule myMembership={MEMBERSHIP} org={ORG} />));

  test("an org with no stored mode shows AUTO_MEMBER", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1", currency: "JOD" } as never);
    const view = await renderSettings();
    expect(view.getByTestId("select-Commission mode").props.value).toBe("AUTO_MEMBER");
  });

  test("shows a loading state until settings arrive", async () => {
    mockUseQuery.mockReturnValue(undefined as never);
    const view = await renderSettings();
    expect(view.queryByTestId("select-Commission mode")).toBeNull();
  });

  test("saving without touching the mode never calls the mode door and never sends a mode to upsert", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1", currency: "JOD", dealershipName: "Bloom Cars" } as never);
    const view = await renderSettings();
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).not.toHaveProperty("commissionMode");
    expect(setMode).not.toHaveBeenCalled();
  });

  test("a deliberate choice calls the mode door after the settings are accepted", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1", currency: "JOD" } as never);
    const view = await renderSettings();
    await fireEvent.changeText(view.getByTestId("select-Commission mode"), "MANUAL");
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(setMode).toHaveBeenCalledWith({ orgId: "org_1", commissionMode: "MANUAL" });
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(setMode.mock.invocationCallOrder[0]);
  });

  test("a refused settings save never reaches the mode door", async () => {
    mockUseQuery.mockReturnValue({ orgId: "org_1", currency: "JOD" } as never);
    upsert.mockRejectedValue(new Error("refused"));
    const view = await renderSettings();
    await fireEvent.changeText(view.getByTestId("select-Commission mode"), "MANUAL");
    await fireEvent.press(await view.findByRole("button", { name: "Save" }));
    await settle();

    expect(setMode).not.toHaveBeenCalled();
  });
});
