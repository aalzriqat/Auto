import { nativeRoutes } from "@autoflow/shared";
import { ProfileButton } from "../../components/ProfileButton";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { api, type MobileOrgSummary } from "../../convexApi";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { LocaleToggle } from "../../components/LocaleToggle";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { getTypographyStyle, type AppTheme } from "../../theme";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { OTA_UPDATE_NUMBER } from "../../otaUpdateNumber";
import {
  filterWorkspaces,
  getSafeWorkspaces,
  workspaceInitials,
} from "./homeCommandModel";

const SEARCH_THRESHOLD = 5;

function useHomeTypography() {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();

  return useMemo(
    () => ({
      body: getTypographyStyle("body", locale, fontsLoaded),
      caption: getTypographyStyle("caption", locale, fontsLoaded),
      display: getTypographyStyle("display", locale, fontsLoaded),
      heading: getTypographyStyle("heading", locale, fontsLoaded),
      label: getTypographyStyle("label", locale, fontsLoaded),
      title: getTypographyStyle("title", locale, fontsLoaded),
    }),
    [fontsLoaded, locale],
  );
}

function SignedOutState() {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const router = useRouter();
  const type = useHomeTypography();

  return (
    <View style={[styles.signedOut, { direction: textDirection }]}>
      <View style={styles.signedOutTop}>
        <View>
          <Text style={[styles.brand, type.label]}>{t("appName")}</Text>
          <Text style={[styles.shellCaption, type.caption]}>{t("homeMobileTagline")}</Text>
        </View>
        <LocaleToggle />
      </View>

      <View style={styles.heroPanel}>
        <Text style={[styles.heroEyebrow, type.label]}>{t("homeProductionReady")}</Text>
        <Text style={[styles.heroTitle, type.display]}>{t("signedOutTitle")}</Text>
        <Text style={[styles.heroBody, type.body]}>{t("signedOutSubtitle")}</Text>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Icon color="primary" name="notifications" size={20} />
            <Text style={[styles.heroStatValue, type.title]}>24/7</Text>
            <Text style={[styles.heroStatLabel, type.caption]}>{t("homeLiveOps")}</Text>
          </View>
          <View style={styles.heroStat}>
            <Icon color="primary" name="sales" size={20} />
            <Text style={[styles.heroStatValue, type.title]}>CRM</Text>
            <Text style={[styles.heroStatLabel, type.caption]}>{t("homeSales")}</Text>
          </View>
        </View>
      </View>

      <View style={styles.authActions}>
        <Button
          label={t("signIn")}
          leadingIcon="settings"
          onPress={() => router.push(nativeRoutes.signIn)}
          style={styles.fullWidthButton}
        />
        <Button
          label={t("browseMarketplace")}
          leadingIcon="marketplace"
          onPress={() => router.push(nativeRoutes.marketplace)}
          style={styles.fullWidthButton}
          variant="secondary"
        />
      </View>
    </View>
  );
}

