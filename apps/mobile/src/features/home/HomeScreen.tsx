import { nativeRoutes } from "@autoflow/shared";
import { UserButton } from "@clerk/expo/native";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

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
import { getTypographyStyle, theme } from "../../theme";
import {
  canOpenHomeWorkflowAction,
  filterWorkspaces,
  getHomeWorkflowActions,
  getPrimaryWorkspace,
  getSafeWorkspaces,
  getVisibleHomeWorkflowActions,
  workspaceInitials,
  type HomeWorkflowAction,
  type HomeWorkflowTarget,
} from "./homeCommandModel";

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
            <Icon color="onPrimary" name="notifications" size={20} />
            <Text style={[styles.heroStatValue, type.title]}>24/7</Text>
            <Text style={[styles.heroStatLabel, type.caption]}>{t("homeLiveOps")}</Text>
          </View>
          <View style={styles.heroStat}>
            <Icon color="onPrimary" name="sales" size={20} />
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
  onOpenCommand,
  onOpenDashboard,
}: {
  org: MobileOrgSummary;
  onOpenCommand: () => void;
  onOpenDashboard: () => void;
}) {
  const { t, textDirection } = useLocale();
  const type = useHomeTypography();
  const workspaceName = org.name || t("untitledWorkspace");
  const roleName = org.roleName || t("unknownRole");

  return (
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
      </View>
      <View style={styles.workspaceFooter}>
        <Button
          accessibilityLabel={`${t("openWorkspace")}: ${workspaceName}`}
          label={t("openWorkspace")}
          leadingIcon="dashboard"
          onPress={onOpenDashboard}
          style={styles.workspaceFooterButton}
          variant="secondary"
        />
        <Button
          accessibilityLabel={`${t("homeCommands")}: ${workspaceName}`}
          label={t("homeCommands")}
          leadingIcon="operations"
          onPress={onOpenCommand}
          style={styles.workspaceFooterButton}
          variant="ghost"
        />
      </View>
    </Card>
  );
}

