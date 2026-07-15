import { firstParam, normalizeOrgWorkspaceTab } from "./routeParams";

describe("route params", () => {
  test.each([
    ["plain value", "org-1", "org-1"],
    ["first array value", ["org-1", "org-2"], "org-1"],
    ["empty array", [], null],
    ["missing value", undefined, null],
  ])("returns %s", (_scenario, value, expected) => {
    expect(firstParam(value)).toBe(expected);
  });

  test.each([
    ["known value", "finance", "finance"],
    ["first array value", ["admin", "finance"], "admin"],
    ["unknown value", "unknown", "home"],
    ["empty array", [], "home"],
    ["missing value", undefined, "home"],
  ])("normalizes org workspace tab from %s", (_scenario, value, expected) => {
    expect(normalizeOrgWorkspaceTab(value)).toBe(expected);
  });
});
