import { useAuth } from "@clerk/expo";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { makeButtonStyle } from "../components/pressableStyle";
import { Screen } from "../components/Screen";
import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";
import {
  biometricFailureStringKey,
  canRetryBiometrics,
  shouldOfferSystemSettings,
} from "./biometricCopy";
import {
  isBiometricUnlockArmed,
  unlockWithBiometrics,
  type BiometricFailure,
} from "./biometricUnlock";

/**
 * A quick tab-out to copy a phone number should not cost a fingerprint. Longer
 * than this and the phone has plausibly left the owner's hands, which is the
 * whole scenario this gate exists for.
 */
const RELOCK_AFTER_MS = 60_000;

/**
 * Renders the lock screen INSTEAD of the app while the gate is closed, rather
 * than laying an overlay over a live tree: an overlay leaves the real screens
 * mounted, subscribed, and one stray layout bug away from being readable.
 *
 * The gate only ever appears for a signed-in user who opted in. It is not an
 * authentication step — see biometricUnlock.ts — and it always offers a
 * password sign-in, including in the states where biometrics cannot succeed at
 * all. A user who re-registers their fingerprint must never lose their account.
 */
export function BiometricLockGate({ children }: Readonly<{ children: ReactNode }>) {
  const { isSignedIn, signOut } = useAuth();
  const { locale, t, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const styles = useThemedStyles(makeStyles);

  const [locked, setLocked] = useState(false);
  const [reason, setReason] = useState<BiometricFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const appStateRef = useRef(AppState.currentState);
  const leftForegroundAtRef = useRef<number | null>(null);
  // The OS prompt is modal; a second attempt fired underneath it (a re-render,
  // an impatient second tap) resolves as a cancel and would flash a spurious
  // "Cancelled" at the user. Flips synchronously, unlike `busy`.
  const inFlightRef = useRef(false);

  const attemptUnlock = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setReason(null);

    try {
      const result = await unlockWithBiometrics({
        face: t("biometricPromptFace"),
        fingerprint: t("biometricPromptFingerprint"),
      });

      if (result.ok) {
        setLocked(false);
        return;
      }

      setReason(result.reason);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [t]);

  // Lock whenever there is a signed-in session to protect and the user has
  // opted in. Signing out clears the gate: there is nothing left behind it, and
  // leaving it up would strand the sign-in screen behind a lock screen.
  useEffect(() => {
    if (!isSignedIn) {
      setLocked(false);
      setReason(null);
      return;
    }

    void isBiometricUnlockArmed().then((armed) => {
      if (armed) setLocked(true);
    });
  }, [isSignedIn]);

  // Re-lock after a long trip to the background. Mirrors OtaUpdateGate's
  // AppState handling so the two behave the same way on a resume.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = appStateRef.current;
      appStateRef.current = next;

      if (next === "background" || next === "inactive") {
        leftForegroundAtRef.current = Date.now();
        return;
      }

      const cameBack = next === "active" && (previous === "background" || previous === "inactive");
      const awayFor = Date.now() - (leftForegroundAtRef.current ?? Date.now());
      if (!cameBack || awayFor < RELOCK_AFTER_MS) return;

      void isBiometricUnlockArmed().then((armed) => {
        if (armed) {
          setReason(null);
          setLocked(true);
        }
      });
    });

    return () => subscription.remove();
  }, []);

  // Ask as soon as the lock appears, so the usual case is "open app, touch
  // sensor" with no intervening tap.
  useEffect(() => {
    if (locked && reason === null) void attemptUnlock();
  }, [locked, reason, attemptUnlock]);

  const usePasswordInstead = useCallback(() => {
    // Drops the local session, which is the honest meaning of "use my password
    // instead": the next screen is a real Clerk sign-in, not a bypass of this
    // gate. Unlocking first prevents the sign-in screen rendering behind a lock.
    setLocked(false);
    setReason(null);
    void signOut();
  }, [signOut]);

  const openSystemSettings = useCallback(() => {
    void Linking.openSettings().catch((error: unknown) => {
      console.error("Could not open the phone's settings", error);
    });
  }, []);

  if (!locked) {
    return <>{children}</>;
  }

  const type = (variant: Parameters<typeof getTypographyStyle>[0]) =>
    getTypographyStyle(variant, locale, fontsLoaded);

  return (
    <Screen padding="lg">
      <View style={[styles.shell, { direction: textDirection }]}>
        <Card style={styles.card}>
          <View style={styles.badge}>
            <Icon color="primary" name="biometric" size={28} />
          </View>

          <Text style={[styles.title, type("title")]}>{t("biometricLockTitle")}</Text>
          <Text style={[styles.body, type("body")]}>{t("biometricLockBody")}</Text>

          {reason ? (
            <Text accessibilityRole="alert" style={[styles.error, type("caption")]}>
              {t(biometricFailureStringKey(reason))}
            </Text>
          ) : null}

          {canRetryBiometrics(reason) ? (
            <Pressable
              accessibilityLabel={t("biometricLockUnlock")}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void attemptUnlock()}
              style={makeButtonStyle(styles.primaryButton, styles.pressed, styles.disabled, busy)}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={[styles.primaryLabel, type("label")]}>{t("biometricLockUnlock")}</Text>
              )}
            </Pressable>
          ) : null}

          {reason && shouldOfferSystemSettings(reason) ? (
            <Pressable
              accessibilityLabel={t("biometricOpenSettings")}
              accessibilityRole="button"
              onPress={openSystemSettings}
              style={makeButtonStyle(styles.secondaryButton, styles.pressed)}
            >
              <Text style={[styles.secondaryLabel, type("label")]}>{t("biometricOpenSettings")}</Text>
            </Pressable>
          ) : null}

          {/* The escape hatch. Always rendered, in every failure state — a
              changed fingerprint must never cost someone their account. */}
          <Pressable
            accessibilityLabel={t("biometricLockUsePassword")}
            accessibilityRole="button"
            onPress={usePasswordInstead}
            style={makeButtonStyle(styles.secondaryButton, styles.pressed)}
          >
            <Text style={[styles.secondaryLabel, type("label")]}>
              {t("biometricLockUsePassword")}
            </Text>
          </Pressable>
        </Card>
      </View>
    </Screen>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    shell: {
      flex: 1,
      justifyContent: "center",
    },
    card: {
      alignItems: "center",
      gap: theme.spacing.md,
      borderRadius: theme.radius.xl,
    },
    badge: {
      width: 64,
      height: 64,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.primarySoft,
    },
    title: {
      color: theme.colors.text,
      textAlign: "center",
    },
    body: {
      color: theme.colors.mutedText,
      textAlign: "center",
    },
    error: {
      color: theme.colors.danger,
      textAlign: "center",
    },
    primaryButton: {
      alignSelf: "stretch",
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primary,
    },
    primaryLabel: {
      color: "#ffffff",
    },
    secondaryButton: {
      alignSelf: "stretch",
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
    secondaryLabel: {
      color: theme.colors.primary,
    },
    disabled: {
      opacity: 0.6,
    },
    pressed: {
      opacity: 0.85,
    },
  });
