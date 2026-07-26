import { nativeRoutes } from "@autoflow/shared";
import { useAuth, useSSO } from "@clerk/expo";
import { useSignIn, useSignUp } from "@clerk/expo/legacy";
import { useConvexAuth } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * Also hosts sign-UP, because the marketplace's sell flow sends signed-out
 * sellers here. Without it a private seller who has never used AutoFlow had no
 * way to get an account from the phone at all — the sell form gated correctly
 * on auth and then handed them a screen they could not complete.
 *
 * A self-serve mobile sign-up is always a buyer/private seller: dealership
 * staff accounts are created by org invite, and there is no org-creation UI on
 * mobile. So a brand-new account lands on the marketplace rather than the
 * dealer workspace picker, which for an orgless user shows only "no
 * workspaces".
 */
type AuthMode = "signIn" | "signUp" | "verify";

export default function SignInRoute() {
  const router = useRouter();
  // Lets the caller (e.g. the sell flow) bring the user back where they were
  // instead of dumping every sign-in on the dealer workspace picker.
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const { fontsLoaded } = useAppFontState();
  const { locale, t, textDirection } = useLocale();
  const { isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const { isLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setActiveSignUp } = useSignUp();
  const { startSSOFlow } = useSSO();

  const destination = returnTo === "marketplace" ? nativeRoutes.marketplace : nativeRoutes.dealerWorkspaces;

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
    if (isSignedIn && isAuthenticated) router.replace(destination);
  }, [isSignedIn, isAuthenticated, router, destination]);

  // Every auth call below settles in a `finally` that clears the busy flag. The
  // screen navigates away on success, so that clear (and any error set on a
  // late rejection) can land after unmount. Guarding on a mounted ref keeps
  // those updates from firing against a torn-down tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [mode, setMode] = useState<AuthMode>("signIn");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "google" | "password" | "signUp" | "verify">(null);

  // Switching between sign-in and sign-up must not carry a stale error or code
  // across — the previous mode's failure message is meaningless in the new one.
  const switchMode = useCallback((next: AuthMode) => {
    setMode(next);
    setError(null);
    setCode("");
  }, []);

  const type = useCallback(
    (variant: Parameters<typeof getTypographyStyle>[0]) => getTypographyStyle(variant, locale, fontsLoaded),
    [locale, fontsLoaded],
  );

  const messageFromError = useCallback(
    (e: unknown): string =>
      (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message || t("signInError"),
    [t],
  );

  const messageFromSignUpError = useCallback(
    (e: unknown): string =>
      (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message || t("signUpError"),
    [t],
  );

  const finishSignIn = useCallback(() => router.replace(destination), [router, destination]);

  // A freshly self-registered account has no org, so the workspace picker would
  // only show an empty state — send new accounts to the marketplace instead.
  const finishSignUp = useCallback(() => router.replace(nativeRoutes.marketplace), [router]);

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
      if (mountedRef.current) setError(messageFromError(e));
    } finally {
      if (mountedRef.current) setBusy(null);
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
      if (mountedRef.current) setError(messageFromError(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [isLoaded, busy, identifier, password, signIn, setActive, finishSignIn, t, messageFromError]);

  const submitSignUp = useCallback(async () => {
    if (!signUpLoaded || busy || !identifier.trim() || !password) return;
    setBusy("signUp");
    setError(null);
    try {
      await signUp.create({ emailAddress: identifier.trim(), password });
      // Clerk requires the email be confirmed before the session can go
      // active; move to the code step rather than leaving a half-created
      // sign-up the user can't act on.
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      switchMode("verify");
    } catch (e) {
      if (mountedRef.current) setError(messageFromSignUpError(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [signUpLoaded, busy, identifier, password, signUp, switchMode, messageFromSignUpError]);

  const submitVerification = useCallback(async () => {
    if (!signUpLoaded || busy || !code.trim()) return;
    setBusy("verify");
    setError(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (attempt.status === "complete") {
        await setActiveSignUp({ session: attempt.createdSessionId });
        finishSignUp();
        return;
      }
      // Anything else means Clerk wants a step this form doesn't implement
      // (e.g. phone verification); say so instead of silently doing nothing.
      setError(t("signUpNeedsMoreSteps"));
    } catch (e) {
      if (mountedRef.current) setError(messageFromSignUpError(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [signUpLoaded, busy, code, signUp, setActiveSignUp, finishSignUp, t, messageFromSignUpError]);

  const resendCode = useCallback(async () => {
    if (!signUpLoaded || busy) return;
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    } catch (e) {
      if (mountedRef.current) setError(messageFromSignUpError(e));
    }
  }, [signUpLoaded, busy, signUp, messageFromSignUpError]);

  return (
    <Screen scroll padding="lg">
      <View style={[styles.shell, { direction: textDirection }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.brand, type("label")]}>{t("appName")}</Text>
            <Text style={[styles.title, type("title")]}>
              {mode === "signIn" ? t("signIn") : mode === "signUp" ? t("signUpTitle") : t("signUpVerifyTitle")}
            </Text>
            <Text style={[styles.body, type("body")]}>
              {mode === "signIn"
                ? t("signedOutSubtitle")
                : mode === "signUp"
                  ? t("signUpSubtitle")
                  : t("signUpVerifyBody")}
            </Text>
          </View>
          <LocaleToggle />
        </View>

        <Card style={styles.authCard}>
          {mode === "verify" ? (
            <>
              <Text style={[styles.label, type("label")]}>{t("signUpCodeLabel")}</Text>
              <TextInput
                accessibilityLabel={t("signUpCodeLabel")}
                style={[styles.input, type("body")]}
                value={code}
                onChangeText={setCode}
                placeholder={t("signUpCodePlaceholder")}
                placeholderTextColor={theme.colors.mutedText}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                editable={busy === null}
                onSubmitEditing={submitVerification}
              />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signUpVerifySubmit")}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}
                onPress={submitVerification}
                disabled={busy !== null}
              >
                <Text style={[styles.primaryLabel, type("label")]}>
                  {busy === "verify" ? t("signUpVerifySubmitting") : t("signUpVerifySubmit")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signUpResendCode")}
                onPress={resendCode}
                disabled={busy !== null}
              >
                <Text style={[styles.switchAction, type("caption")]}>{t("signUpResendCode")}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signInWithGoogle")}
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

              <Text style={[styles.label, type("label")]}>
                {mode === "signUp" ? t("signUpEmailLabel") : t("signInIdentifierLabel")}
              </Text>
              <TextInput
                accessibilityLabel={mode === "signUp" ? t("signUpEmailLabel") : t("signInIdentifierLabel")}
                style={[styles.input, type("body")]}
                value={identifier}
                onChangeText={setIdentifier}
                placeholder={mode === "signUp" ? t("signUpEmailPlaceholder") : t("signInIdentifierPlaceholder")}
                placeholderTextColor={theme.colors.mutedText}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete={mode === "signUp" ? "email" : "username"}
                editable={busy === null}
              />

              <Text style={[styles.label, type("label")]}>
                {mode === "signUp" ? t("signUpPasswordLabel") : t("signInPasswordLabel")}
              </Text>
              <TextInput
                accessibilityLabel={mode === "signUp" ? t("signUpPasswordLabel") : t("signInPasswordLabel")}
                style={[styles.input, type("body")]}
                value={password}
                onChangeText={setPassword}
                placeholder={mode === "signUp" ? t("signUpPasswordPlaceholder") : t("signInPasswordPlaceholder")}
                placeholderTextColor={theme.colors.mutedText}
                secureTextEntry
                autoCapitalize="none"
                autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                editable={busy === null}
                onSubmitEditing={mode === "signUp" ? submitSignUp : signInWithPassword}
              />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={mode === "signUp" ? t("signUpSubmit") : t("signInSubmit")}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}
                onPress={mode === "signUp" ? submitSignUp : signInWithPassword}
                disabled={busy !== null}
              >
                <Text style={[styles.primaryLabel, type("label")]}>
                  {mode === "signUp"
                    ? busy === "signUp"
                      ? t("signUpSubmitting")
                      : t("signUpSubmit")
                    : busy === "password"
                      ? t("signInSubmitting")
                      : t("signInSubmit")}
                </Text>
              </Pressable>

              <View style={styles.switchRow}>
                <Text style={[styles.dividerText, type("caption")]}>
                  {mode === "signUp" ? t("signUpHaveAccount") : t("signUpNoAccount")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={mode === "signUp" ? t("signUpSwitchToSignIn") : t("signUpSwitchToSignUp")}
                  onPress={() => switchMode(mode === "signUp" ? "signIn" : "signUp")}
                  disabled={busy !== null}
                >
                  <Text style={[styles.switchAction, type("caption")]}>
                    {mode === "signUp" ? t("signUpSwitchToSignIn") : t("signUpSwitchToSignUp")}
                  </Text>
                </Pressable>
              </View>
            </>
          )}

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
  switchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
  },
  switchAction: {
    color: theme.colors.primary,
    fontWeight: "700",
    textAlign: "center",
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
