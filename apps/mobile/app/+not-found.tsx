import { nativeRoutes } from "@autoflow/shared";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { EmptyState } from "../src/components/EmptyState";
import { Screen } from "../src/components/Screen";
import { useLocale } from "../src/providers/LocaleProvider";
import { theme } from "../src/theme";

export default function NotFoundRoute() {
  const { t, textDirection } = useLocale();
  const router = useRouter();

  return (
    <Screen>
      <View style={[styles.center, { direction: textDirection }]}>
        <EmptyState
          actionLabel={t("home")}
          hint={t("notFoundBody")}
          icon="search"
          onAction={() => router.replace(nativeRoutes.home)}
          title={t("notFoundTitle")}
        />
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
    padding: theme.spacing.xl,
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
});
