import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { theme } from "../theme";

type SkeletonRowProps = Readonly<{
  count?: number;
}>;

export function SkeletonRow({ count = 1 }: SkeletonRowProps) {
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 720,
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 720,
          toValue: 0.45,
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <View style={styles.stack}>
      {Array.from({ length: count }).map((_, index) => (
        <Animated.View
          key={`skeleton-${index}`}
          testID="skeleton-row"
          style={[styles.row, { opacity }]}
        >
          <View style={styles.avatar} />
          <View style={styles.textBlock}>
            <View style={styles.lineWide} />
            <View style={styles.lineShort} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: theme.spacing.sm,
  },
  row: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  textBlock: {
    flex: 1,
    gap: theme.spacing.sm,
  },
  lineWide: {
    width: "72%",
    height: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  lineShort: {
    width: "46%",
    height: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
});
