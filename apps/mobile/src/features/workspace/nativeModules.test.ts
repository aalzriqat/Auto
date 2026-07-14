import {
  getNativeModule,
  getNativeModulesByCategory,
  nativeModuleCategories,
  nativeModules,
} from "./nativeModules";

describe("native workspace modules", () => {
  test("keeps module identifiers unique", () => {
    const ids = nativeModules.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every category exposes at least one module", () => {
    for (const category of nativeModuleCategories) {
      expect(getNativeModulesByCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  test("resolves known modules and rejects unknown ones", () => {
    expect(getNativeModule("vehicles")?.id).toBe("vehicles");
    expect(getNativeModule("webview")).toBeNull();
  });
});
