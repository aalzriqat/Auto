import { useId, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";

import { useLocale } from "../../providers/LocaleProvider";
import { withAlpha } from "../../theme";

/**
 * Painting primitives for the dealer home screen.
 *
 * Both are drawn with `react-native-svg`, which is already a native dependency
 * of this app (the progress ring and the messenger FAB use it). Nothing here
 * adds a module to the native build, so the screen ships over the air.
 * `expo-linear-gradient` is NOT installed and deliberately was not added.
 *
 * `useId` values contain colons, which are legal in an SVG id but make an
 * awkward `url(#…)` reference — they are stripped so two mounted gradients can
 * never resolve to each other's paint server.
 */
function useGradientId(prefix: string): string {
  return `${prefix}${useId().replace(/:/g, "")}`;
}

/**
 * The icon halo on the dark quick-action tiles.
 *
 * Measured from DESIGN-dark.png by sampling concentric rings around a tile's
 * icon: the accent's excess over the tile background falls from +28/255 at 9dp
 * to +2 at 21dp and is gone by 24dp — a smooth radial falloff, not a ring or a
 * filled badge. Three stops reproduce that curve closely enough that the
 * difference is below one 8-bit step over most of the radius.
 *
 * Static by design, so there is no animation for `useReduceMotion` to suppress.
 */
export function IconGlow({
  children,
  color,
  size,
  strength = 1,
}: Readonly<{
  children: ReactNode;
  color: string;
  /** Diameter of the halo, in dp. The icon is centred inside it. */
  size: number;
  /** Scales every stop's alpha — the light theme wants a far quieter halo. */
  strength?: number;
}>) {
  const gradientId = useGradientId("homeGlow");

  return (
    <View style={[styles.glowShell, { width: size, height: size }]}>
      <Svg height={size} pointerEvents="none" style={StyleSheet.absoluteFill} width={size}>
        <Defs>
          <RadialGradient cx="50%" cy="50%" id={gradientId} r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={0.42 * strength} />
            <Stop offset="0.45" stopColor={color} stopOpacity={0.2 * strength} />
            <Stop offset="0.75" stopColor={color} stopOpacity={0.06 * strength} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect fill={`url(#${gradientId})`} height={size} width={size} x={0} y={0} />
      </Svg>
      {children}
    </View>
  );
}

/**
 * The marketplace banner's fill.
 *
 * The dark mock runs a diagonal from an indigo top-start corner (#262c82) to a
 * navy bottom-end one (#0a1939), sampled at t=0/0.5/1 along that axis. It is
 * emphatically not the flat `primarySoft` tint the previous pass shipped.
 *
 * The bright corner sits behind the icon in the mock. The icon is a logical
 * `start` child, so under RTL the axis is mirrored with it rather than being
 * pinned to a physical corner and drifting away from the thing it lights.
 */
export function GradientSurface({
  colors,
  radius,
  style,
}: Readonly<{
  /** From the bright corner to the dark one: [start, mid, end]. */
  colors: readonly [string, string, string];
  radius: number;
  style?: StyleProp<ViewStyle>;
}>) {
  const gradientId = useGradientId("homeBanner");
  const { isRtl } = useLocale();

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius }, styles.clip, style]}>
      <Svg height="100%" width="100%">
        <Defs>
          <LinearGradient
            id={gradientId}
            x1={isRtl ? "100%" : "0%"}
            x2={isRtl ? "0%" : "100%"}
            y1="0%"
            y2="100%"
          >
            <Stop offset="0" stopColor={colors[0]} />
            <Stop offset="0.5" stopColor={colors[1]} />
            <Stop offset="1" stopColor={colors[2]} />
          </LinearGradient>
        </Defs>
        <Rect fill={`url(#${gradientId})`} height="100%" width="100%" x="0" y="0" />
      </Svg>
    </View>
  );
}

/**
 * The banner's icon plaque: a vertical gradient tile with the same accent
 * bleeding out behind it, matching the halo the mock draws around it.
 */
export function GradientTile({
  children,
  colors,
  radius,
  size,
}: Readonly<{
  children: ReactNode;
  colors: readonly [string, string];
  radius: number;
  size: number;
}>) {
  const gradientId = useGradientId("homeTile");

  return (
    <View
      style={[
        styles.gradientTile,
        {
          width: size,
          height: size,
          borderRadius: radius,
          shadowColor: colors[0],
          shadowOpacity: 0.55,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 4 },
        },
      ]}
    >
      <Svg height={size} pointerEvents="none" style={StyleSheet.absoluteFill} width={size}>
        <Defs>
          <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0" stopColor={colors[0]} />
            <Stop offset="1" stopColor={colors[1]} />
          </LinearGradient>
        </Defs>
        <Rect
          fill={`url(#${gradientId})`}
          height={size}
          rx={radius}
          ry={radius}
          width={size}
          x={0}
          y={0}
        />
      </Svg>
      {children}
    </View>
  );
}

/** A hairline in the accent's own hue, used for the tinted panels and chips. */
export function toneBorder(color: string, alpha = 0.35): string {
  return withAlpha(color, alpha);
}

const styles = StyleSheet.create({
  glowShell: {
    alignItems: "center",
    justifyContent: "center",
  },
  clip: {
    overflow: "hidden",
  },
  gradientTile: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    elevation: 4,
  },
});