function WorkflowActionCard({
  action,
  disabled,
  onPress,
}: {
  action: HomeWorkflowAction;
  disabled?: boolean;
  onPress: () => void;
}) {
  const isDark = action.tone === "dark";
  const type = useHomeTypography();

  return (
    <Pressable
      accessibilityLabel={action.title}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      android_ripple={{ color: theme.colors.border }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.workflowCard,
        action.tone === "dark" && styles.workflowCardDark,
        action.tone === "mint" && styles.workflowCardMint,
        action.tone === "amber" && styles.workflowCardAmber,
        action.tone === "blue" && styles.workflowCardBlue,
        disabled && styles.disabled,
        pressed && !disabled && styles.cardPressed,
      ]}
      onPress={onPress}
    >
      <View style={styles.workflowTopRow}>
        <View style={[styles.workflowIconShell, isDark && styles.workflowIconShellDark]}>
          <Icon color={isDark ? "onPrimary" : "primary"} name={action.icon} size={20} />
        </View>
        <Text style={[styles.workflowKicker, type.label, isDark && styles.workflowTextOnDark]}>
          {action.kicker}
        </Text>
      </View>
      <View style={styles.workflowCardBody}>
        <Text numberOfLines={2} style={[styles.workflowTitle, type.heading, isDark && styles.workflowTextOnDark]}>
          {action.title}
        </Text>
        <Text numberOfLines={2} style={[styles.workflowSubtitle, type.caption, isDark && styles.workflowSubtextOnDark]}>
          {action.subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function WorkspaceCommandSheet({
  onClose,
  onOpenWorkflow,
  onSelectOrg,
  orgs,
  selectedOrgId,
  visible,
}: {
  onClose: () => void;
  onOpenWorkflow: (target: HomeWorkflowTarget, org: MobileOrgSummary | null) => void;
  onSelectOrg: (orgId: string) => void;
  orgs: MobileOrgSummary[];
  selectedOrgId: string | null;
  visible: boolean;
}) {
  const { locale, t, textDirection } = useLocale();
  const type = useHomeTypography();
  const actions = useMemo(() => getHomeWorkflowActions(locale), [locale]);
  const selectedOrg = orgs.find((org) => org._id === selectedOrgId) ?? orgs[0] ?? null;
  const visibleActions = useMemo(
    () => getVisibleHomeWorkflowActions(actions, selectedOrg),
    [actions, selectedOrg],
  );

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("homeCommandSheetLabel")}
          style={styles.sheetDismissArea}
          onPress={onClose}
        />
        <View style={[styles.commandSheet, { direction: textDirection }]}>
          <View style={styles.sheetGrabber} />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderText}>
              <Text style={[styles.sheetTitle, type.title]}>{t("homeCommandSheetTitle")}</Text>
              <Text style={[styles.sheetBody, type.caption]}>{t("homeCommandSheetBody")}</Text>
            </View>
            <Button label={t("close")} onPress={onClose} style={styles.sheetCloseButton} variant="ghost" />
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.sheetBodyScroll}
            contentContainerStyle={styles.sheetBodyContent}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sheetOrgRail}>
              {orgs.map((org) => {
                const selected = org._id === selectedOrg?._id;
                return (
                  <Pressable
                    key={org._id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      styles.sheetOrgChip,
                      selected && styles.sheetOrgChipSelected,
                      pressed && styles.cardPressed,
                    ]}
                    onPress={() => onSelectOrg(org._id)}
                  >
                    <Text style={[styles.sheetOrgText, type.caption, selected && styles.sheetOrgTextSelected]}>
                      {org.name || t("untitledWorkspace")}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.sheetActionGrid}>
              {visibleActions.map((action) => (
                <WorkflowActionCard
                  key={action.target}
                  action={action}
                  disabled={!selectedOrg && action.target !== "marketplace"}
                  onPress={() => {
                    onOpenWorkflow(action.target, selectedOrg);
                    onClose();
                  }}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
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
  const { locale, t, textDirection } = useLocale();
  const router = useRouter();
  const type = useHomeTypography();
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [commandSheetOpen, setCommandSheetOpen] = useState(false);
  const [commandSheetOrgId, setCommandSheetOrgId] = useState<string | null>(null);
  const orgs = useQuery(api.organizations.listMine, {});
  const isSuperAdmin = useQuery(api.adminAuth.isSuperAdmin, {});
  const safeOrgs = useMemo(() => getSafeWorkspaces(orgs), [orgs]);
  const filteredOrgs = useMemo(() => filterWorkspaces(orgs, workspaceQuery), [orgs, workspaceQuery]);
  const workflowActions = useMemo(() => getHomeWorkflowActions(locale), [locale]);

  if (orgs === undefined || isSuperAdmin === undefined) {
    return <RouteLoadingState label={t("loadingWorkspace")} />;
  }

  const primaryOrg = getPrimaryWorkspace(filteredOrgs, safeOrgs);
  const canOpenWorkspace = Boolean(primaryOrg);
  const visibleWorkflowActions = getVisibleHomeWorkflowActions(workflowActions, primaryOrg);
  const openCommandSheet = (org: MobileOrgSummary | null = primaryOrg) => {
    setCommandSheetOrgId(org?._id ?? null);
    setCommandSheetOpen(true);
  };
  const openWorkflow = (target: HomeWorkflowTarget, org: MobileOrgSummary | null = primaryOrg) => {
    if (target === "marketplace") {
      router.push(nativeRoutes.marketplace);
      return;
    }

    if (!org) return;
    const action = workflowActions.find((item) => item.target === target);
    if (action && !canOpenHomeWorkflowAction(action, org)) return;

    if (target === "dashboard") {
      router.push({
        pathname: nativeRoutes.orgHome,
        params: { orgId: org._id },
      });
      return;
    }

    router.push({
      pathname: nativeRoutes.orgModule,
      params: { orgId: org._id, moduleId: target },
    });
  };

  return (
    <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.header, { direction: textDirection }]}>
          <View style={styles.headerText}>
            <Text style={[styles.brand, type.label]}>{t("appName")}</Text>
            <Text style={[styles.title, type.display]}>{t("homeWorkCenter")}</Text>
          </View>
          <View style={styles.headerActions}>
            <LocaleToggle />
            <UserButton />
          </View>
        </View>

        <Card style={[styles.cockpitPanel, { direction: textDirection }]}>
          <View style={styles.cockpitTopRow}>
            <View style={styles.cockpitText}>
              <Text style={[styles.cockpitEyebrow, type.label]}>{t("homeActiveWorkspace")}</Text>
              <Text numberOfLines={2} style={[styles.cockpitTitle, type.display]}>
                {primaryOrg?.name || t("homeChooseWorkspace")}
              </Text>
              <Text style={[styles.cockpitMeta, type.caption]}>
                {primaryOrg
                  ? `${t("roleLabel")}: ${primaryOrg.roleName || t("unknownRole")}`
                  : t("homeWorkspaceFallbackHint")}
              </Text>
            </View>
            <View style={styles.cockpitBadge}>
              <Icon color="onPrimary" name="branches" size={18} />
              <Text style={[styles.cockpitBadgeValue, type.title]}>{safeOrgs.length}</Text>
              <Text style={[styles.cockpitBadgeLabel, type.label]}>{t("homeSpacesCount")}</Text>
            </View>
          </View>

          <View style={styles.cockpitMetricRow}>
            <View style={styles.cockpitMetric}>
              <Text style={[styles.cockpitMetricValue, type.heading]}>{filteredOrgs.length}</Text>
              <Text style={[styles.cockpitMetricLabel, type.label]}>{t("homeMatchedCount")}</Text>
            </View>
            <View style={styles.cockpitMetric}>
              <Text style={[styles.cockpitMetricValue, type.heading]}>{visibleWorkflowActions.length}</Text>
              <Text style={[styles.cockpitMetricLabel, type.label]}>{t("homeWorkflowsCount")}</Text>
            </View>
            <View style={styles.cockpitMetric}>
              <Text style={[styles.cockpitMetricValue, type.heading]}>
                {isSuperAdmin ? "SA" : primaryOrg?.roleName?.slice(0, 2) || "--"}
              </Text>
              <Text style={[styles.cockpitMetricLabel, type.label]}>{t("homeAccessLabel")}</Text>
            </View>
          </View>

          <View style={styles.cockpitActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canOpenWorkspace }}
              disabled={!canOpenWorkspace}
              style={({ pressed }) => [
                styles.cockpitPrimaryButton,
                !canOpenWorkspace && styles.disabled,
                pressed && canOpenWorkspace && styles.cardPressed,
              ]}
              onPress={() => openWorkflow("dashboard")}
            >
              <Icon color="onPrimary" name="dashboard" size={18} />
              <Text style={[styles.cockpitPrimaryText, type.heading]}>
                {t("homeOpenDashboard")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.cockpitSecondaryButton, pressed && styles.cardPressed]}
              onPress={() => openCommandSheet(primaryOrg)}
            >
              <Icon color="onPrimary" name="operations" size={18} />
              <Text style={[styles.cockpitSecondaryText, type.heading]}>
                {t("homeAllCommands")}
              </Text>
            </Pressable>
          </View>
        </Card>

        <Card style={[styles.commandPanel, { direction: textDirection }]}>
          <View style={styles.commandHeader}>
            <View style={styles.commandHeaderText}>
              <Text style={[styles.commandTitle, type.title]}>{t("homeCommandSurfaceTitle")}</Text>
              <Text style={[styles.commandBody, type.caption]}>{t("homeCommandSurfaceBody")}</Text>
            </View>
            <View style={styles.commandStatus}>
              <Text style={[styles.commandStatusValue, type.title]}>{filteredOrgs.length}</Text>
              <Text style={[styles.commandStatusLabel, type.label]}>{t("homeResultsCount")}</Text>
            </View>
          </View>

          <View style={styles.searchShell}>
            <Icon color="primary" name="search" size={18} />
            <TextInput
              accessibilityLabel={t("homeSearchWorkspaces")}
              autoCorrect={false}
              onChangeText={setWorkspaceQuery}
              placeholder={t("homeSearchPlaceholder")}
              placeholderTextColor={theme.colors.subtleText}
              style={[styles.searchInput, type.body, { textAlign: locale === "ar" ? "right" : "left" }]}
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

          <View style={styles.workflowGrid}>
            {visibleWorkflowActions.slice(0, 4).map((action) => (
              <WorkflowActionCard
                key={action.target}
                action={action}
                disabled={!primaryOrg && action.target !== "marketplace"}
                onPress={() => openWorkflow(action.target)}
              />
            ))}
          </View>
        </Card>

        {isSuperAdmin ? (
          <Card style={[styles.adminPanel, { direction: textDirection }]}>
            <Text style={[styles.adminLabel, type.heading]}>{t("superAdminLabel")}</Text>
            <Text style={[styles.adminBody, type.body]}>{t("superAdminBody")}</Text>
          </Card>
        ) : null}

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

        <View style={[styles.sectionHeader, { direction: textDirection }]}>
          <View>
            <Text style={[styles.sectionKicker, type.label]}>{t("homeWorkspacesKicker")}</Text>
            <Text style={[styles.sectionTitle, type.title]}>{t("workspacesTitle")}</Text>
          </View>
          <Button
            label={t("homeChoose")}
            leadingIcon="operations"
            onPress={() => openCommandSheet(primaryOrg)}
            style={styles.sectionButton}
            variant="secondary"
          />
        </View>

        {filteredOrgs.length > 0 ? (
          <View style={styles.workspaceList}>
            {filteredOrgs.map((org) => (
              <WorkspaceCard
                key={org._id}
                org={org}
                onOpenCommand={() => {
                  openCommandSheet(org);
                }}
                onOpenDashboard={() => openWorkflow("dashboard", org)}
              />
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
      </ScrollView>
      <WorkspaceCommandSheet
        orgs={safeOrgs}
        selectedOrgId={commandSheetOrgId}
        visible={commandSheetOpen}
        onClose={() => setCommandSheetOpen(false)}
        onOpenWorkflow={openWorkflow}
        onSelectOrg={setCommandSheetOrgId}
      />
    </>
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

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
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
    fontWeight: "800",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  shellCaption: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
  },
  heroPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.lg,
    ...theme.shadows.lg,
  },
  heroEyebrow: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: theme.colors.onPrimary,
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 36,
  },
  heroBody: {
    color: theme.colors.surfaceAlt,
    fontSize: 15,
    lineHeight: 22,
  },
  title: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: "800",
    lineHeight: 36,
  },
  body: {
    color: theme.colors.mutedText,
    fontSize: 16,
    lineHeight: 23,
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
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    backgroundColor: theme.colors.primaryDark,
    padding: theme.spacing.md,
  },
  heroStatValue: {
    color: theme.colors.onPrimary,
    fontSize: 21,
    fontWeight: "900",
  },
  heroStatLabel: {
    color: theme.colors.surfaceAlt,
    fontSize: 12,
    fontWeight: "800",
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
    fontWeight: "800",
  },
  adminBody: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  cockpitPanel: {
    gap: theme.spacing.md,
    borderColor: theme.colors.hero,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.lg,
    ...theme.shadows.lg,
  },
  cockpitTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.md,
  },
  cockpitText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  cockpitEyebrow: {
    color: theme.colors.primarySoft,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  cockpitTitle: {
    color: theme.colors.onPrimary,
    fontSize: 27,
    fontWeight: "900",
    lineHeight: 33,
  },
  cockpitMeta: {
    color: theme.colors.surfaceAlt,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  cockpitBadge: {
    minWidth: 68,
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    backgroundColor: theme.colors.primaryDark,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  cockpitBadgeValue: {
    color: theme.colors.onPrimary,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 28,
  },
  cockpitBadgeLabel: {
    color: theme.colors.surfaceAlt,
    fontSize: 10,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  cockpitMetricRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  cockpitMetric: {
    flex: 1,
    minHeight: 62,
    justifyContent: "space-between",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    backgroundColor: theme.colors.primaryDark,
    padding: theme.spacing.sm,
  },
  cockpitMetricValue: {
    color: theme.colors.onPrimary,
    fontSize: 20,
    fontWeight: "900",
  },
  cockpitMetricLabel: {
    color: theme.colors.surfaceAlt,
    fontSize: 10,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  cockpitActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  cockpitPrimaryButton: {
    flex: 1.2,
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
  },
  cockpitPrimaryText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "900",
  },
  cockpitSecondaryButton: {
    flex: 1,
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    backgroundColor: theme.colors.primaryDark,
    paddingHorizontal: theme.spacing.md,
  },
  cockpitSecondaryText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "900",
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
    fontWeight: "900",
  },
  commandPanel: {
    gap: theme.spacing.md,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.radius.lg,
  },
  commandHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  commandHeaderText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  commandTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  commandBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  commandStatus: {
    minWidth: 62,
    alignItems: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  commandStatusValue: {
    color: theme.colors.primary,
    fontSize: 21,
    fontWeight: "900",
    lineHeight: 24,
  },
  commandStatusLabel: {
    color: theme.colors.mutedText,
    fontSize: 10,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  workflowGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  workflowCard: {
    width: "48.6%",
    minHeight: 126,
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  workflowCardDark: {
    borderColor: theme.colors.hero,
    backgroundColor: theme.colors.hero,
  },
  workflowCardMint: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  workflowCardAmber: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSoft,
  },
  workflowCardBlue: {
    borderColor: theme.colors.info,
    backgroundColor: theme.colors.infoSoft,
  },
  workflowTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  workflowIconShell: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
  },
  workflowIconShellDark: {
    backgroundColor: theme.colors.primaryDark,
  },
  workflowKicker: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  workflowCardBody: {
    gap: theme.spacing.xs,
  },
  workflowTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
    lineHeight: 20,
  },
  workflowSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  workflowTextOnDark: {
    color: theme.colors.onPrimary,
  },
  workflowSubtextOnDark: {
    color: theme.colors.surfaceAlt,
  },
  searchShell: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    minHeight: 46,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
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
    fontWeight: "900",
  },
  workspaceText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  workspaceName: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  workspaceMeta: {
    color: theme.colors.mutedText,
    fontSize: 14,
  },
  workspaceFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  workspaceFooterButton: {
    flex: 1,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  sectionKicker: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
  },
  sectionButton: {
    minHeight: 40,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: theme.colors.hero,
  },
  sheetDismissArea: {
    flex: 1,
  },
  commandSheet: {
    maxHeight: "86%",
    gap: theme.spacing.md,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
    ...theme.shadows.lg,
  },
  sheetGrabber: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.borderStrong,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  sheetHeaderText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  sheetTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
  },
  sheetBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  sheetCloseButton: {
    minHeight: 38,
  },
  sheetOrgRail: {
    gap: theme.spacing.sm,
  },
  sheetBodyScroll: {
    flexShrink: 1,
  },
  sheetBodyContent: {
    gap: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  sheetOrgChip: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  sheetOrgChipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  sheetOrgText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "900",
  },
  sheetOrgTextSelected: {
    color: theme.colors.primaryDark,
  },
  sheetActionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  cardPressed: {
    opacity: 0.82,
  },
  disabled: {
    opacity: 0.5,
  },
});
