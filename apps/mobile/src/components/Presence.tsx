import type { MobileFoundationStringKey } from "@autoflow/shared";
import { StyleSheet, Text, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";

// Mirrors the web team page's getLastSeenInfo tiers exactly (app/(dashboard)/[orgId]/team/page.tsx) —
// lastSeenAt is throttled server-side to a write at most every few minutes, so "active now"
// lines up with that window rather than claiming second-by-second accuracy.
export function getPresenceInfo(
  t: (key: MobileFoundationStringKey) => string,
  lastSeenAt: number | undefined,
): { label: string; dotColor: string } {
  if (!lastSeenAt) {
    return { label: t("presenceOffline"), dotColor: theme.colors.subtleText };
  }
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000);
  if (minutes < 5) {
    return { label: t("presenceActiveNow"), dotColor: theme.colors.success };
  }
  if (minutes < 60) {
    return { label: t("presenceActiveMinutesAgo").replace("{0}", String(minutes)), dotColor: theme.colors.warning };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { label: t("presenceActiveHoursAgo").replace("{0}", String(hours)), dotColor: theme.colors.subtleText };
  }
  const days = Math.floor(hours / 24);
  return { label: t("presenceActiveDaysAgo").replace("{0}", String(days)), dotColor: theme.colors.subtleText };
}

export function PresenceDot({ lastSeenAt }: Readonly<{ lastSeenAt: number | undefined }>) {
  const { t } = useLocale();
  const presence = getPresenceInfo(t, lastSeenAt);

  return (
    <View
      accessibilityLabel={presence.label}
      style={[styles.presenceDot, { backgroundColor: presence.dotColor }]}
    />
  );
}

export function PresencePill({ lastSeenAt }: Readonly<{ lastSeenAt: number | undefined }>) {
  const { locale, t } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const presence = getPresenceInfo(t, lastSeenAt);

  return (
    <View style={styles.presencePill}>
      <View style={[styles.presenceDot, { backgroundColor: presence.dotColor }]} />
      <Text
        numberOfLines={1}
        style={[getTypographyStyle("caption", locale, fontsLoaded), styles.presencePillText]}
      >
        {presence.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  presenceDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
  },
  presencePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  presencePillText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "600",
  },
});
