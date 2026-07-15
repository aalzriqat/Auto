import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";

type SectionHeaderProps = Readonly<{
  actionLabel?: string;
  onAction?: () => void;
  subtitle?: string;
  title: string;
}>;

export function getSectionActionPressedStyle(pressed: boolean) {
  return pressed ? styles.actionPressed : null;
}

export function SectionHeader({ actionLabel, onAction, subtitle, title }: SectionHeaderProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <View style={styles.textBlock}>
        <Text style={[styles.title, getTypographyStyle("heading", locale, fontsLoaded)]}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, getTypographyStyle("caption", locale, fontsLoaded)]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityLabel={actionLabel}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, getSectionActionPressedStyle(pressed)]}
          onPress={onAction}
        >
          <Text style={[styles.actionText, getTypographyStyle("label", locale, fontsLoaded)]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
  },
  subtitle: {
    color: theme.colors.mutedText,
  },
  action: {
    minHeight: 34,
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primarySoft,
    paddingHorizontal: theme.spacing.md,
  },
  actionPressed: {
    opacity: 0.82,
  },
  actionText: {
    color: theme.colors.primary,
  },
});
