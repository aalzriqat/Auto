import { describe, expect, test } from "vitest";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";
import {
  NAV_GROUPS,
  isNavItemVisible,
  isNavPathActive,
  mainNavigation,
  navItemPermitted,
  navPlacementOf,
  settingsNavigation,
  tabTitleNavItem,
  visibleFooterNavItems,
  visibleNavGroups,
} from "./navigation";

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
  test("custom queue operators get the same entry authority as the page", () => {
    expect(navItemPermitted(approvals, ["approve:requests"])).toBe(true);
    expect(navItemPermitted(approvals, ["confirm:finance_disbursement"])).toBe(true);
    expect(navItemPermitted(approvals, ["manage:users"])).toBe(false);
  });
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

/**
 * SCRUM-890: the sidebar was regrouped and Notifications / Billing left the
 * list. No gate may change: for every kind of member the hrefs offered are
 * exactly the ones the flat sidebar offered, minus those two, which stay
 * reachable (the header bell and the owner's plan card).
 */
interface LegacyRow {
  href: string;
  permission?: string;
  anyPermission?: readonly string[];
  ownerOnly?: boolean;
  settings?: boolean;
}

/** A frozen copy of the pre-SCRUM-890 catalog and filters, so a gate edit cannot go unnoticed. */
const LEGACY_ROWS: readonly LegacyRow[] = [
  { href: "/dashboard", permission: "manage:users" },
  { href: "/vehicles", permission: "view:vehicles" },
  { href: "/customers", permission: "view:customers" },
  { href: "/leads", permission: "view:leads" },
  { href: "/social-inbox", permission: "view:leads" },
  { href: "/deals", permission: "view:sales" },
  { href: "/sourcing", permission: "view:finance" },
  // SCRUM-887 added this row to the flat list with the same gate as Sourcing; the grouped sidebar
  // must offer it to exactly the same members.
  { href: "/suppliers", permission: "view:finance" },
  { href: "/sales", permission: "view:sales" },
  { href: "/commissions", permission: "view:commissions" },
  { href: "/payroll", permission: "view:payroll" },
  { href: "/notifications" },
  { href: "/tasks", permission: "view:tasks" },
  { href: "/expenses", permission: "view:expenses" },
  { href: "/accounting", permission: "view:finance" },
  { href: "/reports", permission: "view:reports" },
  { href: "/approvals", anyPermission: ["approve:requests", "confirm:finance_disbursement"] },
  { href: "/marketplace/requests", permission: "marketplace:respond" },
  { href: "/team", permission: "manage:users", settings: true },
  { href: "/settings/general", ownerOnly: true, settings: true },
  { href: "/settings/finance", ownerOnly: true, settings: true },
  { href: "/settings/pipeline", ownerOnly: true, settings: true },
  { href: "/settings/lead-sources", ownerOnly: true, settings: true },
  { href: "/settings/custom-fields", ownerOnly: true, settings: true },
  { href: "/settings/commission", ownerOnly: true, settings: true },
  { href: "/settings/branches", ownerOnly: true, settings: true },
  { href: "/settings/integrations", ownerOnly: true, settings: true },
  { href: "/settings/website", ownerOnly: true, settings: true },
  { href: "/settings/marketplace", ownerOnly: true, settings: true },
  { href: "/settings/feedback", ownerOnly: true, settings: true },
  { href: "/settings/billing", ownerOnly: true, settings: true },
];

function legacyVisibleHrefs(permissions: readonly string[], isOwner: boolean): string[] {
  return LEGACY_ROWS.filter((row) => {
    if (row.settings) {
      if (row.ownerOnly) return isOwner;
      return !row.permission || permissions.includes(row.permission);
    }
    if (row.anyPermission) return row.anyPermission.some((p) => permissions.includes(p));
    return !row.permission || permissions.includes(row.permission);
  }).map((row) => row.href);
}

const MOVED_OUT_OF_THE_LIST = ["/notifications", "/settings/billing"];

const MEMBERS: ReadonlyArray<readonly [string, string[], boolean]> = [
  ["owner", permissionsOf("OWNER"), true],
  ["manager", permissionsOf("MANAGER"), false],
  ["sales rep", permissionsOf("SALES"), false],
  ["reception", permissionsOf("RECEPTION"), false],
  ["accountant", permissionsOf("ACCOUNTANT"), false],
  ["senior accountant", permissionsOf("SENIOR_ACCOUNTANT"), false],
  ["marketplace-only", ["marketplace:respond"], false],
  ["no permissions", [], false],
  ["OWNER-named role that does not qualify", permissionsOf("OWNER"), false],
];

const sidebarHrefs = (permissions: string[], isOwner: boolean) =>
  visibleNavGroups(permissions, isOwner).flatMap((section) => section.items.map((item) => item.href));

