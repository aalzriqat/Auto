import { nativeRoutes } from "@autoflow/shared";
import { AuthView } from "@clerk/expo/native";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { Card } from "../../src/components/Card";
import { LocaleToggle } from "../../src/components/LocaleToggle";
import { Screen } from "../../src/components/Screen";
import { useAppFontState } from "../../src/providers/AppFontContext";
import { useLocale } from "../../src/providers/LocaleProvider";
import { useThemedStyles } from "../../src/providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../../src/theme";

export default function SignInRoute() {
  const router = useRouter();
  const { fontsLoaded } = useAppFontState();
  const { locale, t, textDirection } = useLocale();
  const styles = useThemedStyles(makeStyles);

  return (
    <Screen scroll padding="lg">
      <View style={[styles.shell, { direction: textDirection }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.brand, getTypographyStyle("label", locale, fontsLoaded)]}>
              {t("appName")}
            </Text>
            <Text style={[styles.title, getTypographyStyle("title", locale, fontsLoaded)]}>
              {t("signIn")}
            </Text>
            <Text style={[styles.body, getTypographyStyle("body", locale, fontsLoaded)]}>
              {t("signedOutSubtitle")}
            </Text>
          </View>
          <LocaleToggle />
        </View>
        <Card style={styles.authCard}>
          <AuthView onDismiss={() => router.replace(nativeRoutes.home)} />
        </Card>
      </View>
    </Screen>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  shell: {
    flex: 1,
    gap: theme.spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  brand: {
    color: theme.colors.primary,
  },
  title: {
    color: theme.colors.text,
  },
  body: {
    color: theme.colors.mutedText,
  },
  authCard: {
    borderRadius: theme.radius.xl,
  },
});
