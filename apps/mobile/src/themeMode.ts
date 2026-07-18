import * as SecureStore from "expo-secure-store";

export type ThemeMode = "light" | "dark";

export const THEME_MODE_KEY = "autoflow-mobile-theme";

/**
 * Read the persisted theme SYNCHRONOUSLY at startup so the static stylesheets
 * (StyleSheet.create runs at import time) are built from the right palette.
 * Defaults to light — the original theme — and never throws.
 */
export function readInitialThemeMode(): ThemeMode {
  try {
    return SecureStore.getItem?.(THEME_MODE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
