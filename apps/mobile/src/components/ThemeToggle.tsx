import { Pressable, StyleSheet, Text } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme, themeMode } from "../theme";
import { setThemeModeAndReload, type ThemeMode } from "../themeMode";
import { Icon, type SemanticIconName } from "./Icon";

/**
 * Pure view model for the theme toggle — kept separate so both theme modes and
 * both locales are unit-testable without needing to flip the app-wide theme
 * (which is resolved once at startup).
 */
export function resolveThemeToggle(
  currentMode: ThemeMode,
  locale: "en" | "ar",
): { nextMode: ThemeMode; label: string; iconName: SemanticIconName; accessibilityLabel: string } {
  const nextMode: ThemeMode = currentMode === "dark" ? "light" : "dark";
  const label =
    nextMode === "dark"
      ? locale === "ar" ? "داكن" : "Dark"
      : locale === "ar" ? "فاتح" : "Light";
  const iconName: SemanticIconName = nextMode === "dark" ? "themeDark" : "themeLight";
  const accessibilityLabel = nextMode === "dark" ? "Switch to dark theme" : "Switch to light theme";
  return { nextMode, label, iconName, accessibilityLabel };
}

export function ThemeToggle() {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const { nextMode, label, iconName, accessibilityLabel } = resolveThemeToggle(themeMode, locale);

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={({ pressed }) => [styles.toggle, getThemeTogglePressedStyle(pressed)]}
      onPress={() => {
        void setThemeModeAndReload(nextMode);
      }}
    >
      <Icon color="primary" name={iconName} size={16} />
      <Text style={[styles.toggleText, getTypographyStyle("label", locale, fontsLoaded)]}>{label}</Text>
    </Pressable>
  );
}

export function getThemeTogglePressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

const styles = StyleSheet.create({
  toggle: {
    minWidth: 58,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  toggleText: {
    color: theme.colors.text,
  },
  pressed: {
    opacity: 0.82,
  },
});
