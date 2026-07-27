import { useConvexConnectionState } from "convex/react";
import { StyleSheet, Text, View } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";
import { Icon } from "./Icon";

/**
 * Slim "you're offline" bar shown app-wide whenever the Convex socket is down.
 *
 * Without it, losing connectivity is invisible: every `useQuery` simply stays
 * `undefined`, so screens sit on their loading skeletons forever with no
 * explanation and no hint that retrying would help. This is the only signal
 * that the data on screen is stale rather than still loading.
 *
 * Deliberately driven by Convex's own socket state rather than a NetInfo-style
 * native module: it needs no native code, so it ships over the air like any
 * other JS change, and it reports the connection the app actually depends on
 * (a device can hold a usable Wi-Fi link while the backend is unreachable).
 */
export function OfflineBanner() {
  const { isWebSocketConnected, hasEverConnected } = useConvexConnectionState();
  const { t, textDirection } = useLocale();
  const styles = useThemedStyles(makeStyles);

  // Stay quiet during the first connect. On a cold start the socket is briefly
  // down while it opens, and flashing "offline" at every launch would train
  // people to ignore the banner.
  if (isWebSocketConnected || !hasEverConnected) return null;

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.banner, { direction: textDirection }]}
    >
      <Icon color="onPrimary" name="refresh" size={14} />
      <Text style={styles.text}>{t("offlineBanner")}</Text>
    </View>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.danger,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
    },
    text: {
      color: theme.colors.onPrimary,
      fontSize: 13,
      fontWeight: "700",
    },
  });
