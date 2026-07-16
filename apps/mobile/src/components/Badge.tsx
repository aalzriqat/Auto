import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

type BadgeProps = Readonly<{
  label: string;
  style?: StyleProp<ViewStyle>;
  tone?: BadgeTone;
}>;

const toneStyles = {
  neutral: {
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.mutedText,
  },
  primary: {
    backgroundColor: theme.colors.primarySoft,
    color: theme.colors.primary,
  },
  success: {
    backgroundColor: theme.colors.successSoft,
    color: theme.colors.success,
  },
  warning: {
    backgroundColor: theme.colors.warningSoft,
    color: theme.colors.warning,
  },
  danger: {
    backgroundColor: theme.colors.dangerSoft,
    color: theme.colors.danger,
  },
  info: {
    backgroundColor: theme.colors.infoSoft,
    color: theme.colors.info,
  },
} as const;

export function Badge({ label, style, tone = "neutral" }: BadgeProps) {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const toneStyle = toneStyles[tone];

  return (
    <View style={[styles.badge, { backgroundColor: toneStyle.backgroundColor }, style]}>
      <Text style={[styles.badgeText, getTypographyStyle("label", locale, fontsLoaded), { color: toneStyle.color }]}>
        {label}
      </Text>
    </View>
  );
}

export function Pill({ label, style, tone = "neutral" }: BadgeProps) {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const toneStyle = toneStyles[tone];

  return (
    <View style={[styles.pill, { backgroundColor: toneStyle.backgroundColor }, style]}>
      <Text style={[styles.pillText, getTypographyStyle("caption", locale, fontsLoaded), { color: toneStyle.color }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  badgeText: {
    textAlign: "center",
  },
  pill: {
    alignSelf: "flex-start",
    minHeight: 30,
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  pillText: {
    textAlign: "center",
  },
});
