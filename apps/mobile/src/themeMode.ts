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

/**
 * Persist the chosen theme and reload the JS bundle so the new palette takes
 * effect (the stylesheets rebuild on a fresh load). expo-updates is imported
 * lazily so neither module-load nor the test env pulls it in. If reload isn't
 * available (e.g. a dev client), the theme still applies on the next launch.
 */
export async function setThemeModeAndReload(mode: ThemeMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(THEME_MODE_KEY, mode);
  } catch {
    // Non-fatal: fall through and still try to reload.
  }
  try {
    const Updates = await import("expo-updates");
    await Updates.reloadAsync();
  } catch {
    // Reload unavailable — the persisted choice applies on the next app launch.
  }
}
