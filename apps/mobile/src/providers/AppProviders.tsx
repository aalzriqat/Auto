import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { validateMobileEnv } from "../config/env";
import { theme } from "../theme";
import { LocaleProvider, useLocale } from "./LocaleProvider";

const envResult = validateMobileEnv();
const convex = envResult.success
  ? new ConvexReactClient(envResult.data.convexUrl, {
      unsavedChangesWarning: false,
    })
  : null;
const configurationErrorMessage = envResult.success
  ? "Convex client could not be initialized."
  : envResult.message;

function ConfigurationError({ message }: { message: string }) {
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.configError, { direction: textDirection }]}>
      <Text style={styles.configTitle}>{t("configurationErrorTitle")}</Text>
      <Text style={styles.configBody}>{t("configurationErrorBody")}</Text>
      <Text style={styles.configDetail}>{message}</Text>
    </View>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider>
      <LocaleProvider>
        {envResult.success && convex ? (
          <ClerkProvider publishableKey={envResult.data.clerkPublishableKey} tokenCache={tokenCache}>
            <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
              {children}
            </ConvexProviderWithClerk>
          </ClerkProvider>
        ) : (
          <ConfigurationError message={configurationErrorMessage} />
        )}
      </LocaleProvider>
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
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  configBody: {
    color: theme.colors.mutedText,
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
  },
  configDetail: {
    color: theme.colors.danger,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
});
