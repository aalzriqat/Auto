import { nativeRoutes } from "@autoflow/shared";
import { UserButton } from "@clerk/expo/native";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { api, type MobileOrgSummary } from "../../convexApi";
import { LocaleToggle } from "../../components/LocaleToggle";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";

function workspaceInitials(name: string | undefined): string {
  const parts = (name || "AutoFlow")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "A";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "F";
  return `${first}${second}`.toUpperCase();
}

function workspaceSearchText(org: MobileOrgSummary): string {
  return [org.name, org.roleName, org._id].filter(Boolean).join(" ").toLowerCase();
}

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

function WorkspaceCard({ org, onPress }: { org: MobileOrgSummary; onPress: () => void }) {
  const { t, textDirection } = useLocale();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("openWorkspace")}: ${org.name || "Untitled workspace"}`}
      style={({ pressed }) => [
        styles.workspaceCard,
        { direction: textDirection },
        pressed && styles.cardPressed,
      ]}
      onPress={onPress}
    >
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
      </View>
      <View style={styles.workspaceFooter}>
        <Text style={styles.rolePill}>{org.roleName || "UNKNOWN"}</Text>
        <Text style={styles.workspaceAction}>{t("openWorkspace")}</Text>
      </View>
    </Pressable>
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
  const orgs = useQuery(api.organizations.listMine, {});
  const isSuperAdmin = useQuery(api.adminAuth.isSuperAdmin, {});
  const safeOrgs = useMemo(
    () => (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null),
    [orgs],
  );
  const filteredOrgs = useMemo(() => {
    const normalizedQuery = workspaceQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return safeOrgs;
    }

    return safeOrgs.filter((org) => workspaceSearchText(org).includes(normalizedQuery));
  }, [safeOrgs, workspaceQuery]);

  if (orgs === undefined || isSuperAdmin === undefined) {
    return <RouteLoadingState label={t("loadingWorkspace")} />;
  }

  const primaryOrg = filteredOrgs[0] ?? safeOrgs[0] ?? null;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={[styles.header, { direction: textDirection }]}>
        <View style={styles.headerText}>
          <Text style={styles.brand}>{t("appName")}</Text>
          <Text style={styles.title}>{t("workspacesTitle")}</Text>
        </View>
        <View style={styles.headerActions}>
          <LocaleToggle />
          <UserButton />
        </View>
      </View>

      <View style={[styles.workspaceSummary, { direction: textDirection }]}>
        <View>
          <Text style={styles.summaryEyebrow}>
            {locale === "ar" ? "مساحات العمل" : "Workspaces"}
          </Text>
          <Text style={styles.summaryValue}>{safeOrgs.length}</Text>
        </View>
        <Text style={styles.summaryBody}>
          {locale === "ar"
            ? "اختر معرضاً للانتقال إلى لوحة التحكم وتجربة الجوال الأصلية."
            : "Choose a showroom to open the mobile-native dashboard and work center."}
        </Text>
      </View>

      <View style={[styles.commandPanel, { direction: textDirection }]}>
        <View style={styles.commandHeader}>
          <View style={styles.commandHeaderText}>
            <Text style={styles.commandTitle}>
              {locale === "ar" ? "ابدأ من هنا" : "Start here"}
            </Text>
            <Text style={styles.commandBody}>
              {locale === "ar"
                ? "ابحث عن مساحة عمل أو افتح السوق مباشرة، مثل شريط أوامر الويب."
                : "Find a workspace or jump straight to the marketplace, like the web command layer."}
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

        <View style={styles.commandActions}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.commandActionPrimary, pressed && styles.cardPressed]}
            onPress={() => {
              if (!primaryOrg) return;
              router.push({
                pathname: "/org/[orgId]",
                params: { orgId: primaryOrg._id },
              });
            }}
          >
            <Text style={[styles.commandActionKicker, styles.commandActionKickerOnDark]}>
              {locale === "ar" ? "فتح سريع" : "Quick open"}
            </Text>
            <Text numberOfLines={1} style={[styles.commandActionTitle, styles.commandActionTitleOnDark]}>
              {primaryOrg?.name || (locale === "ar" ? "لا توجد مساحة" : "No workspace")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.commandActionSecondary, pressed && styles.cardPressed]}
            onPress={() => router.push(nativeRoutes.marketplace)}
          >
            <Text style={styles.commandActionKicker}>{locale === "ar" ? "السوق" : "Marketplace"}</Text>
            <Text style={styles.commandActionTitle}>{t("browseMarketplace")}</Text>
          </Pressable>
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
        <Text style={styles.marketplaceLinkTitle}>{t("browseMarketplace")}</Text>
        <Text style={styles.workspaceMeta}>{t("marketplaceSubtitle")}</Text>
      </Pressable>

      {filteredOrgs.length > 0 ? (
        <View style={styles.workspaceList}>
          {filteredOrgs.map((org) => (
            <WorkspaceCard
              key={org._id}
              org={org}
              onPress={() =>
                router.push({
                  pathname: "/org/[orgId]",
                  params: { orgId: org._id },
                })
              }
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
  workspaceList: {
    gap: theme.spacing.md,
  },
  marketplaceLink: {
    gap: theme.spacing.xs,
    borderWidth: 1,
    borderColor: "#c7d2fe",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primarySoft,
    padding: theme.spacing.md,
  },
  marketplaceLinkTitle: {
    color: theme.colors.text,
    fontSize: 17,
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
    justifyContent: "space-between",
    gap: theme.spacing.md,
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
  cardPressed: {
    opacity: 0.82,
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
