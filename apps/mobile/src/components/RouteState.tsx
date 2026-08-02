import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useOptionalLocale } from "../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";

interface RouteStateProps {
  label: string;
}

interface RouteErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

const GENERIC_ERROR_MESSAGE = {
  en: "An unexpected error occurred.",
  ar: "حدث خطأ غير متوقع.",
} as const;

export function RouteLoadingState({ label }: RouteStateProps) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.center}>
      <View style={styles.stateCard}>
        <ActivityIndicator color={theme.colors.primary} size="large" />
        <Text style={styles.body}>{label}</Text>
      </View>
    </View>
  );
}

export function RouteErrorState({ message, onRetry }: RouteErrorStateProps) {
  const styles = useThemedStyles(makeStyles);
  // Deliberately the provider-free hook: this is expo-router's root
  // ErrorBoundary, which renders above LocaleProvider.
  const { locale, t, textDirection } = useOptionalLocale();

  return (
    <View style={styles.center}>
      <View style={[styles.stateCard, { direction: textDirection }]}>
        <Text style={styles.title}>{t("appName")}</Text>
        <Text style={styles.error}>{message || GENERIC_ERROR_MESSAGE[locale]}</Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, getRouteButtonPressedStyle(pressed)]}
            onPress={onRetry}
          >
            <Text style={styles.buttonText}>{t("retry")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function getRouteButtonPressedStyle(pressed: boolean) {
  return pressed ? pressedStyles.buttonPressed : null;
}

const pressedStyles = StyleSheet.create({
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
});

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  stateCard: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.xl,
    ...theme.shadows.sm,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.typography.title.fontSize,
    fontWeight: theme.typography.title.fontWeight,
    lineHeight: theme.typography.title.lineHeight,
  },
  body: {
    color: theme.colors.mutedText,
    fontSize: 16,
    textAlign: "center",
  },
  error: {
    color: theme.colors.danger,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  button: {
    minHeight: 48,
    minWidth: 112,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
  },
  buttonText: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
});
