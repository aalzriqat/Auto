import { nativeRoutes } from "@autoflow/shared";
import { UserButton } from "@clerk/expo/native";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { api, type MobileOrgSummary } from "../../convexApi";
import { LocaleToggle } from "../../components/LocaleToggle";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  filterWorkspaces,
  getHomeWorkflowActions,
  getPrimaryWorkspace,
  getSafeWorkspaces,
  workspaceInitials,
  type HomeWorkflowAction,
  type HomeWorkflowTarget,
} from "./homeCommandModel";

function SignedOutState() {
  const { locale, t, textDirection } = useLocale();
  const router = useRouter();

  return (
    <View style={[styles.signedOut, { direction: textDirection }]}>
      <View style={styles.signedOutTop}>
        <View>
          <Text style={styles.brand}>{t("appName")}</Text>
          <Text style={styles.shellCaption}>
            {locale === "ar" ? "إدارة المعرض من الهاتف" : "Dealer OS on mobile"}
          </Text>
        </View>
        <LocaleToggle />
      </View>

      <View style={styles.heroPanel}>
        <Text style={styles.heroEyebrow}>
          {locale === "ar" ? "جاهز للعمل" : "Production ready"}
        </Text>
        <Text style={styles.heroTitle}>{t("signedOutTitle")}</Text>
        <Text style={styles.heroBody}>{t("signedOutSubtitle")}</Text>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>24/7</Text>
            <Text style={styles.heroStatLabel}>
              {locale === "ar" ? "متابعة" : "Live ops"}
            </Text>
          </View>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>CRM</Text>
            <Text style={styles.heroStatLabel}>
              {locale === "ar" ? "مبيعات" : "Sales"}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.authActions}>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          onPress={() => router.push(nativeRoutes.signIn)}
        >
          <Text style={styles.primaryButtonText}>{t("signIn")}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          onPress={() => router.push(nativeRoutes.marketplace)}
        >
          <Text style={styles.secondaryButtonText}>{t("browseMarketplace")}</Text>
        </Pressable>
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
  const { locale, t, textDirection } = useLocale();

  return (
    <View style={[styles.workspaceCard, { direction: textDirection }]}>
      <View style={styles.workspaceCardTop}>
        <View style={styles.workspaceAvatar}>
          <Text style={styles.workspaceAvatarText}>{workspaceInitials(org.name)}</Text>
        </View>
        <View style={styles.workspaceText}>
          <Text numberOfLines={1} style={styles.workspaceName}>
            {org.name || "Untitled workspace"}
          </Text>
          <Text style={styles.workspaceMeta}>
            {t("roleLabel")}: {org.roleName || "UNKNOWN"}
          </Text>
        </View>
        <Text style={styles.rolePill}>{org.roleName || "UNKNOWN"}</Text>
      </View>
      <View style={styles.workspaceFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("openWorkspace")}: ${org.name || "Untitled workspace"}`}
          style={({ pressed }) => [styles.workspaceFooterButton, pressed && styles.cardPressed]}
          onPress={onOpenDashboard}
        >
          <Text style={styles.workspaceAction}>{t("openWorkspace")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.workspaceFooterButton,
            styles.workspaceFooterButtonAccent,
            pressed && styles.cardPressed,
          ]}
          onPress={onOpenCommand}
        >
          <Text style={styles.workspaceActionAccent}>
            {locale === "ar" ? "الأوامر" : "Commands"}
          </Text>
        </Pressable>
      </View>
    </View>
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
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
      <Text style={[styles.workflowKicker, isDark && styles.workflowTextOnDark]}>
        {action.kicker}
      </Text>
      <View style={styles.workflowCardBody}>
        <Text numberOfLines={2} style={[styles.workflowTitle, isDark && styles.workflowTextOnDark]}>
          {action.title}
        </Text>
        <Text numberOfLines={2} style={[styles.workflowSubtitle, isDark && styles.workflowSubtextOnDark]}>
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
  const { locale, textDirection } = useLocale();
  const actions = useMemo(() => getHomeWorkflowActions(locale), [locale]);
  const selectedOrg = orgs.find((org) => org._id === selectedOrgId) ?? orgs[0] ?? null;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable accessibilityRole="button" style={styles.sheetDismissArea} onPress={onClose} />
        <View style={[styles.commandSheet, { direction: textDirection }]}>
          <View style={styles.sheetGrabber} />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderText}>
              <Text style={styles.sheetTitle}>
                {locale === "ar" ? "اختيار مساحة العمل" : "Workspace command deck"}
              </Text>
              <Text style={styles.sheetBody}>
                {locale === "ar"
                  ? "اختر معرضاً ثم افتح الإجراء المطلوب مباشرة."
                  : "Pick a showroom, then jump straight into the workflow you need."}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.sheetCloseButton, pressed && styles.cardPressed]}
              onPress={onClose}
            >
              <Text style={styles.sheetCloseText}>{locale === "ar" ? "إغلاق" : "Close"}</Text>
            </Pressable>
          </View>

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
                  <Text style={[styles.sheetOrgText, selected && styles.sheetOrgTextSelected]}>
                    {org.name || "Untitled workspace"}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.sheetActionGrid}>
            {actions.map((action) => (
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
        </View>
      </View>
    </Modal>
  );
}

function EmptyWorkspaceState() {
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.emptyState, { direction: textDirection }]}>
      <Text style={styles.emptyTitle}>{t("noWorkspacesTitle")}</Text>
      <Text style={styles.body}>{t("noWorkspacesBody")}</Text>
    </View>
  );
}

function AuthenticatedHome() {
  const { locale, t, textDirection } = useLocale();
  const router = useRouter();
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

    if (target === "dashboard") {
      router.push({
        pathname: "/org/[orgId]",
        params: { orgId: org._id },
      });
      return;
    }

    router.push({
      pathname: "/org/[orgId]/module/[moduleId]",
      params: { orgId: org._id, moduleId: target },
    });
  };

  return (
    <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.header, { direction: textDirection }]}>
          <View style={styles.headerText}>
            <Text style={styles.brand}>{t("appName")}</Text>
            <Text style={styles.title}>
              {locale === "ar" ? "مركز العمل" : "Work center"}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <LocaleToggle />
            <UserButton />
          </View>
        </View>

        <View style={[styles.cockpitPanel, { direction: textDirection }]}>
          <View style={styles.cockpitTopRow}>
            <View style={styles.cockpitText}>
              <Text style={styles.cockpitEyebrow}>
                {locale === "ar" ? "مساحة نشطة" : "Active workspace"}
              </Text>
              <Text numberOfLines={2} style={styles.cockpitTitle}>
                {primaryOrg?.name || (locale === "ar" ? "اختر مساحة عمل" : "Choose a workspace")}
              </Text>
              <Text style={styles.cockpitMeta}>
                {primaryOrg
                  ? `${t("roleLabel")}: ${primaryOrg.roleName || "UNKNOWN"}`
                  : locale === "ar"
                    ? "ابدأ من قائمة مساحات العمل المتاحة."
                    : "Start from the workspaces available to this account."}
              </Text>
            </View>
            <View style={styles.cockpitBadge}>
              <Text style={styles.cockpitBadgeValue}>{safeOrgs.length}</Text>
              <Text style={styles.cockpitBadgeLabel}>{locale === "ar" ? "مساحة" : "spaces"}</Text>
            </View>
          </View>

          <View style={styles.cockpitMetricRow}>
            <View style={styles.cockpitMetric}>
              <Text style={styles.cockpitMetricValue}>{filteredOrgs.length}</Text>
              <Text style={styles.cockpitMetricLabel}>{locale === "ar" ? "مطابقة" : "matched"}</Text>
            </View>
            <View style={styles.cockpitMetric}>
              <Text style={styles.cockpitMetricValue}>{workflowActions.length}</Text>
              <Text style={styles.cockpitMetricLabel}>{locale === "ar" ? "أوامر" : "workflows"}</Text>
            </View>
            <View style={styles.cockpitMetric}>
              <Text style={styles.cockpitMetricValue}>{isSuperAdmin ? "SA" : primaryOrg?.roleName?.slice(0, 2) || "--"}</Text>
              <Text style={styles.cockpitMetricLabel}>{locale === "ar" ? "صلاحية" : "access"}</Text>
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
              <Text style={styles.cockpitPrimaryText}>
                {locale === "ar" ? "فتح لوحة التحكم" : "Open dashboard"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.cockpitSecondaryButton, pressed && styles.cardPressed]}
              onPress={() => openCommandSheet(primaryOrg)}
            >
              <Text style={styles.cockpitSecondaryText}>
                {locale === "ar" ? "كل الأوامر" : "All commands"}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.commandPanel, { direction: textDirection }]}>
          <View style={styles.commandHeader}>
            <View style={styles.commandHeaderText}>
              <Text style={styles.commandTitle}>
                {locale === "ar" ? "سطح الأوامر" : "Command surface"}
              </Text>
              <Text style={styles.commandBody}>
                {locale === "ar"
                  ? "ابحث، اختر مساحة، ثم انتقل مباشرة إلى المبيعات أو المخزون أو الرسائل."
                  : "Search, pick a workspace, then jump straight into sales, stock, leads, or messages."}
              </Text>
            </View>
            <View style={styles.commandStatus}>
              <Text style={styles.commandStatusValue}>{filteredOrgs.length}</Text>
              <Text style={styles.commandStatusLabel}>{locale === "ar" ? "نتيجة" : "results"}</Text>
            </View>
          </View>

          <View style={styles.searchShell}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              accessibilityLabel={locale === "ar" ? "البحث في مساحات العمل" : "Search workspaces"}
              autoCorrect={false}
              onChangeText={setWorkspaceQuery}
              placeholder={locale === "ar" ? "ابحث باسم المعرض أو الدور..." : "Search showroom or role..."}
              placeholderTextColor={theme.colors.subtleText}
              style={[styles.searchInput, { textAlign: locale === "ar" ? "right" : "left" }]}
              value={workspaceQuery}
            />
            {workspaceQuery ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={locale === "ar" ? "مسح البحث" : "Clear search"}
                style={({ pressed }) => [styles.clearSearch, pressed && styles.cardPressed]}
                onPress={() => setWorkspaceQuery("")}
              >
                <Text style={styles.clearSearchText}>×</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.workflowGrid}>
            {workflowActions.slice(0, 4).map((action) => (
              <WorkflowActionCard
                key={action.target}
                action={action}
                disabled={!primaryOrg && action.target !== "marketplace"}
                onPress={() => openWorkflow(action.target)}
              />
            ))}
          </View>
        </View>

        {isSuperAdmin ? (
          <View style={[styles.adminPanel, { direction: textDirection }]}>
            <Text style={styles.adminLabel}>{t("superAdminLabel")}</Text>
            <Text style={styles.adminBody}>{t("superAdminBody")}</Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.marketplaceLink,
            { direction: textDirection },
            pressed && styles.cardPressed,
          ]}
          onPress={() => router.push(nativeRoutes.marketplace)}
        >
          <View style={styles.marketplaceLinkText}>
            <Text style={styles.marketplaceLinkTitle}>{t("browseMarketplace")}</Text>
            <Text style={styles.workspaceMeta}>{t("marketplaceSubtitle")}</Text>
          </View>
          <Text style={styles.marketplaceArrow}>{locale === "ar" ? "<" : ">"}</Text>
        </Pressable>

        <View style={[styles.sectionHeader, { direction: textDirection }]}>
          <View>
            <Text style={styles.sectionKicker}>
              {locale === "ar" ? "المساحات" : "Workspaces"}
            </Text>
            <Text style={styles.sectionTitle}>{t("workspacesTitle")}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.sectionButton, pressed && styles.cardPressed]}
            onPress={() => openCommandSheet(primaryOrg)}
          >
            <Text style={styles.sectionButtonText}>
              {locale === "ar" ? "اختيار" : "Choose"}
            </Text>
          </Pressable>
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
          <View style={[styles.emptyState, { direction: textDirection }]}>
            <Text style={styles.emptyTitle}>
              {locale === "ar" ? "لا توجد نتائج" : "No matching workspaces"}
            </Text>
            <Text style={styles.body}>
              {locale === "ar"
                ? "جرّب اسم معرض أو دور آخر."
                : "Try another showroom name or role."}
            </Text>
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
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.lg,
  },
  heroEyebrow: {
    color: "#c7d2fe",
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
    color: "#e0e7ff",
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
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.12)",
    padding: theme.spacing.md,
  },
  heroStatValue: {
    color: theme.colors.onPrimary,
    fontSize: 21,
    fontWeight: "900",
  },
  heroStatLabel: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "800",
  },
  authActions: {
    gap: theme.spacing.md,
  },
  primaryButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
    width: "100%",
  },
  buttonPressed: {
    opacity: 0.82,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  secondaryButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.lg,
    width: "100%",
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "800",
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
  workspaceSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  summaryEyebrow: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  summaryValue: {
    color: theme.colors.text,
    fontSize: 36,
    fontWeight: "900",
    lineHeight: 40,
  },
  summaryBody: {
    flex: 1,
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  adminPanel: {
    gap: theme.spacing.xs,
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.warningSoft,
    padding: theme.spacing.md,
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
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.lg,
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
    color: "#99f6e4",
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
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
  cockpitBadge: {
    minWidth: 68,
    alignItems: "center",
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.11)",
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
    color: "#cbd5e1",
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
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.09)",
    padding: theme.spacing.sm,
  },
  cockpitMetricValue: {
    color: theme.colors.onPrimary,
    fontSize: 20,
    fontWeight: "900",
  },
  cockpitMetricLabel: {
    color: "#cbd5e1",
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
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
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
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: "rgba(255,255,255,0.12)",
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
    borderWidth: 1,
    borderColor: "#c7d2fe",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primarySoft,
    padding: theme.spacing.md,
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
  marketplaceArrow: {
    color: theme.colors.primary,
    fontSize: 24,
    fontWeight: "900",
  },
  commandPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
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
    borderRadius: theme.radius.md,
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
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  workflowCardDark: {
    borderColor: theme.colors.hero,
    backgroundColor: theme.colors.hero,
  },
  workflowCardMint: {
    borderColor: "#99f6e4",
    backgroundColor: theme.colors.primarySoft,
  },
  workflowCardAmber: {
    borderColor: "#fed7aa",
    backgroundColor: theme.colors.accentSoft,
  },
  workflowCardBlue: {
    borderColor: "#bae6fd",
    backgroundColor: theme.colors.infoSoft,
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
    color: "#cbd5e1",
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
  searchIcon: {
    color: theme.colors.primary,
    fontSize: 18,
    fontWeight: "900",
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
  clearSearchText: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
    lineHeight: 20,
  },
  commandActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  commandActionPrimary: {
    flex: 1.2,
    minHeight: 82,
    justifyContent: "space-between",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.md,
  },
  commandActionSecondary: {
    flex: 1,
    minHeight: 82,
    justifyContent: "space-between",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accentSoft,
    padding: theme.spacing.md,
  },
  commandActionKicker: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  commandActionKickerOnDark: {
    color: "#a7f3d0",
  },
  commandActionTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  commandActionTitleOnDark: {
    color: theme.colors.onPrimary,
  },
  workspaceCard: {
    gap: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
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
    borderRadius: theme.radius.md,
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
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
  },
  workspaceFooterButtonAccent: {
    borderColor: "#99f6e4",
    backgroundColor: theme.colors.primarySoft,
  },
  rolePill: {
    overflow: "hidden",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "900",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  workspaceAction: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "800",
  },
  workspaceActionAccent: {
    color: theme.colors.primaryDark,
    fontSize: 14,
    fontWeight: "900",
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
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
  },
  sectionButtonText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15,23,42,0.42)",
  },
  sheetDismissArea: {
    flex: 1,
  },
  commandSheet: {
    maxHeight: "86%",
    gap: theme.spacing.md,
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
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
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
  },
  sheetCloseText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  sheetOrgRail: {
    gap: theme.spacing.sm,
  },
  sheetOrgChip: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: theme.radius.md,
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
  emptyState: {
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.lg,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 19,
    fontWeight: "800",
  },
});
