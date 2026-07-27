import { nativeRoutes } from "@autoflow/shared";
import { useAuth, useSSO } from "@clerk/expo";
import { useSignIn, useSignUp } from "@clerk/expo/legacy";
import { useConvexAuth } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Card } from "../../src/components/Card";
import { makeButtonStyle } from "../../src/components/pressableStyle";
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

// Text-only links wrap a caption-sized Text, so their tappable area is roughly
// one line high — well under the 44pt minimum both platforms ask for.
const TAP_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

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

  // Marks that the session being activated came from a registration. Must be a
  // ref, set synchronously *before* the session is activated: activating flips
  // isSignedIn, which re-renders and fires the redirect effect below. A state
  // update would not have landed by then, so the effect would compute the
  // dealer workspace picker and navigate there first — a visible flash of an
  // empty workspace list, plus a stray history entry, for an account that by
  // definition has no organization.
  const cameFromSignUp = useRef(false);

  const destination =
    returnTo === "marketplace" || cameFromSignUp.current
      ? nativeRoutes.marketplace
      : nativeRoutes.dealerWorkspaces;

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

  const [mode, setMode] = useState<AuthMode>("signIn");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "google" | "password" | "signUp" | "verify" | "resend">(null);

  // `busy` drives the UI, but it is state: two taps in the same frame both read
  // the pre-update value and fire the request twice (and `disabled` has not
  // re-rendered yet either). This ref flips synchronously, so it is what
  // actually prevents a double submit — duplicate sign-in attempts, or a second
  // verification email that trips Clerk's rate limit.
  const inFlight = useRef(false);

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
    if (inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(null);
    }
  }, [startSSOFlow, finishSignIn, messageFromError]);

  const signInWithPassword = useCallback(async () => {
    if (!isLoaded || inFlight.current || !identifier.trim() || !password) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(null);
    }
  }, [isLoaded, identifier, password, signIn, setActive, finishSignIn, t, messageFromError]);

  const submitSignUp = useCallback(async () => {
    if (!signUpLoaded || inFlight.current || !identifier.trim() || !password) return;
    inFlight.current = true;
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
      setError(messageFromSignUpError(e));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [signUpLoaded, identifier, password, signUp, switchMode, messageFromSignUpError]);

  const submitVerification = useCallback(async () => {
    if (!signUpLoaded || inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setBusy("verify");
    setError(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (attempt.status === "complete") {
        // Before activating: see cameFromSignUp.
        cameFromSignUp.current = true;
        await setActiveSignUp({ session: attempt.createdSessionId });
        finishSignUp();
        return;
      }
      // Anything else means Clerk wants a step this form doesn't implement
      // (e.g. phone verification); say so instead of silently doing nothing.
      setError(t("signUpNeedsMoreSteps"));
    } catch (e) {
      setError(messageFromSignUpError(e));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [signUpLoaded, code, signUp, setActiveSignUp, finishSignUp, t, messageFromSignUpError]);

  const resendCode = useCallback(async () => {
    if (!signUpLoaded || inFlight.current) return;
    inFlight.current = true;
    // Marks itself busy like every other handler. Without this the control's
    // disabled={busy !== null} only blocked it during a *verification*
    // attempt, so repeat taps each sent another email and quickly tripped
    // Clerk's rate limit.
    setBusy("resend");
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    } catch (e) {
      setError(messageFromSignUpError(e));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [signUpLoaded, signUp, messageFromSignUpError]);

  // Per-mode copy, keyed rather than nested ternaries in the JSX: three modes
  // times title/body/labels was most of this component's branch weight.
  const copy = {
    signIn: {
      title: t("signIn"),
      body: t("signedOutSubtitle"),
      identifierLabel: t("signInIdentifierLabel"),
      identifierPlaceholder: t("signInIdentifierPlaceholder"),
      passwordLabel: t("signInPasswordLabel"),
      passwordPlaceholder: t("signInPasswordPlaceholder"),
      submit: t("signInSubmit"),
      submitting: t("signInSubmitting"),
      switchPrompt: t("signUpNoAccount"),
      switchAction: t("signUpSwitchToSignUp"),
    },
    signUp: {
      title: t("signUpTitle"),
      body: t("signUpSubtitle"),
      identifierLabel: t("signUpEmailLabel"),
      identifierPlaceholder: t("signUpEmailPlaceholder"),
      passwordLabel: t("signUpPasswordLabel"),
      passwordPlaceholder: t("signUpPasswordPlaceholder"),
      submit: t("signUpSubmit"),
      submitting: t("signUpSubmitting"),
      switchPrompt: t("signUpHaveAccount"),
      switchAction: t("signUpSwitchToSignIn"),
    },
    verify: {
      title: t("signUpVerifyTitle"),
      body: t("signUpVerifyBody"),
      identifierLabel: "",
      identifierPlaceholder: "",
      passwordLabel: "",
      passwordPlaceholder: "",
      submit: t("signUpVerifySubmit"),
      submitting: t("signUpVerifySubmitting"),
      switchPrompt: "",
      switchAction: "",
    },
  }[mode];

  return (
    <Screen scroll padding="lg">
      <View style={[styles.shell, { direction: textDirection }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.brand, type("label")]}>{t("appName")}</Text>
            <Text style={[styles.title, type("title")]}>{copy.title}</Text>
            <Text style={[styles.body, type("body")]}>{copy.body}</Text>
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
                style={makeButtonStyle(styles.primaryButton, styles.pressed, styles.disabled, busy !== null)}
                onPress={submitVerification}
                disabled={busy !== null}
              >
                <Text style={[styles.primaryLabel, type("label")]}>
                  {busy === "verify" ? copy.submitting : copy.submit}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signUpResendCode")}
                hitSlop={TAP_SLOP}
                onPress={resendCode}
                disabled={busy !== null}
              >
                <Text style={[styles.switchAction, type("caption")]}>{t("signUpResendCode")}</Text>
              </Pressable>

              {/* Without a way back, a typo in the email address is a dead end:
                  no code ever arrives and the credential form is unreachable
                  short of killing the app. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signUpChangeEmail")}
                hitSlop={TAP_SLOP}
                onPress={() => switchMode("signUp")}
                disabled={busy !== null}
              >
                <Text style={[styles.switchAction, type("caption")]}>{t("signUpChangeEmail")}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("signInWithGoogle")}
                style={makeButtonStyle(styles.googleButton, styles.pressed, styles.disabled, busy !== null)}
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
                {copy.identifierLabel}
              </Text>
              <TextInput
                accessibilityLabel={copy.identifierLabel}
                style={[styles.input, type("body")]}
                value={identifier}
                onChangeText={setIdentifier}
                placeholder={copy.identifierPlaceholder}
                placeholderTextColor={theme.colors.mutedText}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete={mode === "signUp" ? "email" : "username"}
                editable={busy === null}
              />

              <Text style={[styles.label, type("label")]}>
                {copy.passwordLabel}
              </Text>
              <TextInput
                accessibilityLabel={copy.passwordLabel}
                style={[styles.input, type("body")]}
                value={password}
                onChangeText={setPassword}
                placeholder={copy.passwordPlaceholder}
                placeholderTextColor={theme.colors.mutedText}
                secureTextEntry
                autoCapitalize="none"
                autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                editable={busy === null}
                onSubmitEditing={mode === "signUp" ? submitSignUp : signInWithPassword}
              />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.submit}
                style={makeButtonStyle(styles.primaryButton, styles.pressed, styles.disabled, busy !== null)}
                onPress={mode === "signUp" ? submitSignUp : signInWithPassword}
                disabled={busy !== null}
              >
                <Text style={[styles.primaryLabel, type("label")]}>
                  {busy === "signUp" || busy === "password" ? copy.submitting : copy.submit}
                </Text>
              </Pressable>

              <View style={styles.switchRow}>
                <Text style={[styles.dividerText, type("caption")]}>{copy.switchPrompt}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.switchAction}
                  hitSlop={TAP_SLOP}
                  onPress={() => switchMode(mode === "signUp" ? "signIn" : "signUp")}
                  disabled={busy !== null}
                >
                  <Text style={[styles.switchAction, type("caption")]}>{copy.switchAction}</Text>
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
