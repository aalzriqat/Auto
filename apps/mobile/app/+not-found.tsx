import { nativeRoutes } from "@autoflow/shared";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "../src/components/Screen";
import { useLocale } from "../src/providers/LocaleProvider";
import { theme } from "../src/theme";

export default function NotFoundRoute() {
  const { t, textDirection } = useLocale();
  const router = useRouter();

  return (
    <Screen>
      <View style={[styles.center, { direction: textDirection }]}>
        <Text style={styles.title}>{t("notFoundTitle")}</Text>
        <Text style={styles.body}>{t("notFoundBody")}</Text>
        <Pressable
          style={({ pressed }) => [styles.button, getNotFoundButtonPressedStyle(pressed)]}
          onPress={() => router.replace(nativeRoutes.home)}
        >
          <Text style={styles.buttonText}>{t("home")}</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export function getNotFoundButtonPressedStyle(pressed: boolean) {
  return pressed ? styles.buttonPressed : null;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: theme.spacing.xl,
  },
  title: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  body: {
    color: theme.colors.mutedText,
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
  },
  button: {
    minHeight: 48,
    minWidth: 120,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
});
