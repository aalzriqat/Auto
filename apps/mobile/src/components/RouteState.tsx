import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";

interface RouteStateProps {
  label: string;
}

interface RouteErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function RouteLoadingState({ label }: RouteStateProps) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={theme.colors.primary} size="large" />
      <Text style={styles.body}>{label}</Text>
    </View>
  );
}

export function RouteErrorState({ message, onRetry }: RouteErrorStateProps) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>AutoFlow</Text>
      <Text style={styles.error}>{message || "An unexpected error occurred."}</Text>
      {onRetry ? (
        <Pressable style={({ pressed }) => [styles.button, getRouteButtonPressedStyle(pressed)]} onPress={onRetry}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function getRouteButtonPressedStyle(pressed: boolean) {
  return pressed ? styles.buttonPressed : null;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  title: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "800",
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
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
});
