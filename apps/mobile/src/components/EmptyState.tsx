import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";
import { Button } from "./Button";
import { Icon, type SemanticIconName } from "./Icon";

type EmptyStateProps = Readonly<{
  actionLabel?: string;
  hint?: string;
  icon?: SemanticIconName;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  title: string;
}>;

export function EmptyState({
  actionLabel,
  hint,
  icon = "search",
  onAction,
  style,
  title,
}: EmptyStateProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={[styles.root, { direction: textDirection }, style]}>
      <View style={styles.iconShell}>
        <Icon color="primary" name={icon} size={28} />
      </View>
      <View style={styles.textBlock}>
        <Text style={[styles.title, getTypographyStyle("heading", locale, fontsLoaded)]}>
          {title}
        </Text>
        {hint ? (
          <Text style={[styles.hint, getTypographyStyle("body", locale, fontsLoaded)]}>
            {hint}
          </Text>
        ) : null}
      </View>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" />
      ) : null}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  root: {
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.xl,
    ...theme.shadows.sm,
  },
  iconShell: {
    width: 58,
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primarySoft,
  },
  textBlock: {
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
    textAlign: "center",
  },
  hint: {
    color: theme.colors.mutedText,
    textAlign: "center",
  },
});
