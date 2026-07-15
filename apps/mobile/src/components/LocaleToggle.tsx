import { Pressable, StyleSheet, Text } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";
import { Icon } from "./Icon";

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const nextLocale = locale === "ar" ? "en" : "ar";

  return (
    <Pressable
      accessibilityLabel={locale === "ar" ? "Switch to English" : "Switch to Arabic"}
      accessibilityRole="button"
      style={({ pressed }) => [styles.toggle, getLocaleTogglePressedStyle(pressed)]}
      onPress={() => {
        void setLocale(nextLocale);
      }}
    >
      <Icon color="primary" name="language" size={16} />
      <Text style={[styles.toggleText, getTypographyStyle("label", locale, fontsLoaded)]}>
        {nextLocale.toUpperCase()}
      </Text>
    </Pressable>
  );
}

export function getLocaleTogglePressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

const styles = StyleSheet.create({
  toggle: {
    minWidth: 58,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  toggleText: {
    color: theme.colors.text,
  },
  pressed: {
    opacity: 0.82,
  },
});
