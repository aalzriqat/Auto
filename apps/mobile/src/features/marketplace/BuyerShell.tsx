import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type SemanticIconName } from "../../components/Icon";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useStatusBarStyle, useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { BuyerAccountScreen } from "../account/BuyerAccountScreen";
import { BuyerSavedScreen } from "../account/BuyerSavedScreen";
import { MarketplaceScreen } from "./MarketplaceScreen";

export type BuyerShellTab = "browse" | "request" | "saved" | "account";

type BuyerShellTabConfig = Readonly<{
  value: BuyerShellTab;
  icon: SemanticIconName;
  labelKey: "buyerTabBrowse" | "buyerTabRequest" | "buyerTabSaved" | "buyerTabAccount";
}>;

export const BUYER_SHELL_TABS: readonly BuyerShellTabConfig[] = [
  { value: "browse", icon: "search", labelKey: "buyerTabBrowse" },
  { value: "request", icon: "marketplace", labelKey: "buyerTabRequest" },
  { value: "saved", icon: "save", labelKey: "buyerTabSaved" },
  { value: "account", icon: "team", labelKey: "buyerTabAccount" },
];

/**
 * The buyer app shell: a consumer-style bottom tab bar over the marketplace.
 * Implemented as an in-screen shell (not an Expo Router Tabs group) so the
 * navigation graph is unchanged — "/" still renders one screen. Browse hands off
 * a dealer trade-in to the Request tab in-component (no router round-trip).
 */
export function BuyerShell() {
  const [active, setActive] = useState<BuyerShellTab>("browse");
  const styles = useThemedStyles(makeStyles);
  const theme = useAppTheme();
  const statusBarStyle = useStatusBarStyle();
  const { t, textDirection } = useLocale();
  const insets = useSafeAreaInsets();

  let content;
  if (active === "browse") {
    content = <MarketplaceScreen variant="browse" embedded onRequestTradeIn={() => setActive("request")} />;
  } else if (active === "request") {
    content = <MarketplaceScreen variant="request" embedded />;
  } else if (active === "saved") {
    content = <BuyerSavedScreen embedded />;
  } else {
    content = <BuyerAccountScreen embedded />;
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      <StatusBar style={statusBarStyle} />
      <View style={styles.content}>{content}</View>
      <View
        style={[
          styles.tabBar,
          { paddingBottom: Math.max(insets.bottom, theme.spacing.sm), direction: textDirection },
        ]}
      >
        {BUYER_SHELL_TABS.map((tab) => {
          const selected = tab.value === active;
          return (
            <Pressable
              key={tab.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={t(tab.labelKey)}
              style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
              onPress={() => setActive(tab.value)}
            >
              <Icon color={selected ? "primary" : "mutedText"} name={tab.icon} size={22} />
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{t(tab.labelKey)}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
    },
    tabBar: {
      flexDirection: "row",
      borderTopColor: theme.colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.surface,
      paddingTop: theme.spacing.sm,
      ...theme.shadows.sm,
    },
    tabItem: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      paddingVertical: theme.spacing.xs,
    },
    tabLabel: {
      color: theme.colors.mutedText,
      fontSize: 11,
      fontWeight: "700",
    },
    tabLabelActive: {
      color: theme.colors.primary,
    },
    pressed: {
      opacity: 0.7,
    },
  });
