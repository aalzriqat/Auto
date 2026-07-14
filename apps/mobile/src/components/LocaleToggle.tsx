import { Pressable, StyleSheet, Text } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const nextLocale = locale === "ar" ? "en" : "ar";

  return (
    <Pressable
      accessibilityLabel={locale === "ar" ? "Switch to English" : "Switch to Arabic"}
      accessibilityRole="button"
      style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
      onPress={() => {
        void setLocale(nextLocale);
      }}
    >
      <Text style={styles.toggleText}>{nextLocale.toUpperCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggle: {
    minWidth: 44,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  toggleText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "900",
  },
  pressed: {
    opacity: 0.82,
  },
});
