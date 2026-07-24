import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { LocaleToggle } from "../../components/LocaleToggle";
import { Screen } from "../../components/Screen";
import { ThemeToggle } from "../../components/ThemeToggle";
import { OTA_UPDATE_NUMBER } from "../../otaUpdateNumber";
import { useLocale } from "../../providers/LocaleProvider";
import { useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { useOtaUpdate } from "../../updates/otaUpdateContext";

/**
 * Buyer-side Account tab. Buyers browse anonymously, so this leads with
 * preferences (theme/language) and keeps the dealer entry visually secondary —
 * most buyers never need it. Full buyer sign-in/sync arrives in a later phase;
 * for now the buyer section states that plainly rather than showing dead buttons.
 */
export function BuyerAccountScreen({ embedded = false }: Readonly<{ embedded?: boolean }> = {}) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const { isSignedIn } = useAuth();
  const { status, updateReady, checkForUpdate, applyUpdate } = useOtaUpdate();

  const updateStatusLabel =
    status === "checking"
      ? t("otaChecking")
      : updateReady
        ? t("otaReadyStatus")
        : status === "error"
          ? t("otaCheckFailed")
          : status === "upToDate"
            ? t("otaUpToDate")
            : null;

  const body = (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { direction: textDirection }]}>
        <View style={styles.headerText}>
          <Text style={styles.brand}>{t("appName")}</Text>
          <Text style={styles.title}>{t("account")}</Text>
        </View>

        <Card style={styles.card}>
          <Text style={styles.cardTitle}>{t("buyerAccountBuyerTitle")}</Text>
          <Text style={styles.cardBody}>{t("buyerAccountSyncHint")}</Text>
          <View style={styles.soonPill}>
            <Icon color="mutedText" name="notifications" size={14} />
            <Text style={styles.soonText}>{t("buyerAccountComingSoon")}</Text>
          </View>
        </Card>

        <Card style={styles.card}>
          <Text style={styles.cardTitle}>{t("buyerAccountPreferences")}</Text>
          <View style={styles.prefRow}>
            <Text style={styles.prefLabel}>{t("appearance")}</Text>
            <ThemeToggle />
          </View>
          <View style={styles.prefRow}>
            <Text style={styles.prefLabel}>{t("language")}</Text>
            <LocaleToggle />
          </View>
        </Card>

        <Card
          accessibilityLabel={isSignedIn ? t("buyerAccountOpenWorkspace") : t("buyerAccountDealerSignIn")}
          onPress={() =>
            router.push(isSignedIn ? nativeRoutes.dealerWorkspaces : nativeRoutes.signIn)
          }
          style={styles.dealerCard}
        >
          <View style={styles.dealerIcon}>
            <Icon color="primary" name="team" size={20} />
          </View>
          <View style={styles.dealerText}>
            <Text style={styles.dealerTitle}>
              {isSignedIn ? t("buyerAccountOpenWorkspace") : t("buyerAccountDealerQuestion")}
            </Text>
            <Text style={styles.dealerBody}>
              {isSignedIn ? t("buyerAccountOpenWorkspaceBody") : t("buyerAccountDealerSignIn")}
            </Text>
          </View>
          <Icon color="primary" name={textDirection === "rtl" ? "back" : "chevronForward"} size={20} />
        </Card>

        <Card style={styles.card}>
          <View style={styles.updateRow}>
            <View style={styles.updateTextWrap}>
              <Text style={styles.cardTitle}>{t("otaSectionTitle")}</Text>
              {updateStatusLabel ? (
                <Text style={styles.cardBody}>{updateStatusLabel}</Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={updateReady ? t("otaUpdateNow") : t("otaCheckForUpdates")}
              disabled={status === "checking"}
              style={({ pressed }) => [
                styles.updateButton,
                pressed && styles.pressed,
                status === "checking" && styles.updateButtonDisabled,
              ]}
              onPress={() => void (updateReady ? applyUpdate() : checkForUpdate())}
            >
              <Icon color="primary" name={updateReady ? "updateAvailable" : "refresh"} size={16} />
              <Text style={styles.updateButtonText}>
                {updateReady ? t("otaUpdateNow") : t("otaCheckForUpdates")}
              </Text>
            </Pressable>
          </View>
        </Card>

        <Text style={styles.buildText}>{`${t("appName")} · ${t("buildLabel")} ${OTA_UPDATE_NUMBER}`}</Text>
      </ScrollView>
  );

  return embedded ? body : <Screen>{body}</Screen>;
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
    },
    content: {
      gap: theme.spacing.lg,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    headerText: {
      gap: theme.spacing.xs,
    },
    brand: {
      color: theme.colors.primary,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    title: {
      color: theme.colors.text,
      fontSize: 30,
      fontWeight: "700",
      lineHeight: 36,
    },
    card: {
      gap: theme.spacing.md,
      borderRadius: theme.radius.lg,
    },
    cardTitle: {
      color: theme.colors.text,
      fontSize: 17,
      fontWeight: "700",
    },
    cardBody: {
      color: theme.colors.mutedText,
      fontSize: 14,
      lineHeight: 20,
    },
    soonPill: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surfaceAlt,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    soonText: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "700",
    },
    prefRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    prefLabel: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "600",
    },
    dealerCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      borderRadius: theme.radius.lg,
    },
    dealerIcon: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.primarySoft,
    },
    dealerText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    dealerTitle: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "700",
    },
    dealerBody: {
      color: theme.colors.mutedText,
      fontSize: 13,
      lineHeight: 18,
    },
    updateRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    updateTextWrap: {
      flex: 1,
      minWidth: 0,
      gap: theme.spacing.xs,
    },
    updateButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      minHeight: 40,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
    },
    updateButtonDisabled: {
      opacity: 0.6,
    },
    updateButtonText: {
      color: theme.colors.primary,
      fontSize: 13,
      fontWeight: "700",
    },
    pressed: {
      opacity: 0.82,
    },
    buildText: {
      alignSelf: "center",
      color: theme.colors.subtleText,
      fontSize: 12,
      fontWeight: "500",
    },
  });
