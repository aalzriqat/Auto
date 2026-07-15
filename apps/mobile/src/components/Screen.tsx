import type { ReactNode } from "react";
import { ScrollView, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { theme } from "../theme";

type ScreenPadding = "none" | "sm" | "md" | "lg";

type ScreenProps = Readonly<{
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  padding?: ScreenPadding;
  scroll?: boolean;
}>;

const paddingStyles = {
  none: null,
  sm: { padding: theme.spacing.sm },
  md: { padding: theme.spacing.md },
  lg: { padding: theme.spacing.lg },
} as const satisfies Record<ScreenPadding, StyleProp<ViewStyle>>;

export function Screen({
  children,
  contentStyle,
  padding = "none",
  scroll = false,
}: ScreenProps) {
  const contentContainerStyle = [paddingStyles[padding], contentStyle];

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={styles.scroll}
          contentContainerStyle={contentContainerStyle}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    flex: 1,
  },
});
