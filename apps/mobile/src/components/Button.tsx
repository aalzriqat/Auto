import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, theme, type AppTheme } from "../theme";
import { Icon, type SemanticIconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ButtonProps = Readonly<{
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  leadingIcon?: SemanticIconName;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ButtonVariant;
}>;

const makeVariantStyles = (theme: AppTheme) => ({
  primary: {
    container: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    icon: "onPrimary",
    text: {
      color: theme.colors.onPrimary,
    },
  },
  secondary: {
    container: {
      backgroundColor: theme.colors.surfaceAlt,
      borderColor: "transparent",
    },
    icon: "text",
    text: {
      color: theme.colors.text,
    },
  },
  ghost: {
    container: {
      backgroundColor: "transparent",
      borderColor: "transparent",
    },
    icon: "primary",
    text: {
      color: theme.colors.primary,
    },
  },
  danger: {
    container: {
      backgroundColor: theme.colors.dangerSoft,
      borderColor: "transparent",
    },
    icon: "danger",
    text: {
      color: theme.colors.danger,
    },
  },
}) as const;

export function getButtonPressedStyle(pressed: boolean, disabled = false) {
  if (!pressed || disabled) return null;
  return styles.pressed;
}

export function Button({
  accessibilityLabel,
  disabled = false,
  label,
  leadingIcon,
  onPress,
  style,
  testID,
  variant = "primary",
}: ButtonProps) {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const theme = useAppTheme();
  const variantStyles = useThemedStyles(makeVariantStyles);
  const variantStyle = variantStyles[variant];
  const labelStyle = getTypographyStyle("heading", locale, fontsLoaded);
  const content: ReactNode = (
    <>
      {leadingIcon ? (
        <Icon color={variantStyle.icon} name={leadingIcon} size={18} />
      ) : null}
      <Text style={[styles.label, labelStyle, variantStyle.text]}>{label}</Text>
    </>
  );

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: theme.colors.border }}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        variantStyle.container,
        disabled && styles.disabled,
        getButtonPressedStyle(pressed, disabled),
        style,
      ]}
      onPress={onPress}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  label: {
    textAlign: "center",
  },
  disabled: {
    opacity: 0.48,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
});
