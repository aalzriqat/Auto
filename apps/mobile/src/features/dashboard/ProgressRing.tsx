import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useCountUp } from "../../components/Motion";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { useDashboardTypography } from "./dashboardTypography";

/**
 * Ring weight, as a fraction of the diameter.
 *
 * Measured off DESIGN-dark.png: the arc is ~10px thick on a ~106px outer
 * diameter, so the mock's ring is 9.4% of its own size at every size it is
 * drawn at. Hard-coding 9dp made the ring thinner the larger it got.
 */
const STROKE_RATIO = 0.094;
const PROGRESS_STEPS = 100;

/**
 * Completion ring for the task centre.
 *
 * The sweep animates through `useCountUp`, which already reads the OS
 * "Reduce Motion" setting and jumps straight to the final value when it is on —
 * so this component gets that behaviour without a second implementation of it.
 *
 * In RTL the ring is mirrored so it fills in the reading direction; the label
 * sits in an overlay rather than an SVG text node, so it is never mirrored with
 * it and stays selectable by the accessibility tree.
 */
export function ProgressRing({
  caption,
  label,
  ratio,
  size = 96,
}: Readonly<{
  caption?: string;
  label: string;
  ratio: number;
  size?: number;
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { isRtl } = useLocale();
  // The memoized hook, not a second copy of it: `useCountUp` re-renders this
  // component on every animation frame, so the style objects need stable
  // identities.
  const type = useDashboardTypography();

  const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const animatedSteps = useCountUp(Math.round(safeRatio * PROGRESS_STEPS));
  const progress = animatedSteps / PROGRESS_STEPS;

  const stroke = Math.round(size * STROKE_RATIO);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.shell, { width: size, height: size }]}>
        <Svg
          height={size}
          style={isRtl ? styles.mirrored : undefined}
          width={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          <Circle
            cx={size / 2}
            cy={size / 2}
            fill="none"
            r={radius}
            // `homeRingTrack`, not `surfaceAlt`: the mock tints the unfilled
            // arc toward the ring's own blue rather than leaving it neutral.
            stroke={theme.colors.homeRingTrack}
            strokeWidth={stroke}
          />
          <Circle
            cx={size / 2}
            cy={size / 2}
            fill="none"
            // -90° puts the start of the sweep at 12 o'clock, not 3 o'clock.
            origin={`${size / 2}, ${size / 2}`}
            r={radius}
            rotation={-90}
            stroke={theme.colors.homeRingArc}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
            strokeWidth={stroke}
          />
        </Svg>
        <View pointerEvents="none" style={styles.overlay}>
          <Text style={[styles.label, type.heading]}>
            {label}
          </Text>
        </View>
      </View>
      {caption ? (
        <Text
          numberOfLines={1}
          style={[styles.caption, type.caption]}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  wrapper: {
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  shell: {
    alignItems: "center",
    justifyContent: "center",
  },
  mirrored: {
    transform: [{ scaleX: -1 }],
  },
  overlay: {
    // Spelled out rather than `StyleSheet.absoluteFillObject`, which this
    // React Native version does not type, and with logical start/end so the
    // overlay is correct under RTL.
    position: "absolute",
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    color: theme.colors.text,
    fontSize: 21,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  caption: {
    // The mock captions the ring in the completion tone, not in neutral grey.
    color: theme.colors.homeChipSuccessText,
    fontWeight: "700",
  },
});
