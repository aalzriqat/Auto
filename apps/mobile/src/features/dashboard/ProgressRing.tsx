import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useCountUp } from "../../components/Motion";
import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../../theme";

const STROKE = 9;
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
  const { isRtl, locale } = useLocale();
  const { fontsLoaded } = useAppFontState();

  const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const animatedSteps = useCountUp(Math.round(safeRatio * PROGRESS_STEPS));
  const progress = animatedSteps / PROGRESS_STEPS;

  const radius = (size - STROKE) / 2;
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
            stroke={theme.colors.surfaceAlt}
            strokeWidth={STROKE}
          />
          <Circle
            cx={size / 2}
            cy={size / 2}
            fill="none"
            // -90° puts the start of the sweep at 12 o'clock, not 3 o'clock.
            origin={`${size / 2}, ${size / 2}`}
            r={radius}
            rotation={-90}
            stroke={theme.colors.primary}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
            strokeWidth={STROKE}
          />
        </Svg>
        <View pointerEvents="none" style={styles.overlay}>
          <Text style={[styles.label, getTypographyStyle("heading", locale, fontsLoaded)]}>
            {label}
          </Text>
        </View>
      </View>
      {caption ? (
        <Text
          numberOfLines={1}
          style={[styles.caption, getTypographyStyle("caption", locale, fontsLoaded)]}
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
    fontVariant: ["tabular-nums"],
  },
  caption: {
    color: theme.colors.mutedText,
    fontWeight: "700",
  },
});
