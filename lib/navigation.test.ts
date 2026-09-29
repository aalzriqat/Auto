import { describe, expect, test } from "vitest";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";
import { mainNavigation, navItemPermitted } from "./navigation";

const approvals = mainNavigation.find((item) => item.name === "Approvals")!;
const permissionsOf = (role: string) => [
  ...DEFAULT_ROLE_TEMPLATES.find((template) => template.name === role)!.permissions,
];

/**
 * SCRUM-444: Approvals is also where deposit requests are confirmed, and
 * accountants hold `confirm:finance_disbursement` but not `manage:users`. A
 * nav entry gated on `manage:users` alone left them with no way to the queue.
 */
describe("the Approvals entry", () => {
  test.each(["MANAGER", "ACCOUNTANT", "SENIOR_ACCOUNTANT"])("is shown to %s", (role) => {
    expect(navItemPermitted(approvals, permissionsOf(role))).toBe(true);
  });

  test("is not shown to a salesperson", () => {
    expect(navItemPermitted(approvals, permissionsOf("SALES"))).toBe(false);
  });

  test("an item with a single permission behaves as before", () => {
    const vehicles = mainNavigation.find((item) => item.name === "Vehicles")!;
    expect(navItemPermitted(vehicles, ["view:vehicles"])).toBe(true);
    expect(navItemPermitted(vehicles, [])).toBe(false);
  });
});