describe("the grouped sidebar offers the same hrefs as before", () => {
  test.each(MEMBERS)("%s", (_label, permissions, isOwner) => {
    const expected = legacyVisibleHrefs(permissions, isOwner).filter((href) => !MOVED_OUT_OF_THE_LIST.includes(href));
    expect([...sidebarHrefs(permissions, isOwner)].sort()).toEqual([...expected].sort());
    // Notifications is the bell's and Billing the plan card's: never a list row, whoever asks.
    expect(sidebarHrefs(permissions, isOwner)).not.toContain("/notifications");
    expect(sidebarHrefs(permissions, isOwner)).not.toContain("/settings/billing");
    // Billing keeps its OWNER gate, now on the plan card.
    expect(visibleFooterNavItems(permissions, isOwner).map((item) => item.href)).toEqual(
      isOwner ? ["/settings/billing"] : []
    );
  });

  test("the owner's sections, in order", () => {
    expect(
      visibleNavGroups(permissionsOf("OWNER"), true).map((section) => [
        section.group.id,
        section.items.map((item) => item.name),
      ])
    ).toEqual([
      ["overview", ["Dashboard", "Tasks", "Approvals"]],
      ["customersSales", ["Leads", "SocialInbox", "Customers", "DealsTitle", "Sales"]],
      ["inventorySourcing", ["Vehicles", "Sourcing", "Suppliers", "MarketplaceRequests"]],
      ["financeReports", ["Accounting", "Expenses", "Commissions", "Payroll", "Reports"]],
      [
        "settings",
        [
          "Team",
          "GeneralSettings",
          "Branches",
          "FinanceSettings",
          "Pipeline",
          "LeadSources",
          "CustomFields",
          "CommissionRules",
          "Integrations",
          "Website",
          "MarketplaceSettingsTitle",
          "FeedbackInbox",
        ],
      ],
    ]);
  });

  test("a sales rep sees no Inventory, Finance or Settings section, and no empty captions", () => {
    const sections = visibleNavGroups(permissionsOf("SALES"), false);
    expect(sections.every((section) => section.items.length > 0)).toBe(true);
    expect(sections.map((section) => section.group.id)).not.toContain("settings");
  });

  test("an accountant reaches Approvals (SCRUM-444) in the top block", () => {
    const overview = visibleNavGroups(permissionsOf("ACCOUNTANT"), false).find((s) => s.group.id === "overview");
    expect(overview?.items.map((item) => item.name)).toContain("Approvals");
  });

  test("a manager's Settings section is Team alone", () => {
    const settings = visibleNavGroups(permissionsOf("MANAGER"), false).find((s) => s.group.id === "settings");
    expect(settings?.items.map((item) => item.name)).toEqual(["Team"]);
  });

  test("marketplace-only members see only Marketplace requests", () => {
    expect(sidebarHrefs(["marketplace:respond"], false)).toEqual(["/marketplace/requests"]);
  });

  test("a member with no permissions sees an empty sidebar", () => {
    expect(visibleNavGroups([], false)).toEqual([]);
    expect(visibleFooterNavItems([], false)).toEqual([]);
  });
});

describe("isNavItemVisible", () => {
  const owned = settingsNavigation.find((item) => item.name === "Branches")!;

  test("an owner-only item follows isOwner and ignores permissions", () => {
    expect(isNavItemVisible(owned, [], true)).toBe(true);
    expect(isNavItemVisible(owned, permissionsOf("OWNER"), false)).toBe(false);
  });

  test("any other item follows its permission", () => {
    const team = settingsNavigation.find((item) => item.name === "Team")!;
    expect(isNavItemVisible(team, ["manage:users"], false)).toBe(true);
    expect(isNavItemVisible(team, ["view:users"], true)).toBe(false);
  });
});

describe("the catalog", () => {
  const catalog = [...mainNavigation, ...settingsNavigation];

  test("every item names a real group, and no href or name repeats", () => {
    const ids = new Set(NAV_GROUPS.map((group) => group.id));
    expect(catalog.every((item) => ids.has(item.group))).toBe(true);
    expect(new Set(catalog.map((item) => item.href)).size).toBe(catalog.length);
    expect(new Set(catalog.map((item) => item.name)).size).toBe(catalog.length);
  });

  test("only Settings collapses", () => {
    expect(NAV_GROUPS.filter((group) => group.collapsible).map((group) => group.id)).toEqual(["settings"]);
  });

  test("only Notifications is in the header and only Billing in the footer", () => {
    expect(catalog.filter((item) => navPlacementOf(item) === "header").map((item) => item.name)).toEqual(["Notifications"]);
    expect(catalog.filter((item) => navPlacementOf(item) === "footer").map((item) => item.name)).toEqual(["Billing"]);
  });

  test("the Settings Commission entry is labelled apart from the earned Commissions", () => {
    expect(catalog.find((item) => item.href === "/settings/commission")?.name).toBe("CommissionRules");
    expect(catalog.find((item) => item.href === "/commissions")?.name).toBe("Commissions");
  });
});

describe("isNavPathActive", () => {
  test.each([
    ["/o/sales", "/o/sales", true],
    ["/o/sales/abc", "/o/sales", true],
    ["/o/sales-reports", "/o/sales", false],
    ["/o/sale", "/o/sales", false],
    ["/o/settings/commission", "/o/commissions", false],
  ])("%s on %s is %s", (pathname, href, expected) => {
    expect(isNavPathActive(pathname, href)).toBe(expected);
  });
});

describe("tab titles still resolve after the regrouping (SCRUM-631)", () => {
  test.each([
    ["/org1/notifications", "Notifications"],
    ["/org1/settings/billing", "Billing"],
    ["/org1/settings/commission", "CommissionRules"],
    ["/org1/marketplace/requests", "MarketplaceRequests"],
    ["/org1/team", "Team"],
    ["/org1/approvals", "Approvals"],
  ])("%s is titled by %s", (pathname, name) => {
    expect(tabTitleNavItem(pathname, "org1")?.name).toBe(name);
  });

  test("a sale's deal page keeps its own title", () => {
    expect(tabTitleNavItem("/org1/sales/x/deal", "org1")).toBeNull();
  });
});