function WorkspaceCard({
  org,
  onOpen,
}: {
  org: MobileOrgSummary;
  onOpen: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const type = useHomeTypography();
  const workspaceName = org.name || t("untitledWorkspace");
  const roleName = org.roleName || t("unknownRole");

  return (
    <Pressable accessibilityRole="button" onPress={onOpen}>
      <Card style={[styles.workspaceCard, { direction: textDirection }]}>
        <View style={styles.workspaceCardTop}>
          <View style={styles.workspaceAvatar}>
            <Text style={[styles.workspaceAvatarText, type.label]}>{workspaceInitials(org.name)}</Text>
          </View>
          <View style={styles.workspaceText}>
            <Text numberOfLines={1} style={[styles.workspaceName, type.heading]}>
              {workspaceName}
            </Text>
            <Text style={[styles.workspaceMeta, type.caption]}>
              {t("roleLabel")}: {roleName}
            </Text>
          </View>
          <Badge label={roleName} tone="primary" />
          <Icon color="mutedText" name="chevronForward" size={20} />
        </View>
      </Card>
    </Pressable>
  );
}

function EmptyWorkspaceState() {
  const { t, textDirection } = useLocale();

  return (
    <View style={{ direction: textDirection }}>
      <EmptyState
        hint={t("noWorkspacesBody")}
        icon="branches"
        title={t("noWorkspacesTitle")}
      />
    </View>
  );
}

function AuthenticatedHome() {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const router = useRouter();
  const type = useHomeTypography();
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const orgs = useQuery(api.organizations.listMine, {});
  const isSuperAdmin = useQuery(api.adminAuth.isSuperAdmin, {});
  const safeOrgs = useMemo(() => getSafeWorkspaces(orgs), [orgs]);
  const filteredOrgs = useMemo(() => filterWorkspaces(orgs, workspaceQuery), [orgs, workspaceQuery]);

  const shouldAutoEnter = isSuperAdmin === false && safeOrgs.length === 1;
  const soleOrgId = shouldAutoEnter ? safeOrgs[0]!._id : null;

  useEffect(() => {
    if (!soleOrgId) return;
    router.replace({
      pathname: nativeRoutes.orgHome,
      params: { orgId: soleOrgId },
    });
  }, [router, soleOrgId]);

  function openWorkspace(org: MobileOrgSummary) {
    router.push({
      pathname: nativeRoutes.orgHome,
      params: { orgId: org._id },
    });
  }

  if (orgs === undefined || isSuperAdmin === undefined || shouldAutoEnter) {
    return <RouteLoadingState label={t("loadingWorkspace")} />;
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {__DEV__ ? (
        <View style={styles.devBuildBadge}>
          <Text style={styles.devBuildBadgeText}>{`OTA #${OTA_UPDATE_NUMBER} · dev`}</Text>
        </View>
      ) : null}
      <View style={[styles.header, { direction: textDirection }]}>
        <View style={styles.headerText}>
          <Text style={[styles.brand, type.label]}>{t("appName")}</Text>
          <Text style={[styles.title, type.display]}>{t("homeWorkCenter")}</Text>
        </View>
        <View style={styles.headerActions}>
          <ProfileButton />
        </View>
      </View>

      {isSuperAdmin ? (
        <Card style={[styles.adminPanel, { direction: textDirection }]}>
          <Text style={[styles.adminLabel, type.heading]}>{t("superAdminLabel")}</Text>
          <Text style={[styles.adminBody, type.body]}>{t("superAdminBody")}</Text>
        </Card>
      ) : null}

      {safeOrgs.length > SEARCH_THRESHOLD ? (
        <View style={styles.searchShell}>
          <Icon color="primary" name="search" size={18} />
          <TextInput
            accessibilityLabel={t("homeSearchWorkspaces")}
            autoCorrect={false}
            onChangeText={setWorkspaceQuery}
            placeholder={t("homeSearchPlaceholder")}
            placeholderTextColor={theme.colors.subtleText}
            style={[styles.searchInput, type.body, { textAlign: textDirection === "rtl" ? "right" : "left" }]}
            value={workspaceQuery}
          />
          {workspaceQuery ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("workspaceClearSearch")}
              style={({ pressed }) => [styles.clearSearch, pressed && styles.cardPressed]}
              onPress={() => setWorkspaceQuery("")}
            >
              <Icon color="text" name="close" size={18} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {filteredOrgs.length > 0 ? (
        <View style={styles.workspaceList}>
          {filteredOrgs.map((org) => (
            <WorkspaceCard key={org._id} org={org} onOpen={() => openWorkspace(org)} />
          ))}
        </View>
      ) : safeOrgs.length > 0 ? (
        <View style={{ direction: textDirection }}>
          <EmptyState
            hint={t("homeNoMatchingWorkspacesBody")}
            icon="search"
            title={t("homeNoMatchingWorkspacesTitle")}
          />
        </View>
      ) : (
        <EmptyWorkspaceState />
      )}

      <Card
        accessibilityLabel={t("browseMarketplace")}
        onPress={() => router.push(nativeRoutes.marketplace)}
        style={[styles.marketplaceLink, { direction: textDirection }]}
      >
        <View style={styles.marketplaceLinkText}>
          <Text style={[styles.marketplaceLinkTitle, type.heading]}>{t("browseMarketplace")}</Text>
          <Text style={[styles.workspaceMeta, type.caption]}>{t("marketplaceSubtitle")}</Text>
        </View>
        <Icon color="primary" name="chevronForward" size={22} />
      </Card>
    </ScrollView>
  );
}

export function HomeScreen() {
  const { t } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();

  if (!isLoaded) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingSession")} />
      </Screen>
    );
  }

  if (!isSignedIn) {
    return (
      <Screen>
        <SignedOutState />
      </Screen>
    );
  }

  if (convexAuthLoading) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingSession")} />
      </Screen>
    );
  }

  if (!isAuthenticated) {
    return (
      <Screen>
        <SignedOutState />
      </Screen>
    );
  }

  return (
    <Screen>
      <AuthenticatedHome />
    </Screen>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  devBuildBadge: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  devBuildBadgeText: {
    color: theme.colors.subtleText,
    fontSize: 11,
    fontWeight: "700",
  },
  signedOut: {
    flex: 1,
    justifyContent: "space-between",
    gap: theme.spacing.lg,
    padding: theme.spacing.xl,
  },
  signedOutTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  brand: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  shellCaption: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  heroPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.xl,
    ...theme.shadows.md,
  },
  heroEyebrow: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: theme.colors.text,
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 38,
  },
  heroBody: {
    color: theme.colors.mutedText,
    fontSize: 16,
    lineHeight: 23,
  },
  title: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: "600",
    lineHeight: 36,
  },
  heroStats: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  heroStat: {
    flex: 1,
    minHeight: 72,
    justifyContent: "space-between",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  heroStatValue: {
    color: theme.colors.text,
    fontSize: 21,
    fontWeight: "700",
  },
  heroStatLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  authActions: {
    gap: theme.spacing.md,
  },
  fullWidthButton: {
    width: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  headerText: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  adminPanel: {
    gap: theme.spacing.xs,
    borderColor: theme.colors.warning,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.warningSoft,
  },
  adminLabel: {
    color: theme.colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  adminBody: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  workspaceList: {
    gap: theme.spacing.md,
  },
  marketplaceLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
  },
  marketplaceLinkText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  marketplaceLinkTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  searchShell: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "400",
  },
  clearSearch: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  workspaceCard: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
  },
  workspaceCardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  workspaceAvatar: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
  },
  workspaceAvatarText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  workspaceText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  workspaceName: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  workspaceMeta: {
    color: theme.colors.mutedText,
    fontSize: 14,
  },
  cardPressed: {
    opacity: 0.82,
  },
});
