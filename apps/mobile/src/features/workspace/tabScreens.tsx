import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Icon, type SemanticIconName } from "../../components/Icon";
import { FadeSlideIn } from "../../components/Motion";
import { firstParam } from "../../navigation/routeParams";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { type AppTheme } from "../../theme";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { LeadsModule } from "./modules/leads";
import { SalesWizardScreen, type WizardPaymentType } from "./salesWizard/SalesWizardScreen";
import { MessagesModule } from "./modules/messages";
import { NotificationsModule } from "./modules/notifications";
import { SalesModule } from "./modules/sales";
import { SocialInboxModule } from "./modules/socialInbox";
import { VehiclesModule } from "./modules/vehicles";
import { WorkspaceModuleLauncher } from "./WorkspaceModuleLauncher";
import { useWorkspaceTabsData } from "./WorkspaceTabsLayout";
import {
  canAccessNativeModule,
  getNativeModule,
  getVisibleNativeModulesByCategory,
  labelFor,
  nativeModulePath,
  type NativeModuleCategory,
  type NativeModuleDefinition,
  type NativeModuleId,
} from "./nativeModules";

function moduleAccessible(
  moduleId: NativeModuleId,
  permissions: readonly string[],
  roleName?: string,
): boolean {
  const definition = getNativeModule(moduleId);
  return definition ? canAccessNativeModule(definition, permissions, roleName) : false;
}

function TabLargeTitle({ caption, title }: Readonly<{ caption?: string; title: string }>) {
  const styles = useThemedStyles(makeStyles);
  const { textDirection } = useLocale();

  return (
    <FadeSlideIn>
      <View style={[styles.largeTitleBlock, { direction: textDirection }]}>
        <Text style={styles.largeTitle}>{title}</Text>
        {caption ? <Text style={styles.largeTitleCaption}>{caption}</Text> : null}
      </View>
    </FadeSlideIn>
  );
}

function TabSegments<T extends string>({
  onChange,
  segments,
  value,
}: Readonly<{
  onChange: (value: T) => void;
  segments: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { textDirection } = useLocale();

  return (
    <View style={[styles.segmentTrack, { direction: textDirection }]}>
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.segment, selected && styles.segmentSelected]}
            onPress={() => onChange(segment.value)}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function InventoryTabScreen() {
  const { locale } = useLocale();
  const { myMembership, org, orgId } = useWorkspaceTabsData();
  const canSeeVehicles = moduleAccessible("vehicles", myMembership.permissions, myMembership.roleName);

  return (
    <Screen>
      <TabLargeTitle
        caption={org.name || undefined}
        title={locale === "ar" ? "المخزون" : "Inventory"}
      />
      {canSeeVehicles ? (
        <VehiclesModule orgId={orgId} permissions={myMembership.permissions} />
      ) : (
        <Screen scroll padding="lg">
          <WorkspaceModuleLauncher
            initialCategory="operations"
            lockedCategory="operations"
            orgId={orgId}
            permissions={myMembership.permissions}
            roleName={myMembership.roleName}
          />
        </Screen>
      )}
    </Screen>
  );
}

type SalesSegment = "leads" | "deals";

export function SalesTabScreen() {
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const { myMembership, org, orgId } = useWorkspaceTabsData();
  const canSeeLeads = moduleAccessible("leads", myMembership.permissions, myMembership.roleName);
  const canSeeSales = moduleAccessible("sales", myMembership.permissions, myMembership.roleName);
  const [segment, setSegment] = useState<SalesSegment>(canSeeLeads ? "leads" : "deals");

  const segments: Array<{ label: string; value: SalesSegment }> = [];
  if (canSeeLeads) segments.push({ label: locale === "ar" ? "الفرص" : "Leads", value: "leads" });
  if (canSeeSales) segments.push({ label: locale === "ar" ? "الصفقات" : "Deals", value: "deals" });

  const active: SalesSegment = segments.some((item) => item.value === segment)
    ? segment
    : (segments[0]?.value ?? "leads");
  const [wizard, setWizard] = useState<WizardPaymentType | null>(null);

  return (
    <Screen>
      <TabLargeTitle
        caption={org.name || undefined}
        title={locale === "ar" ? "المبيعات" : "Sales"}
      />
      {canSeeSales ? (
        <View style={styles.wizardButtonRow}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.wizardButton, styles.wizardButtonCash, pressed && styles.wizardButtonPressed]}
            onPress={() => setWizard("CASH")}
          >
            <Icon color="onPrimary" name="sales" size={16} />
            <Text style={styles.wizardButtonText}>{locale === "ar" ? "عرض نقدي" : "Cash quote"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.wizardButton, styles.wizardButtonFinance, pressed && styles.wizardButtonPressed]}
            onPress={() => setWizard("INSTALLMENT")}
          >
            <Icon color="onPrimary" name="billing" size={16} />
            <Text style={styles.wizardButtonText}>{locale === "ar" ? "عرض تقسيط" : "Installment quote"}</Text>
          </Pressable>
        </View>
      ) : null}
      {segments.length > 1 ? (
        <View style={styles.segmentWrap}>
          <TabSegments segments={segments} value={active} onChange={setSegment} />
        </View>
      ) : null}
      <Modal animationType="slide" visible={wizard !== null} onRequestClose={() => setWizard(null)}>
        {wizard ? (
          <SalesWizardScreen orgId={orgId} paymentType={wizard} onClose={() => setWizard(null)} />
        ) : null}
      </Modal>
      {active === "leads" && canSeeLeads ? <LeadsModule orgId={orgId} /> : null}
      {active === "deals" && canSeeSales ? (
        <SalesModule myMembership={myMembership} orgId={orgId} />
      ) : null}
      {segments.length === 0 ? (
        <Screen scroll padding="lg">
          <WorkspaceModuleLauncher
            initialCategory="pipeline"
            lockedCategory="pipeline"
            orgId={orgId}
            permissions={myMembership.permissions}
            roleName={myMembership.roleName}
          />
        </Screen>
      ) : null}
    </Screen>
  );
}

