import {
  canAccessNativeModule,
  compactInitials,
  countVisibleNativeModulesByCategory,
  getNativeModule,
  getNativeModulesByCategory,
  getVisibleNativeModules,
  getVisibleNativeModulesByCategory,
  labelFor,
  moduleSearchText,
  nativeModulePath,
  nativeModuleCategories,
  nativeModules,
  searchNativeModules,
} from "./nativeModules";

describe("native workspace modules", () => {
  test("keeps module identifiers unique", () => {
    const ids = nativeModules.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every category exposes at least one module", () => {
    for (const category of nativeModuleCategories) {
      expect(category.icon).toBe(category.id);
      expect(getNativeModulesByCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  test("resolves known modules and rejects unknown ones", () => {
    expect(getNativeModule("vehicles")?.id).toBe("vehicles");
    expect(getNativeModule("vehicles")?.icon).toBe("vehicles");
    expect(getNativeModule("webview")).toBeNull();
    expect(getNativeModule(null)).toBeNull();
    expect(getNativeModule(undefined)).toBeNull();
  });

  test("localizes module labels with an English fallback", () => {
    expect(labelFor({ en: "Inventory", ar: "المخزون" }, "ar")).toBe("المخزون");
    expect(labelFor({ en: "Inventory", ar: "" }, "ar")).toBe("Inventory");
  });

  test("builds shared module paths and compact initials", () => {
    expect(nativeModulePath("marketplace")).toBe("/org/[orgId]/marketplace");
    expect(nativeModulePath("vehicles")).toBe("/org/[orgId]/module/[moduleId]");
    expect(compactInitials("Marketplace Requests")).toBe("MR");
    expect(compactInitials("Auto")).toBe("AU");
    expect(compactInitials("A")).toBe("AF");
    expect(compactInitials("")).toBe("AF");
  });

  test("checks module access from owner roles and member permissions", () => {
    const vehicles = getNativeModule("vehicles");
    const messages = getNativeModule("messages");
    const roles = getNativeModule("roles");

    expect(vehicles).not.toBeNull();
    expect(messages).not.toBeNull();
    expect(roles).not.toBeNull();
    if (!vehicles || !messages || !roles) return;

    expect(canAccessNativeModule(vehicles, ["view:vehicles"], "Sales")).toBe(true);
    expect(canAccessNativeModule(vehicles, [], "Sales")).toBe(false);
    expect(canAccessNativeModule(messages, [], "Sales")).toBe(true);
    expect(canAccessNativeModule(roles, [], "owner")).toBe(true);
    expect(canAccessNativeModule(roles, [], "Manager")).toBe(false);
    expect(canAccessNativeModule(roles)).toBe(false);
  });

  test("filters visible modules by category permissions", () => {
    expect(getVisibleNativeModulesByCategory("operations", ["view:vehicles"], "Sales").map((module) => module.id)).toEqual([
      "vehicles",
    ]);
    expect(getVisibleNativeModulesByCategory("pipeline").map((module) => module.id)).toEqual([
      "messages",
      "notifications",
    ]);
    expect(getVisibleNativeModulesByCategory("admin", [], "OWNER").map((module) => module.id)).toEqual(
      getNativeModulesByCategory("admin")
        .filter((module) => module.ownerOnly)
        .map((module) => module.id),
    );
    expect(
      getVisibleNativeModulesByCategory("admin", ["manage:users"], "OWNER").map((module) => module.id),
    ).toEqual(
      getNativeModulesByCategory("admin").map((module) => module.id),
    );
  });

  test("searches visible modules across localized metadata", () => {
    const visibleForSales = getVisibleNativeModules(["view:vehicles", "view:sales"], "Sales");

    expect(getVisibleNativeModules().map((module) => module.id)).toEqual(["messages", "notifications", "quotes"]);
    expect(nativeModules.every((module) => module.icon.length > 0)).toBe(true);
    expect(visibleForSales.map((module) => module.id)).toEqual(
      expect.arrayContaining(["vehicles", "messages", "notifications", "sales", "quotes"]),
    );
    expect(searchNativeModules(visibleForSales, "", "en")).toEqual(visibleForSales);
    expect(searchNativeModules(visibleForSales, "inventory", "en").map((module) => module.id)).toEqual([
      "vehicles",
    ]);
    expect(searchNativeModules(visibleForSales, "المبيعات", "ar").map((module) => module.id)).toEqual([
      "sales",
    ]);
    expect(searchNativeModules(visibleForSales, "view:sales", "en").map((module) => module.id)).toEqual([
      "sales",
      "applications",
    ]);
    expect(searchNativeModules(visibleForSales, "missing", "en")).toEqual([]);
    expect(moduleSearchText(getNativeModule("vehicles")!, "en")).toContain("inventory");
    expect(countVisibleNativeModulesByCategory("pipeline")).toBe(2);
    expect(countVisibleNativeModulesByCategory("operations", ["view:vehicles"], "Sales")).toBe(1);
  });
});
