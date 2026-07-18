import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";

type CardProps = Readonly<{
  accessibilityLabel?: string;
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>;

export function getCardPressedStyle(pressed: boolean) {
  return pressed ? pressedStyles.pressed : null;
}

export function Card({ accessibilityLabel, children, onPress, style, testID }: CardProps) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
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

const pressedStyles = StyleSheet.create({
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.98 }],
  },
});

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  card: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
});
