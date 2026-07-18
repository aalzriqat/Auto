import { Pressable, StyleSheet, Text } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useThemeMode, useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";
import { type ThemeMode } from "../themeMode";
import { Icon, type SemanticIconName } from "./Icon";

/**
 * Pure view model for the theme toggle — kept separate so both theme modes and
 * both locales are unit-testable.
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
  const { mode, toggle } = useThemeMode();
  const styles = useThemedStyles(makeStyles);
  const { label, iconName, accessibilityLabel } = resolveThemeToggle(mode, locale);

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={({ pressed }) => [styles.toggle, getThemeTogglePressedStyle(pressed)]}
      onPress={toggle}
    >
      <Icon color="primary" name={iconName} size={16} />
      <Text style={[styles.toggleText, getTypographyStyle("label", locale, fontsLoaded)]}>{label}</Text>
    </Pressable>
  );
}

export function getThemeTogglePressedStyle(pressed: boolean) {
  return pressed ? { opacity: 0.82 } : null;
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
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
  });
