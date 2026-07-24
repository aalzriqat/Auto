import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/Icon";
import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";
import { useOtaUpdate } from "./otaUpdateContext";

/**
 * In-app "Update available" popup. Shown when a newer JS bundle has already been
 * downloaded and is waiting to be applied. A themed, RTL-aware modal (not the OS
 * Alert) so it matches the app. "Update now" reloads into the new bundle;
 * "Later" dismisses it for this session — the update still applies on the next
 * cold start, so nothing is lost.
 */
export function OtaUpdatePrompt() {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const { promptVisible, applyUpdate, dismissPrompt } = useOtaUpdate();

  return (
    <Modal
      visible={promptVisible}
      transparent
      animationType="fade"
      onRequestClose={dismissPrompt}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { direction: textDirection }]}>
          <View style={styles.iconWrap}>
            <Icon color="primary" name="updateAvailable" size={30} />
          </View>
          <Text style={styles.title}>{t("otaUpdateTitle")}</Text>
          <Text style={styles.body}>{t("otaUpdateBody")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("otaUpdateNow")}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={() => void applyUpdate()}
          >
            <Text style={styles.primaryButtonText}>{t("otaUpdateNow")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("otaUpdateLater")}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            onPress={dismissPrompt}
          >
            <Text style={styles.secondaryButtonText}>{t("otaUpdateLater")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(15, 23, 42, 0.55)",
      padding: theme.spacing.xl,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      alignItems: "center",
      gap: theme.spacing.md,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing.xl,
      ...theme.shadows.md,
    },
    iconWrap: {
      width: 56,
      height: 56,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primarySoft,
    },
    title: {
      color: theme.colors.text,
      fontSize: 20,
      fontWeight: "800",
      textAlign: "center",
    },
    body: {
      color: theme.colors.mutedText,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center",
    },
    primaryButton: {
      width: "100%",
      minHeight: 50,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.lg,
    },
    primaryButtonText: {
      color: theme.colors.onPrimary,
      fontSize: 16,
      fontWeight: "800",
    },
    secondaryButton: {
      width: "100%",
      minHeight: 46,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.lg,
    },
    secondaryButtonText: {
      color: theme.colors.mutedText,
      fontSize: 15,
      fontWeight: "700",
    },
    pressed: {
      opacity: 0.82,
    },
  });
