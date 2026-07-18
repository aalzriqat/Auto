import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { buildTheme, resolveStatusBarStyle, type AppTheme } from "../theme";
import { readInitialThemeMode, THEME_MODE_KEY, type ThemeMode } from "../themeMode";

type ThemeContextValue = {
  mode: ThemeMode;
  theme: AppTheme;
  statusBarStyle: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const FALLBACK_THEME = buildTheme("light");

function persist(mode: ThemeMode) {
  void SecureStore.setItemAsync(THEME_MODE_KEY, mode).catch(() => {
    // Non-fatal: the choice still applies for this session.
  });
}

/**
 * Holds the active theme mode in React state so switching is INSTANT (no reload)
 * and re-renders every consumer of useAppTheme / useThemedStyles. The initial
 * value is read synchronously at mount so there's no light->dark flash on start;
 * changes are persisted to SecureStore.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readInitialThemeMode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    persist(next);
  }, []);

  const toggle = useCallback(() => {
    setModeState((current) => {
      const next = current === "dark" ? "light" : "dark";
      persist(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      theme: buildTheme(mode),
      statusBarStyle: resolveStatusBarStyle(mode),
      setMode,
      toggle,
    }),
    [mode, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Active theme (falls back to light when rendered without a provider, e.g. tests). */
export function useAppTheme(): AppTheme {
  return useContext(ThemeContext)?.theme ?? FALLBACK_THEME;
}

export function useStatusBarStyle(): "light" | "dark" {
  return useContext(ThemeContext)?.statusBarStyle ?? "dark";
}

export function useThemeMode(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void; toggle: () => void } {
  const ctx = useContext(ThemeContext);
  if (ctx) {
    return { mode: ctx.mode, setMode: ctx.setMode, toggle: ctx.toggle };
  }
  return { mode: "light", setMode: () => undefined, toggle: () => undefined };
}

/**
 * Build a StyleSheet from the active theme, memoized per theme. `factory` MUST be
 * a stable module-scope function (name its param `theme` so existing style bodies
 * are unchanged).
 */
export function useThemedStyles<T>(factory: (theme: AppTheme) => T): T {
  const theme = useAppTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
