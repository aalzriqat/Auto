import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  compactInitials,
  getVisibleNativeModulesByCategory,
  labelFor,
  nativeModulePath,
  nativeModuleCategories,
  type NativeModuleCategory,
} from "./nativeModules";

export function WorkspaceModuleLauncher({
  orgId,
  permissions = [],
  roleName,
}: {
  orgId: string;
  permissions?: readonly string[];
  roleName?: string;
}) {
  const router = useRouter();
  const { locale, textDirection } = useLocale();
  const [category, setCategory] = useState<NativeModuleCategory>("operations");
  const visibleCategories = useMemo(
    () =>
      nativeModuleCategories
        .map((item) => ({
          ...item,
          modules: getVisibleNativeModulesByCategory(item.id, permissions, roleName),
        }))
        .filter((item) => item.modules.length > 0),
    [permissions, roleName],
  );
  const modules = useMemo(
    () => getVisibleNativeModulesByCategory(category, permissions, roleName),
    [category, permissions, roleName],
  );
  const moduleCount = visibleCategories.reduce((total, item) => total + item.modules.length, 0);

  useEffect(() => {
    if (modules.length > 0) return;
    const firstCategory = visibleCategories[0]?.id;
    if (firstCategory && firstCategory !== category) {
      setCategory(firstCategory);
    }
  }, [category, modules.length, visibleCategories]);

  return (
    <View style={[styles.panel, { direction: textDirection }]}>
      <View style={styles.heading}>
        <View style={styles.headingRow}>
          <View style={styles.headingText}>
            <Text style={styles.panelTitle}>
              {locale === "ar" ? "مركز العمل" : "Work center"}
            </Text>
            <Text style={styles.panelBody}>
              {locale === "ar"
                ? "نفس أقسام الويب، مصممة لاستخدام سريع من الهاتف."
                : "The same web workspace sections, shaped for fast mobile work."}
            </Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeValue}>{moduleCount}</Text>
            <Text style={styles.countBadgeLabel}>{locale === "ar" ? "قسم" : "tools"}</Text>
          </View>
        </View>
      </View>

      <View style={styles.tabs}>
        {visibleCategories.map((item) => {
          const selected = item.id === category;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.tab,
                selected && styles.tabSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => setCategory(item.id)}
            >
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.82}
                numberOfLines={1}
                style={[styles.tabText, selected && styles.tabTextSelected]}
              >
                {labelFor(item.title, locale)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {modules.length > 0 ? (
        <View style={styles.grid}>
          {modules.map((module) => {
            const title = labelFor(module.title, locale);
            return (
          <Pressable
            key={module.id}
            accessibilityRole="button"
            style={({ pressed }) => [styles.moduleCard, pressed && styles.pressed]}
              onPress={() =>
                router.push({
                  pathname: nativeModulePath(module.id),
                  params: { orgId, moduleId: module.id },
                })
              }
          >
            <View style={styles.moduleTopRow}>
              <View style={styles.moduleBadge}>
                <Text style={styles.moduleBadgeText}>{compactInitials(title)}</Text>
              </View>
              <Text style={styles.moduleAction}>{locale === "ar" ? "فتح" : "Open"}</Text>
            </View>
            <View style={styles.moduleText}>
              <Text numberOfLines={1} style={styles.moduleTitle}>
                {title}
              </Text>
              <Text numberOfLines={2} style={styles.moduleSubtitle}>
                {labelFor(module.subtitle, locale)}
              </Text>
            </View>
          </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>
            {locale === "ar" ? "لا توجد أقسام متاحة لهذا الدور." : "No tools are available for this role."}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  heading: {
    gap: theme.spacing.xs,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  headingText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  panelBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  countBadge: {
    minWidth: 64,
    alignItems: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primarySoft,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  countBadgeValue: {
    color: theme.colors.primary,
    fontSize: 20,
    fontWeight: "900",
    lineHeight: 23,
  },
  countBadgeLabel: {
    color: theme.colors.mutedText,
    fontSize: 10,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.xs,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.xs,
  },
  tabSelected: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tabText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  tabTextSelected: {
    color: theme.colors.text,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  moduleCard: {
    width: "48.6%",
    minHeight: 138,
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.md,
  },
  moduleTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  moduleBadge: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primarySoft,
  },
  moduleBadgeText: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "900",
  },
  moduleText: {
    gap: theme.spacing.xs,
  },
  moduleTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  moduleSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  moduleAction: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "900",
  },
  pressed: {
    opacity: 0.82,
  },
  emptyState: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.lg,
  },
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
});
