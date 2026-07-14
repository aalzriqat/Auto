import { firstParam } from "./routeParams";

describe("route params", () => {
  test.each([
    ["plain value", "org-1", "org-1"],
    ["first array value", ["org-1", "org-2"], "org-1"],
    ["empty array", [], null],
    ["missing value", undefined, null],
  ])("returns %s", (_scenario, value, expected) => {
    expect(firstParam(value)).toBe(expected);
  });
});
