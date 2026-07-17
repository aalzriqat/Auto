import { nativeRoutes } from "@autoflow/shared";
import { useAuth, useSSO } from "@clerk/expo";
import { useSignIn } from "@clerk/expo/legacy";
import { useConvexAuth } from "convex/react";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Card } from "../../src/components/Card";
import { LocaleToggle } from "../../src/components/LocaleToggle";
import { Screen } from "../../src/components/Screen";
import { useAppFontState } from "../../src/providers/AppFontContext";
import { useLocale } from "../../src/providers/LocaleProvider";
import { getTypographyStyle, theme } from "../../src/theme";

// Lets the OAuth browser tab hand its result back to the app.
WebBrowser.maybeCompleteAuthSession();

/**
 * Custom sign-in screen. Replaces Clerk's native <AuthView/>, which renders a
 * blank, non-interactive form on this device (clerk-android). Mirrors the web
 * app's options against the same instance: email/username + password, and
 * Google SSO.
 */
export default function SignInRoute() {
  const router = useRouter();
  const { fontsLoaded } = useAppFontState();
  const { locale, t, textDirection } = useLocale();
  const { isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const { isLoaded, signIn, setActive } = useSignIn();
  const { startSSOFlow } = useSSO();

  // Single source of truth for "signed in → leave the sign-in screen". Covers
  // every path (Google SSO, password, or an already-active session on launch);
  // the OAuth flow in particular activates the session out-of-band, so relying
  // on the mutation's return value alone left the user stranded here.
  //
  // Gate on Convex auth too, not just Clerk: a Clerk session whose issuer the
  // Convex deployment does not trust leaves isSignedIn=true / isAuthenticated
  // =false. Redirecting on isSignedIn alone bounced the user straight back to
  // this screen from home (which also treats that state as signed out),
  // trapping them with no way to reach the form and retry.
  useEffect(() => {
    if (isSignedIn && isAuthenticated) router.replace(nativeRoutes.home);
  }, [isSignedIn, isAuthenticated, router]);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "google" | "password">(null);

  const type = useCallback(
    (variant: Parameters<typeof getTypographyStyle>[0]) => getTypographyStyle(variant, locale, fontsLoaded),
    [locale, fontsLoaded],
  );

  const messageFromError = useCallback(
    (e: unknown): string =>
      (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message || t("signInError"),
    [t],
  );

  const finishSignIn = useCallback(() => router.replace(nativeRoutes.home), [router]);

  const signInWithGoogle = useCallback(async () => {
    if (busy) return;
    setBusy("google");
    setError(null);
    try {
      // No redirectUrl → useSSO defaults to AuthSession.makeRedirectUri({ path:
      // "sso-callback" }), i.e. autoflow://sso-callback, which the standalone
      // build handles.
      const { createdSessionId, setActive: ssoSetActive } = await startSSOFlow({
        strategy: "oauth_google",
      });
      if (createdSessionId && ssoSetActive) {
        await ssoSetActive({ session: createdSessionId });
        finishSignIn();
      }
      // No session = the user closed the browser flow — not an error.
    } catch (e) {
      setError(messageFromError(e));
    } finally {
      setBusy(null);
    }
  }, [busy, startSSOFlow, finishSignIn, messageFromError]);

  const signInWithPassword = useCallback(async () => {
    if (!isLoaded || busy || !identifier.trim() || !password) return;
    setBusy("password");
    setError(null);
    try {
      // Two-step: create the sign-in with the identifier, then attempt the
      // password first factor explicitly. More robust than passing password to
      // create(), and surfaces a clear error when the account has no password
      // (e.g. a Google-only account).
      await signIn.create({ identifier: identifier.trim() });
      const attempt = await signIn.attemptFirstFactor({ strategy: "password", password });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        finishSignIn();
        return;
      }
      // A non-complete status means 2FA / extra verification the mobile form
      // doesn't handle yet — send them to the web app rather than fail silently.
      setError(t("signInNeedsMoreSteps"));
    } catch (e) {
      setError(messageFromError(e));
    } finally {
      setBusy(null);
    }
  }, [isLoaded, busy, identifier, password, signIn, setActive, finishSignIn, t, messageFromError]);

  return (
    <Screen scroll padding="lg">
      <View style={[styles.shell, { direction: textDirection }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.brand, type("label")]}>{t("appName")}</Text>
            <Text style={[styles.title, type("title")]}>{t("signIn")}</Text>
            <Text style={[styles.body, type("body")]}>{t("signedOutSubtitle")}</Text>
          </View>
          <LocaleToggle />
        </View>

        <Card style={styles.authCard}>
          <Pressable
            style={({ pressed }) => [styles.googleButton, pressed && styles.pressed, busy !== null && styles.disabled]}
            onPress={signInWithGoogle}
            disabled={busy !== null}
          >
            {busy === "google" ? (
              <ActivityIndicator color={theme.colors.text} />
            ) : (
              <Text style={[styles.googleLabel, type("label")]}>{t("signInWithGoogle")}</Text>
            )}
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={[styles.dividerText, type("caption")]}>{t("signInOr")}</Text>
            <View style={styles.divider} />
          </View>

          <Text style={[styles.label, type("label")]}>{t("signInIdentifierLabel")}</Text>
          <TextInput
            style={[styles.input, type("body")]}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder={t("signInIdentifierPlaceholder")}
            placeholderTextColor={theme.colors.mutedText}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="username"
            editable={busy === null}
          />

          <Text style={[styles.label, type("label")]}>{t("signInPasswordLabel")}</Text>
          <TextInput
            style={[styles.input, type("body")]}
            value={password}
            onChangeText={setPassword}
            placeholder={t("signInPasswordPlaceholder")}
            placeholderTextColor={theme.colors.mutedText}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            editable={busy === null}
            onSubmitEditing={signInWithPassword}
          />

          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}
            onPress={signInWithPassword}
            disabled={busy !== null}
          >
            <Text style={[styles.primaryLabel, type("label")]}>
              {busy === "password" ? t("signInSubmitting") : t("signInSubmit")}
            </Text>
          </Pressable>

          {error ? <Text style={[styles.error, type("caption")]}>{error}</Text> : null}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
    gap: theme.spacing.sm,
  },
  googleButton: {
    height: 52,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  googleLabel: {
    color: theme.colors.text,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    marginVertical: theme.spacing.xs,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerText: {
    color: theme.colors.mutedText,
  },
  label: {
    color: theme.colors.text,
    marginTop: theme.spacing.xs,
  },
  input: {
    height: 52,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.lg,
    color: theme.colors.text,
  },
  primaryButton: {
    height: 52,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.sm,
  },
  primaryLabel: {
    color: "#ffffff",
  },
  disabled: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.85,
  },
  error: {
    color: theme.colors.danger,
    textAlign: "center",
  },
});
