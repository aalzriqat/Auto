import { useAuth, useUser } from "@clerk/expo";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { OTA_UPDATE_NUMBER } from "../otaUpdateNumber";
import { useLocale } from "../providers/LocaleProvider";
import { useThemeMode, useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";
import { MemberAvatar } from "./Avatar";
import { Icon, type SemanticIconName } from "./Icon";

/**
 * Pure view model for the account header — kept separate so the name/email
 * fallback branches are unit-testable without a Clerk provider.
 */
export function resolveAccountIdentity(
  fullName: string | undefined,
  email: string,
  accountFallback: string,
): { name: string; email: string | null } {
  const name = fullName?.trim() || email || accountFallback;
  const showEmail = Boolean(email) && email !== name;
  return { name, email: showEmail ? email : null };
}

export function getProfilePressedStyle(pressed: boolean) {
  return pressed ? { opacity: 0.82 } : null;
}

function OptionButton({
  active,
  icon,
  label,
  onPress,
}: Readonly<{
  active: boolean;
  icon: SemanticIconName;
  label: string;
  onPress: () => void;
}>) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.option, active && styles.optionActive, getProfilePressedStyle(pressed)]}
      onPress={onPress}
    >
      <Icon color={active ? "primary" : "mutedText"} name={icon} size={18} />
      <Text style={[styles.optionText, active && styles.optionTextActive]}>{label}</Text>
      {active ? <Icon color="primary" name="check" size={16} /> : null}
    </Pressable>
  );
}

/**
 * Account control for the app headers. Replaces Clerk's native <UserButton>,
 * whose native prebuilt view renders as a blank/zero-size element on this app
 * (the same broken native Clerk UI that made us swap the native sign-in for a
 * custom form) — which left users with no way to sign out.
 *
 * Tapping the avatar opens an account sheet that also hosts the occasional
 * preferences — theme and language — so they no longer clutter the header
 * chrome, plus a subtle build number (replaces the loud on-screen OTA banner)
 * and Sign out.
 */
export function ProfileButton() {
  const { isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const { t, locale, setLocale, textDirection } = useLocale();
  const { mode, setMode } = useThemeMode();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  if (!isSignedIn) return null;

  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const identity = resolveAccountIdentity(user?.fullName ?? undefined, email, t("account"));
  const closeSheet = () => setOpen(false);
  const handleSignOut = () => {
    closeSheet();
    void signOut();
  };

  return (
    <>
      <Pressable
        accessibilityLabel={t("account")}
        accessibilityRole="button"
        hitSlop={6}
        style={({ pressed }) => getProfilePressedStyle(pressed)}
        testID="account-avatar-button"
        onPress={() => setOpen(true)}
      >
        <MemberAvatar imageUrl={user?.imageUrl} name={identity.name} size={40} />
      </Pressable>

      <Modal animationType="slide" presentationStyle="pageSheet" visible={open} onRequestClose={closeSheet}>
        <View style={[styles.sheet, { direction: textDirection }]}>
          <View style={styles.sheetHeader}>
            <MemberAvatar imageUrl={user?.imageUrl} name={identity.name} size={48} />
            <View style={styles.sheetHeaderText}>
              <Text numberOfLines={1} style={styles.sheetName}>
                {identity.name}
              </Text>
              {identity.email ? (
                <Text numberOfLines={1} style={styles.sheetEmail}>
                  {identity.email}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityLabel={t("close")}
              accessibilityRole="button"
              style={({ pressed }) => [styles.closeButton, getProfilePressedStyle(pressed)]}
              onPress={closeSheet}
            >
              <Icon color="text" name="close" size={20} />
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>{t("appearance")}</Text>
          <View style={styles.segment}>
            <OptionButton active={mode === "light"} icon="themeLight" label={t("themeLight")} onPress={() => setMode("light")} />
            <OptionButton active={mode === "dark"} icon="themeDark" label={t("themeDark")} onPress={() => setMode("dark")} />
          </View>

          <Text style={styles.sectionLabel}>{t("language")}</Text>
          <View style={styles.segment}>
            <OptionButton active={locale === "en"} icon="language" label="English" onPress={() => void setLocale("en")} />
            <OptionButton active={locale === "ar"} icon="language" label="العربية" onPress={() => void setLocale("ar")} />
          </View>

          <View style={styles.sheetFooter}>
            <Pressable
              accessibilityLabel={t("signOut")}
              accessibilityRole="button"
              style={({ pressed }) => [styles.signOutButton, getProfilePressedStyle(pressed)]}
              onPress={handleSignOut}
            >
              <Text style={styles.signOutText}>{t("signOut")}</Text>
            </Pressable>
            <Text style={styles.buildText}>{`${t("appName")} · ${t("buildLabel")} ${OTA_UPDATE_NUMBER}`}</Text>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    sheet: {
      flex: 1,
      gap: theme.spacing.md,
      backgroundColor: theme.colors.background,
      padding: theme.spacing.lg,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      paddingBottom: theme.spacing.sm,
    },
    sheetHeaderText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    sheetName: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "700",
    },
    sheetEmail: {
      color: theme.colors.mutedText,
      fontSize: 13,
    },
    closeButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceAlt,
    },
    sectionLabel: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 0,
      textTransform: "uppercase",
    },
    segment: {
      flexDirection: "row",
      gap: theme.spacing.sm,
    },
    option: {
      flex: 1,
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.sm,
    },
    optionActive: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primarySoft,
    },
    optionText: {
      color: theme.colors.mutedText,
      fontSize: 14,
      fontWeight: "600",
    },
    optionTextActive: {
      color: theme.colors.text,
    },
    sheetFooter: {
      marginTop: "auto",
      gap: theme.spacing.md,
      alignItems: "center",
    },
    signOutButton: {
      width: "100%",
      minHeight: 50,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.danger,
      backgroundColor: theme.colors.dangerSoft,
    },
    signOutText: {
      color: theme.colors.danger,
      fontSize: 16,
      fontWeight: "700",
    },
    buildText: {
      color: theme.colors.subtleText,
      fontSize: 12,
      fontWeight: "500",
    },
  });
