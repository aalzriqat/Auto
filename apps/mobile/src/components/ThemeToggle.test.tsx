/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";

import { LocaleProvider } from "../providers/LocaleProvider";
import { ThemeProvider } from "../providers/ThemeProvider";
import { ThemeToggle, getThemeTogglePressedStyle, resolveThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
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

  test("flips the theme live on press (no reload)", async () => {
    const { getByLabelText } = await render(
      <ThemeProvider>
        <LocaleProvider>
          <ThemeToggle />
        </LocaleProvider>
      </ThemeProvider>,
    );

    // Default is light, so the toggle offers to switch to dark.
    const toggle = getByLabelText("Switch to dark theme");
    await fireEvent(toggle, "pressIn");
    await fireEvent(toggle, "pressOut");
    await fireEvent.press(toggle);

    // After pressing, the provider mode is dark, so it now offers light — live,
    // with no reload.
    expect(getByLabelText("Switch to light theme")).toBeTruthy();
  });
});
