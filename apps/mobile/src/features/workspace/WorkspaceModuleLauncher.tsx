import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../../theme";
import {
  countVisibleNativeModulesByCategory,
  getVisibleNativeModules,
  getVisibleNativeModulesByCategory,
  labelFor,
  nativeModulePath,
  nativeModuleCategories,
  searchNativeModules,
  type NativeModuleDefinition,
  type NativeModuleCategory,
} from "./nativeModules";

function useLauncherTypography() {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();

  return useMemo(
    () => ({
      body: getTypographyStyle("body", locale, fontsLoaded),
      caption: getTypographyStyle("caption", locale, fontsLoaded),
      heading: getTypographyStyle("heading", locale, fontsLoaded),
      label: getTypographyStyle("label", locale, fontsLoaded),
      title: getTypographyStyle("title", locale, fontsLoaded),
    }),
    [fontsLoaded, locale],
  );
}

export function WorkspaceModuleLauncher({
  initialCategory = "operations",
  lockedCategory,
  orgId,
  permissions = [],
  roleName,
}: {
  initialCategory?: NativeModuleCategory;
  lockedCategory?: NativeModuleCategory;
  orgId: string;
  permissions?: readonly string[];
  roleName?: string;
}) {
  const router = useRouter();
  const { locale, t, textDirection } = useLocale();
  const type = useLauncherTypography();
  const [category, setCategory] = useState<NativeModuleCategory>(initialCategory);
  const [query, setQuery] = useState("");
  const activeCategory = lockedCategory ?? category;
  const isSearching = query.trim().length > 0;
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
  const allVisibleModules = useMemo(
    () => getVisibleNativeModules(permissions, roleName),
    [permissions, roleName],
  );
  const modules = useMemo(
    () => getVisibleNativeModulesByCategory(activeCategory, permissions, roleName),
    [activeCategory, permissions, roleName],
  );
  const searchableModules = lockedCategory ? modules : allVisibleModules;
  const searchedModules = useMemo(
    () => searchNativeModules(searchableModules, query, locale),
    [locale, query, searchableModules],
  );
  const displayedModules = isSearching ? searchedModules : modules;
  const moduleCount = lockedCategory
    ? modules.length
    : visibleCategories.reduce((total, item) => total + item.modules.length, 0);
  const activeCategoryDefinition = nativeModuleCategories.find((item) => item.id === activeCategory);

  useEffect(() => {
    if (lockedCategory) return;
    if (modules.length > 0) return;
    const firstCategory = visibleCategories[0]?.id;
    if (firstCategory && firstCategory !== category) {
      setCategory(firstCategory);
    }
  }, [category, lockedCategory, modules.length, visibleCategories]);

  return (
    <Card style={[styles.panel, { direction: textDirection }]}>
      <View style={styles.heading}>
        <View style={styles.headingRow}>
          <View style={styles.headingText}>
            <Text style={[styles.panelTitle, type.title]}>
              {lockedCategory && activeCategoryDefinition
                ? labelFor(activeCategoryDefinition.title, locale)
                : t("workspaceCommandCenterTitle")}
            </Text>
            <Text style={[styles.panelBody, type.body]}>
              {lockedCategory ? t("workspaceCategoryCenterBody") : t("workspaceCommandCenterBody")}
            </Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={[styles.countBadgeValue, type.title]}>{moduleCount}</Text>
            <Text style={[styles.countBadgeLabel, type.label]}>{t("workspaceToolsCount")}</Text>
          </View>
        </View>
      </View>

      <View style={styles.searchShell}>
        <Icon color="primary" name="search" size={18} />
        <TextInput
          accessibilityLabel={t("workspaceSearchTools")}
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("workspaceSearchPlaceholder")}
          placeholderTextColor={theme.colors.subtleText}
          style={[styles.searchInput, type.body, { textAlign: locale === "ar" ? "right" : "left" }]}
          value={query}
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspaceClearSearch")}
            style={({ pressed }) => [styles.clearSearch, pressed && styles.pressed]}
            onPress={() => setQuery("")}
          >
            <Icon color="text" name="close" size={18} />
          </Pressable>
        ) : null}
      </View>

      {lockedCategory ? null : (
        <View style={styles.tabs}>
          {visibleCategories.map((item) => {
            const selected = item.id === category;
            const visibleCount = countVisibleNativeModulesByCategory(item.id, permissions, roleName);
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
                onPress={() => {
                  setQuery("");
                  setCategory(item.id);
                }}
              >
                <View style={styles.tabContent}>
                  <Icon color={selected ? "primary" : "mutedText"} name={item.icon} size={16} />
                  <Text
                    adjustsFontSizeToFit
                    minimumFontScale={0.82}
                    numberOfLines={1}
                    style={[styles.tabText, type.label, selected && styles.tabTextSelected]}
                  >
                    {labelFor(item.title, locale)} · {visibleCount}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {displayedModules.length > 0 ? (
        <View style={styles.grid}>
          {displayedModules.map((module) => {
            const title = labelFor(module.title, locale);
            const categoryTitle = getCategoryLabel(module, locale);
            return (
              <Card
                key={module.id}
                accessibilityLabel={`${t("workspaceOpenModule")}: ${title}`}
                onPress={() =>
                  router.push({
                    pathname: nativeModulePath(module.id),
                    params: { orgId, moduleId: module.id },
                  })
                }
                style={[
                  styles.moduleCard,
                  isSearching && styles.moduleCardWide,
                ]}
              >
                <View style={styles.moduleTopRow}>
                  <View style={styles.moduleBadge}>
                    <Icon color="primary" name={module.icon} size={20} />
                  </View>
                  <View style={styles.moduleMeta}>
                    <Text numberOfLines={1} style={[styles.moduleCategory, type.label]}>
                      {categoryTitle}
                    </Text>
                    <Text style={[styles.moduleAction, type.label]}>{t("workspaceOpenModule")}</Text>
                  </View>
                </View>
                <View style={styles.moduleText}>
                  <Text numberOfLines={1} style={[styles.moduleTitle, type.heading]}>
                    {title}
                  </Text>
                  <Text numberOfLines={isSearching ? 3 : 2} style={[styles.moduleSubtitle, type.caption]}>
                    {labelFor(module.subtitle, locale)}
                  </Text>
                </View>
              </Card>
            );
          })}
        </View>
      ) : (
        <EmptyState
          icon={isSearching ? "search" : "operations"}
          title={isSearching ? t("workspaceNoSearchResults") : t("workspaceNoRoleTools")}
        />
      )}
    </Card>
  );
}

function getCategoryLabel(module: NativeModuleDefinition, locale: "en" | "ar"): string {
  const category = nativeModuleCategories.find((item) => item.id === module.category);
  return category ? labelFor(category.title, locale) : module.category;
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
  searchShell: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
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
  tabContent: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
  },
  tabText: {
    flexShrink: 1,
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
  moduleCardWide: {
    width: "100%",
    minHeight: 126,
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
  moduleMeta: {
    flex: 1,
    minWidth: 0,
    alignItems: "flex-end",
    gap: 2,
  },
  moduleCategory: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "800",
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
});