type InboxSegment = "messages" | "social" | "alerts";

const inboxSegmentValues: ReadonlySet<InboxSegment> = new Set(["messages", "social", "alerts"]);

function normalizeInboxSegment(value: string | string[] | undefined): InboxSegment {
  const candidate = firstParam(value);
  return candidate && inboxSegmentValues.has(candidate as InboxSegment)
    ? (candidate as InboxSegment)
    : "messages";
}

export function InboxTabScreen() {
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const { myMembership, org, orgId } = useWorkspaceTabsData();
  const params = useLocalSearchParams<{ segment?: string | string[] }>();
  const canSeeSocial = moduleAccessible("socialInbox", myMembership.permissions, myMembership.roleName);
  const [segment, setSegment] = useState<InboxSegment>(() => normalizeInboxSegment(params.segment));

  const segments: Array<{ label: string; value: InboxSegment }> = [
    { label: locale === "ar" ? "الرسائل" : "Messages", value: "messages" },
  ];
  if (canSeeSocial) {
    segments.push({ label: locale === "ar" ? "التواصل" : "Social", value: "social" });
  }
  segments.push({ label: locale === "ar" ? "التنبيهات" : "Alerts", value: "alerts" });

  const active: InboxSegment = segments.some((item) => item.value === segment)
    ? segment
    : "messages";

  return (
    <Screen>
      <TabLargeTitle
        caption={org.name || undefined}
        title={locale === "ar" ? "الوارد" : "Inbox"}
      />
      <View style={styles.segmentWrap}>
        <TabSegments segments={segments} value={active} onChange={setSegment} />
      </View>
      {active === "messages" ? <MessagesModule orgId={orgId} /> : null}
      {active === "social" && canSeeSocial ? <SocialInboxModule orgId={orgId} /> : null}
      {active === "alerts" ? <NotificationsModule orgId={orgId} /> : null}
    </Screen>
  );
}

const promotedModuleIds: ReadonlySet<NativeModuleId> = new Set([
  "vehicles",
  "leads",
  "sales",
  "messages",
  "socialInbox",
  "notifications",
]);

const moreSections: ReadonlyArray<{
  category: NativeModuleCategory;
  title: { en: string; ar: string };
}> = [
  { category: "operations", title: { en: "Operations", ar: "التشغيل" } },
  { category: "pipeline", title: { en: "Pipeline", ar: "المتابعة" } },
  { category: "finance", title: { en: "Finance", ar: "المالية" } },
  { category: "admin", title: { en: "Workspace", ar: "مساحة العمل" } },
];

