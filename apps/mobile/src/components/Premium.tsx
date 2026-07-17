import { useId, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { theme } from "../theme";

/**
 * Premium dark-theme building blocks. All pure JS (react-native-svg is already
 * a dependency) so anything built on top of these ships over-the-air — no new
 * native modules, no fresh APK required.
 */

type GradientDirection = "vertical" | "diagonal" | "horizontal";

function gradientEndpoints(direction: GradientDirection) {
  if (direction === "horizontal") return { x1: "0", y1: "0", x2: "1", y2: "0" };
  if (direction === "diagonal") return { x1: "0", y1: "0", x2: "1", y2: "1" };
  return { x1: "0", y1: "0", x2: "0", y2: "1" };
}

/** Full-bleed linear gradient that fills its (positioned) parent. */
export function GradientFill({
  colors,
  direction = "vertical",
}: {
  colors: readonly string[];
  direction?: GradientDirection;
}) {
  // useId keeps each gradient's <Defs> id unique so multiple gradients on one
  // screen never resolve to the wrong stops.
  const gradientId = `grad-${useId().replace(/:/g, "")}`;
  const stops = colors.length > 0 ? colors : [theme.colors.hero];
  const endpoints = gradientEndpoints(direction);

  return (
    <Svg height="100%" width="100%" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={gradientId} x1={endpoints.x1} y1={endpoints.y1} x2={endpoints.x2} y2={endpoints.y2}>
          {stops.map((color, index) => (
            <Stop
              key={`${color}-${index}`}
              offset={stops.length === 1 ? 0 : index / (stops.length - 1)}
              stopColor={color}
            />
          ))}
        </LinearGradient>
      </Defs>
      <Rect height="100%" width="100%" x="0" y="0" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

/** Rounded gradient hero band. Children render on top of the gradient. */
export function GradientHero({
  children,
  colors = theme.gradients.hero,
  direction = "diagonal",
  style,
}: {
  children?: ReactNode;
  colors?: readonly string[];
  direction?: GradientDirection;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.hero, style]}>
      <GradientFill colors={colors} direction={direction} />
      <View style={styles.heroSheen} />
      {children}
    </View>
  );
}

/** Translucent "glass" card (faux frosted panel — no native blur needed). */
export function GlassCard({
  children,
  strong,
  style,
}: {
  children: ReactNode;
  strong?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.glass, strong && styles.glassStrong, style]}>{children}</View>
  );
}

const styles = StyleSheet.create({
  hero: {
    overflow: "hidden",
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassBorder,
    padding: theme.spacing.xl,
  },
  // A soft top-left highlight that gives the gradient a lit, glassy edge.
  heroSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "56%",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  glass: {
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassBorder,
    backgroundColor: theme.colors.glassBg,
    padding: theme.spacing.lg,
  },
  glassStrong: {
    backgroundColor: theme.colors.glassStrong,
  },
});
