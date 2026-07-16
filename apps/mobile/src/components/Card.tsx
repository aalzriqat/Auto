import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { theme } from "../theme";

type CardProps = Readonly<{
  accessibilityLabel?: string;
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>;

export function getCardPressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

export function Card({ accessibilityLabel, children, onPress, style, testID }: CardProps) {
  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        android_ripple={{ color: theme.colors.border }}
        testID={testID}
        style={({ pressed }) => [styles.card, getCardPressedStyle(pressed), style]}
        onPress={onPress}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.98 }],
  },
});
