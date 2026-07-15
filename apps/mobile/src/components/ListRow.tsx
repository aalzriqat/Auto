import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";
import { Icon, type SemanticIconName } from "./Icon";

type ListRowProps = Readonly<{
  avatarLabel?: string;
  leadingIcon?: SemanticIconName;
  meta?: string;
  onPress?: () => void;
  title: string;
}>;

export function getListRowPressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

export function ListRow({ avatarLabel, leadingIcon, meta, onPress, title }: ListRowProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const leading = leadingIcon ? (
    <View style={styles.iconShell}>
      <Icon color="primary" name={leadingIcon} size={20} />
    </View>
  ) : avatarLabel ? (
    <View style={styles.avatarShell}>
      <Text style={[styles.avatarText, getTypographyStyle("label", locale, fontsLoaded)]}>
        {avatarLabel}
      </Text>
    </View>
  ) : null;
  const content = (
    <>
      {leading}
      <View style={styles.textBlock}>
        <Text numberOfLines={1} style={[styles.title, getTypographyStyle("heading", locale, fontsLoaded)]}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={[styles.meta, getTypographyStyle("caption", locale, fontsLoaded)]}>
            {meta}
          </Text>
        ) : null}
      </View>
      {onPress ? <Icon color="mutedText" name="chevronForward" size={18} /> : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={title}
        accessibilityRole="button"
        android_ripple={{ color: theme.colors.border }}
        style={({ pressed }) => [
          styles.row,
          { direction: textDirection },
          getListRowPressedStyle(pressed),
        ]}
        onPress={onPress}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={[styles.row, { direction: textDirection }]}>{content}</View>;
}

const styles = StyleSheet.create({
  row: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  iconShell: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primarySoft,
  },
  avatarShell: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarText: {
    color: theme.colors.primary,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
  },
  meta: {
    color: theme.colors.mutedText,
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
});