const categoryToneSoft: Record<NativeModuleCategory, "successSoft" | "warningSoft" | "infoSoft" | "indigoSoft"> = {
  operations: "successSoft",
  pipeline: "warningSoft",
  finance: "infoSoft",
  admin: "indigoSoft",
};

const categoryToneFg: Record<NativeModuleCategory, "success" | "warning" | "info" | "indigo"> = {
  operations: "success",
  pipeline: "warning",
  finance: "info",
  admin: "indigo",
};

function MoreRow({
  category,
  isLast,
  module,
  onPress,
}: Readonly<{
  category: NativeModuleCategory;
  isLast: boolean;
  module: NativeModuleDefinition;
  onPress: () => void;
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { isRtl, locale } = useLocale();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labelFor(module.title, locale)}
      style={({ pressed }) => [styles.moreRow, pressed && styles.moreRowPressed]}
      onPress={onPress}
    >
      <View style={[styles.moreIconShell, { backgroundColor: theme.colors[categoryToneSoft[category]] }]}>
        <Icon color={categoryToneFg[category]} name={module.icon as SemanticIconName} size={18} />
      </View>
      <View style={[styles.moreRowText, !isLast && styles.moreRowSeparator]}>
        <Text numberOfLines={1} style={styles.moreRowTitle}>
          {labelFor(module.title, locale)}
        </Text>
        <Icon color="subtleText" name={isRtl ? "back" : "chevronForward"} size={16} />
      </View>
    </Pressable>
  );
}

export function MoreTabScreen() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { locale, textDirection } = useLocale();
  const { myMembership, org, orgId } = useWorkspaceTabsData();

  const sections = moreSections
    .map((section) => ({
      ...section,
      modules: getVisibleNativeModulesByCategory(
        section.category,
        myMembership.permissions,
        myMembership.roleName,
      ).filter((module) => !promotedModuleIds.has(module.id)),
    }))
    .filter((section) => section.modules.length > 0);

  return (
    <Screen scroll padding="lg">
      <TabLargeTitle
        caption={org.name || undefined}
        title={locale === "ar" ? "المزيد" : "More"}
      />
      <FadeSlideIn delay={70} style={[styles.moreSections, { direction: textDirection }]}>
        {sections.map((section) => (
          <View key={section.category} style={styles.moreSection}>
            <Text style={styles.moreSectionTitle}>{labelFor(section.title, locale)}</Text>
            <View style={styles.moreGroup}>
              {section.modules.map((module, index) => (
                <MoreRow
                  key={module.id}
                  category={section.category}
                  isLast={index === section.modules.length - 1}
                  module={module}
                  onPress={() =>
                    router.push({
                      pathname: nativeModulePath(module.id),
                      params: { orgId, moduleId: module.id },
                    })
                  }
                />
              ))}
            </View>
          </View>
        ))}
      </FadeSlideIn>
    </Screen>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  largeTitleBlock: {
    gap: 2,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  largeTitle: {
    color: theme.colors.text,
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 38,
  },
  largeTitleCaption: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "500",
  },
  segmentWrap: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  wizardButtonRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  wizardButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.full,
  },
  wizardButtonCash: {
    backgroundColor: theme.colors.primary,
  },
  wizardButtonFinance: {
    backgroundColor: theme.colors.indigo,
  },
  wizardButtonPressed: {
    opacity: 0.85,
  },
  wizardButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  segmentTrack: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.xs,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  segmentSelected: {
    backgroundColor: theme.colors.surface,
    ...theme.shadows.sm,
  },
  segmentText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextSelected: {
    color: theme.colors.text,
  },
  moreSections: {
    gap: theme.spacing.xl,
    paddingBottom: theme.spacing.xxl,
  },
  moreSection: {
    gap: theme.spacing.sm,
  },
  moreSectionTitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.4,
    marginHorizontal: theme.spacing.sm,
    textTransform: "uppercase",
  },
  moreGroup: {
    overflow: "hidden",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    ...theme.shadows.sm,
  },
  moreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
  },
  moreRowPressed: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  moreIconShell: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primarySoft,
  },
  moreRowText: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  moreRowSeparator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  moreRowTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "500",
  },
});
