import { describe, expect, test } from "vitest";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";
import { mainNavigation, navItemPermitted, tabTitleNavItem } from "./navigation";

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

/**
 * SCRUM-631: which nav section owns the browser tab title. A sale's deal page
 * lives under /sales but exports its own "Deal | AutoFlow" title; the section
 * rule must not replace it with "Sales" (Codex SCRUM-631-1).
 */
describe("the tab title section", () => {
  const org = "org1";
  test.each([
    ["/org1/vehicles", "Vehicles"],
    ["/org1/vehicles/abc", "Vehicles"],
    ["/org1/deals", "DealsTitle"],
    ["/org1/sales", "Sales"],
    ["/org1/settings/branches", "Branches"],
  ])("%s is titled by %s", (pathname, name) => {
    expect(tabTitleNavItem(pathname, org)?.name).toBe(name);
  });

  test.each(["/org1/sales/sale123/deal", "/org1/sales/sale123/deal/", "/org1/applications/app1/deal", "/org1/messages"])(
    "%s keeps its own metadata title",
    (pathname) => {
      expect(tabTitleNavItem(pathname, org)).toBeNull();
    }
  );

  test("no org yet means no section", () => {
    expect(tabTitleNavItem("/org1/vehicles", null)).toBeNull();
  });
});