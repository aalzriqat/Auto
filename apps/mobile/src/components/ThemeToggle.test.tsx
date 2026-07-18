/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";

jest.mock("../themeMode", () => ({
  ...jest.requireActual<typeof import("../themeMode")>("../themeMode"),
  setThemeModeAndReload: jest.fn(),
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { setThemeModeAndReload } from "../themeMode";
import { ThemeToggle, getThemeTogglePressedStyle, resolveThemeToggle } from "./ThemeToggle";

const mockSet = setThemeModeAndReload as jest.MockedFunction<typeof setThemeModeAndReload>;

describe("ThemeToggle", () => {
  beforeEach(() => {
    mockSet.mockReset();
  });

  test("resolveThemeToggle covers both modes and both locales", () => {
    expect(resolveThemeToggle("light", "en")).toEqual({
      nextMode: "dark",
      label: "Dark",
      iconName: "themeDark",
      accessibilityLabel: "Switch to dark theme",
    });
    expect(resolveThemeToggle("dark", "en")).toEqual({
      nextMode: "light",
      label: "Light",
      iconName: "themeLight",
      accessibilityLabel: "Switch to light theme",
    });
    expect(resolveThemeToggle("light", "ar").label).toBe("داكن");
    expect(resolveThemeToggle("dark", "ar").label).toBe("فاتح");
  });

  test("computes pressed style", () => {
    expect(getThemeTogglePressedStyle(false)).toBeNull();
    expect(getThemeTogglePressedStyle(true)).not.toBeNull();
  });

  test("toggles to the opposite theme on press", async () => {
    // The app-wide theme resolves to light in the test env, so the toggle
    // offers to switch to dark.
    const { getByLabelText } = await render(
      <LocaleProvider>
        <ThemeToggle />
      </LocaleProvider>,
    );

    const toggle = getByLabelText("Switch to dark theme");
    await fireEvent(toggle, "pressIn");
    await fireEvent(toggle, "pressOut");
    await fireEvent.press(toggle);

    expect(mockSet).toHaveBeenCalledWith("dark");
  });
});
