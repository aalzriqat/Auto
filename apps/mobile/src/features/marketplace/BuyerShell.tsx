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
import { FinancingScreen } from "../financing/FinancingScreen";
import { MarketplaceHomeScreen } from "./MarketplaceHomeScreen";
import { MarketplaceScreen } from "./MarketplaceScreen";

export type BuyerShellTab = "home" | "cars" | "favorites" | "financing" | "account";

type BuyerShellTabConfig = Readonly<{
  value: BuyerShellTab;
  icon: SemanticIconName;
  labelKey: "buyerTabHome" | "buyerTabCars" | "buyerTabFavorites" | "buyerTabFinancing" | "buyerTabAccount";
}>;

// RTL nav renders the first item on the right, matching the storefront mockup:
// الرئيسية · السيارات · المفضلة · تمويل · حسابي.
export const BUYER_SHELL_TABS: readonly BuyerShellTabConfig[] = [
  { value: "home", icon: "home", labelKey: "buyerTabHome" },
  { value: "cars", icon: "vehicles", labelKey: "buyerTabCars" },
  { value: "favorites", icon: "heart", labelKey: "buyerTabFavorites" },
  { value: "financing", icon: "finance", labelKey: "buyerTabFinancing" },
  { value: "account", icon: "person", labelKey: "buyerTabAccount" },
];

/**
 * The buyer app shell: a consumer-style bottom tab bar over the marketplace.
 * Implemented as an in-screen shell (not an Expo Router Tabs group) so the
 * navigation graph is unchanged — "/" still renders one screen.
 *
 * Home is the storefront landing; its search, brand chips, and "view all" hand
 * off to the Cars tab (pre-filtered by make), and its quick actions / request
 * banner hand off to Financing, Favorites, and the reverse-market Request flow.
 * Request has no bottom tab (it's reached from the Home banner and the Cars
 * hero), so it renders as an in-shell takeover with a back affordance.
 */
export function BuyerShell() {
  const [active, setActive] = useState<BuyerShellTab>("home");
  const [carsMake, setCarsMake] = useState<string | undefined>(undefined);
  const [requestOpen, setRequestOpen] = useState(false);
  const styles = useThemedStyles(makeStyles);
  const theme = useAppTheme();
  const statusBarStyle = useStatusBarStyle();
  const { t, textDirection } = useLocale();
  const insets = useSafeAreaInsets();

  const goToTab = (tab: BuyerShellTab) => {
    setRequestOpen(false);
    setActive(tab);
  };

  const openCars = (make?: string) => {
    setCarsMake(make);
    setRequestOpen(false);
    setActive("cars");
  };

  const openRequest = () => setRequestOpen(true);

  let content;
  if (requestOpen) {
    content = (
      <View style={styles.overlay}>
        <View style={[styles.overlayBar, { direction: textDirection }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("back")}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            onPress={() => setRequestOpen(false)}
          >
            <Icon color="text" name="back" size={20} />
          </Pressable>
        </View>
        <View style={styles.overlayContent}>
          <MarketplaceScreen variant="request" embedded />
        </View>
      </View>
    );
  } else if (active === "home") {
    content = (
      <MarketplaceHomeScreen
        onOpenCars={openCars}
        onOpenFavorites={() => setActive("favorites")}
        onOpenFinancing={() => setActive("financing")}
        onOpenCompare={() => setActive("favorites")}
        onOpenRequest={openRequest}
      />
    );
  } else if (active === "cars") {
    content = (
      <MarketplaceScreen
        key={carsMake ?? "all"}
        variant="browse"
        embedded
        initialMake={carsMake}
        onRequestTradeIn={openRequest}
        onOpenRequest={openRequest}
      />
    );
  } else if (active === "favorites") {
    content = <BuyerSavedScreen embedded />;
  } else if (active === "financing") {
    content = <FinancingScreen embedded />;
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
          const selected = tab.value === active && !requestOpen;
          return (
            <Pressable
              key={tab.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={t(tab.labelKey)}
              style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
              onPress={() => goToTab(tab.value)}
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
    overlay: {
      flex: 1,
    },
    overlayBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    backButton: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceAlt,
    },
    overlayContent: {
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
