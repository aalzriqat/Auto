import { useAuth } from "@clerk/expo";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { makeButtonStyle } from "../components/pressableStyle";
import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";
import { biometricFailureStringKey } from "./biometricCopy";
import {
  armBiometricUnlock,
  disarmBiometricUnlock,
  getBiometricAvailability,
  isBiometricUnlockArmed,
  type BiometricFailure,
} from "./biometricUnlock";

/**
 * Opt-in / opt-out for biometric unlock, for the account screen.
 *
 * Hidden entirely when signed out — there is no session to gate — and hidden
 * when the phone cannot back the gate, because a switch that always fails is
 * worse than no switch. When it is hidden for a fixable reason (nothing
 * enrolled) the reason is still shown, so the user knows what to change rather
 * than wondering where the setting went.
 *
 * Turning it off clears the keystore-bound marker as well as the preference; see
 * `disarmBiometricUnlock`.
 */
export function BiometricUnlockToggle() {
  const { isSignedIn } = useAuth();
  const { locale, t } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const styles = useThemedStyles(makeStyles);

  const [armed, setArmed] = useState(false);
  const [blocked, setBlocked] = useState<BiometricFailure | null>(null);
  const [error, setError] = useState<BiometricFailure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void isBiometricUnlockArmed().then(setArmed);
    void getBiometricAvailability().then((availability) => {
      setBlocked(availability.available ? null : availability.reason);
    });
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      if (armed) {
        await disarmBiometricUnlock();
        setArmed(false);
        return;
      }

      const result = await armBiometricUnlock({
        prompts: {
          face: t("biometricPromptFace"),
          fingerprint: t("biometricPromptFingerprint"),
        },
        cancelLabel: t("biometricPromptCancel"),
        fallbackLabel: t("biometricPromptFallback"),
      });

      if (result.ok) {
        setArmed(true);
        return;
      }

      setError(result.reason);
    } finally {
      setBusy(false);
    }
  }, [armed, t]);

  // Someone who already armed the gate always keeps their off switch, even if
  // the phone has since stopped being able to satisfy it — otherwise opting out
  // would be impossible exactly when they most want to.
  const unavailable = armed ? null : blocked;

  // Nothing actionable to say on a phone with no sensor, or on a binary that
  // predates the native module: hide the card rather than nag.
  if (!isSignedIn || unavailable === "noHardware" || unavailable === "unsupported") {
    return null;
  }

  const type = (variant: Parameters<typeof getTypographyStyle>[0]) =>
    getTypographyStyle(variant, locale, fontsLoaded);

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={[styles.title, type("label")]}>{t("biometricSettingTitle")}</Text>
          <Text style={[styles.body, type("caption")]}>{t("biometricSettingBody")}</Text>
        </View>
        {armed ? <Text style={[styles.state, type("caption")]}>{t("biometricSettingOn")}</Text> : null}
      </View>

      {unavailable ? (
        <Text style={[styles.error, type("caption")]}>
          {t(biometricFailureStringKey(unavailable))}
        </Text>
      ) : (
        <Pressable
          accessibilityLabel={armed ? t("biometricSettingDisable") : t("biometricSettingEnable")}
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void toggle()}
          style={makeButtonStyle(styles.button, styles.pressed, styles.disabled, busy)}
        >
          {busy ? (
            <ActivityIndicator color={styles.buttonLabel.color} />
          ) : (
            <>
              <Icon color="primary" name="biometric" size={16} />
              <Text style={[styles.buttonLabel, type("label")]}>
                {armed ? t("biometricSettingDisable") : t("biometricSettingEnable")}
              </Text>
            </>
          )}
        </Pressable>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, type("caption")]}>
          {t(biometricFailureStringKey(error))}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    card: {
      gap: theme.spacing.md,
      borderRadius: theme.radius.lg,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    text: {
      flex: 1,
      minWidth: 0,
      gap: theme.spacing.xs,
    },
    title: {
      color: theme.colors.text,
    },
    body: {
      color: theme.colors.mutedText,
    },
    state: {
      color: theme.colors.primary,
      fontWeight: "700",
    },
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      minHeight: 44,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
    },
    buttonLabel: {
      color: theme.colors.primary,
    },
    error: {
      color: theme.colors.danger,
    },
    disabled: {
      opacity: 0.6,
    },
    pressed: {
      opacity: 0.85,
    },
  });
