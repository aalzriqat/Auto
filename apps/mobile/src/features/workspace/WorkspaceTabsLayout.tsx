import { nativeRoutes, type NativeOrgTab } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { useConvexAuth, useQuery } from "convex/react";
import { Tabs, useRouter } from "expo-router";
import { createContext, useContext, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  api,
  type MobileMyMembership,
  type MobileOrgSummary,
} from "../../convexApi";
import { EmptyState } from "../../components/EmptyState";
import { FloatingMessengerFAB } from "../../components/FloatingMessengerFAB";
import { Icon, type SemanticIconName } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { getFontFamily, theme } from "../../theme";
import {
  countVisibleNativeModulesByCategory,
  type NativeModuleCategory,
} from "./nativeModules";

type WorkspaceTabsData = Readonly<{
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
  orgId: string;
}>;

type WorkspaceTabConfig = Readonly<{
  category?: NativeModuleCategory;
  icon: SemanticIconName;
  labelKey:
    | "workspaceTabHome"
    | "workspaceTabOperations"
    | "workspaceTabPipeline"
    | "workspaceTabFinance"
    | "workspaceTabAdmin";
  name: NativeOrgTab;
}>;

const workspaceTabConfigs: ReadonlyArray<WorkspaceTabConfig> = [
  { name: "home", icon: "today", labelKey: "workspaceTabHome" },
  { name: "operations", category: "operations", icon: "vehicles", labelKey: "workspaceTabOperations" },
  { name: "pipeline", category: "pipeline", icon: "sales", labelKey: "workspaceTabPipeline" },
  { name: "finance", icon: "inbox", labelKey: "workspaceTabFinance" },
  { name: "admin", icon: "more", labelKey: "workspaceTabAdmin" },
];

const WorkspaceTabsDataContext = createContext<WorkspaceTabsData | null>(null);

function getSafeOrgs(orgs: Array<MobileOrgSummary | null> | undefined): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

function canShowTab(
  tab: WorkspaceTabConfig,
  permissions: readonly string[],
  roleName?: string,
): boolean {
  if (!tab.category) {
    return true;
  }

  return countVisibleNativeModulesByCategory(tab.category, permissions, roleName) > 0;
}

export function useWorkspaceTabsData(): WorkspaceTabsData {
  const context = useContext(WorkspaceTabsDataContext);
  if (!context) {
    throw new Error("useWorkspaceTabsData must be used within WorkspaceTabsLayout");
  }

  return context;
}

export function WorkspaceTabsLayout({ orgId }: Readonly<{ orgId: string | null }>) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fontsLoaded } = useAppFontState();
  const { isRtl, locale, t } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const canQuery = isLoaded && isSignedIn && !convexAuthLoading && isAuthenticated && Boolean(orgId);
  const orgs = useQuery(api.organizations.listMine, canQuery ? {} : "skip");
  const safeOrgs = useMemo(() => getSafeOrgs(orgs), [orgs]);
  const selectedOrg = safeOrgs.find((org) => org._id === orgId) ?? null;
  const myMembership = useQuery(
    api.memberships.getMyMembership,
    selectedOrg ? { orgId: selectedOrg._id } : "skip",
  );

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

  if (!orgId || !isLoaded || convexAuthLoading || !isSignedIn || !isAuthenticated) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingSession")} />
      </Screen>
    );
  }

  if (orgs === undefined || myMembership === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingWorkspace")} />
      </Screen>
    );
  }

  if (!selectedOrg) {
    return (
      <Screen>
        <EmptyState
          actionLabel={t("back")}
          hint={t("inaccessibleWorkspaceBody")}
          icon="settings"
          onAction={() => router.replace(nativeRoutes.home)}
          title={t("inaccessibleWorkspaceTitle")}
        />
      </Screen>
    );
  }

  const orderedTabs = isRtl ? [...workspaceTabConfigs].reverse() : workspaceTabConfigs;
  const value: WorkspaceTabsData = {
    myMembership,
    org: selectedOrg,
    orgId: selectedOrg._id,
  };
  const tabBarHeight = 64 + Math.max(insets.bottom, theme.spacing.sm);

  return (
    <WorkspaceTabsDataContext.Provider value={value}>
      <View style={styles.root}>
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: theme.colors.primary,
            tabBarInactiveTintColor: theme.colors.mutedText,
            tabBarLabelStyle: {
              fontFamily: getFontFamily(locale, "medium", fontsLoaded),
              fontSize: 11,
              fontWeight: "700",
              lineHeight: 14,
            },
            tabBarStyle: [
              styles.tabBar,
              {
                height: tabBarHeight,
                paddingBottom: Math.max(insets.bottom, theme.spacing.sm),
              },
            ],
          }}
        >
          {orderedTabs.map((tab) => {
            const label = t(tab.labelKey);
            const visible = canShowTab(tab, myMembership.permissions, myMembership.roleName);

            return (
              <Tabs.Screen
                key={tab.name}
                name={tab.name}
                options={{
                  href: visible ? undefined : null,
                  tabBarAccessibilityLabel: label,
                  tabBarIcon: ({ focused }) => (
                    <Icon color={focused ? "primary" : "mutedText"} name={tab.icon} size={22} />
                  ),
                  tabBarLabel: label,
                  title: label,
                }}
              />
            );
          })}
        </Tabs>
        <FloatingMessengerFAB bottomOffset={tabBarHeight + theme.spacing.md} orgId={selectedOrg._id} />
      </View>
    </WorkspaceTabsDataContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  tabBar: {
    borderTopColor: theme.colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.surface,
    paddingTop: theme.spacing.sm,
    ...theme.shadows.sm,
  },
});
