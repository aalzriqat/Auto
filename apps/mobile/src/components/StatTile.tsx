import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";
import { Icon, type SemanticIconName } from "./Icon";

export type StatTileTone = "primary" | "success" | "warning" | "info";

type StatTileProps = Readonly<{
  caption?: string;
  icon: SemanticIconName;
  label: string;
  style?: StyleProp<ViewStyle>;
  tone?: StatTileTone;
  value: string;
}>;

const toneStyles = {
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
  info: {
    backgroundColor: theme.colors.infoSoft,
    color: theme.colors.info,
  },
} as const;

export function StatTile({
  caption,
  icon,
  label,
  style,
  tone = "primary",
  value,
}: StatTileProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const toneStyle = toneStyles[tone];

  return (
    <View style={[styles.tile, { direction: textDirection }, style]}>
      <View style={[styles.iconShell, { backgroundColor: toneStyle.backgroundColor }]}>
        <Icon color={tone} name={icon} size={22} />
      </View>
      <View style={styles.textBlock}>
        <Text style={[styles.label, getTypographyStyle("label", locale, fontsLoaded)]}>
          {label}
        </Text>
        <Text style={[styles.value, getTypographyStyle("title", locale, fontsLoaded)]}>
          {value}
        </Text>
        {caption ? (
          <Text style={[styles.caption, getTypographyStyle("caption", locale, fontsLoaded)]}>
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    minHeight: 124,
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  iconShell: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
  textBlock: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.mutedText,
  },
  value: {
    color: theme.colors.text,
  },
  caption: {
    color: theme.colors.mutedText,
  },
});
