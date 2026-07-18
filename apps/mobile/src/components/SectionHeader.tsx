import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";

type SectionHeaderProps = Readonly<{
  actionLabel?: string;
  onAction?: () => void;
  subtitle?: string;
  title: string;
}>;

export function getSectionActionPressedStyle(pressed: boolean) {
  return pressed ? { opacity: 0.82 } : null;
}

export function SectionHeader({ actionLabel, onAction, subtitle, title }: SectionHeaderProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const styles = useThemedStyles(makeStyles);

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

const makeStyles = (theme: AppTheme) => StyleSheet.create({
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
  actionText: {
    color: theme.colors.primary,
  },
});
