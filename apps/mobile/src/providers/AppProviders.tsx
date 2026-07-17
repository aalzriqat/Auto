import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import {
  Cairo_400Regular,
  Cairo_600SemiBold,
  Cairo_700Bold,
} from "@expo-google-fonts/cairo";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { validateMobileEnv } from "../config/env";
import { PushNotificationsGate } from "../notifications/PushNotificationsGate";
import { getTypographyStyle, theme } from "../theme";
import { OtaUpdateGate } from "../updates/OtaUpdateGate";
import {
  AppFontStateProvider,
  useAppFontState,
  type AppFontState,
} from "./AppFontContext";
import { LocaleProvider, useLocale } from "./LocaleProvider";

export { useAppFontState } from "./AppFontContext";

void SplashScreen.preventAutoHideAsync().catch((error: unknown) => {
  console.error("Failed to keep the splash screen visible while loading fonts", error);
});

const MOBILE_FONT_ASSETS = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Cairo_400Regular,
  Cairo_600SemiBold,
  Cairo_700Bold,
} as const;

const envResult = validateMobileEnv();
const convex = envResult.success
  ? new ConvexReactClient(envResult.data.convexUrl, {
      unsavedChangesWarning: false,
    })
  : null;
const configurationErrorMessage = envResult.success
  ? "Convex client could not be initialized."
  : envResult.message;

function AppFontGate({ children }: { children: ReactNode }) {
  const [loaded, error] = useFonts(MOBILE_FONT_ASSETS);
  const ready = loaded || Boolean(error);
  const value = useMemo<AppFontState>(() => ({ fontsLoaded: loaded && !error }), [error, loaded]);

  useEffect(() => {
    if (error) {
      console.error("Failed to load AutoFlow mobile fonts", error);
    }
  }, [error]);

  useEffect(() => {
    if (!ready) return;

    void SplashScreen.hideAsync().catch((hideError: unknown) => {
      console.error("Failed to hide the splash screen after loading fonts", hideError);
    });
  }, [ready]);

  if (!ready) {
    return null;
  }

  return <AppFontStateProvider value={value}>{children}</AppFontStateProvider>;
}

function ConfigurationError({ message }: { message: string }) {
  const { fontsLoaded } = useAppFontState();
  const { locale, t, textDirection } = useLocale();

  return (
    <View style={[styles.configError, { direction: textDirection }]}>
      <Text style={[styles.configTitle, getTypographyStyle("title", locale, fontsLoaded)]}>
        {t("configurationErrorTitle")}
      </Text>
      <Text style={[styles.configBody, getTypographyStyle("body", locale, fontsLoaded)]}>
        {t("configurationErrorBody")}
      </Text>
      <Text style={[styles.configDetail, getTypographyStyle("caption", locale, fontsLoaded)]}>
        {message}
      </Text>
    </View>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider>
      <OtaUpdateGate>
        <AppFontGate>
        <LocaleProvider>
          {envResult.success && convex ? (
            <ClerkProvider publishableKey={envResult.data.clerkPublishableKey} tokenCache={tokenCache}>
              <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
                <PushNotificationsGate>{children}</PushNotificationsGate>
              </ConvexProviderWithClerk>
            </ClerkProvider>
          ) : (
            <ConfigurationError message={configurationErrorMessage} />
          )}
        </LocaleProvider>
        </AppFontGate>
      </OtaUpdateGate>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  configError: {
    flex: 1,
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  configTitle: {
    color: theme.colors.text,
    textAlign: "center",
  },
  configBody: {
    color: theme.colors.mutedText,
    textAlign: "center",
  },
  configDetail: {
    color: theme.colors.danger,
    textAlign: "center",
  },
});
