import {
  Car,
  Users,
  LayoutDashboard,
  Target,
  BadgeDollarSign,
  Shield,
  Receipt,
  ListChecks,
  FileText,
  UserCog,
  Plug,
  Network,
  LineChart,
  Settings,
  Store,
  BookOpen,
  TrendingUp,
  Sliders,
  GitBranch,
  FormInput,
  Percent,
  Wallet,
  Building2,
  MessageSquarePlus,
  MessageCircle,
  Bell,
  Globe2,
  CreditCard,
  Truck,
  Handshake,
  type LucideIcon,
} from "lucide-react";

/**
 * The sidebar sections (SCRUM-890). A new nav item joins a section by naming
 * its id in the item's own `group` field, which is the only line it needs.
 */
export type NavGroupId = "overview" | "customersSales" | "inventorySourcing" | "financeReports" | "settings";

/**
 * Where an item is rendered. `sidebar` (the default) is the grouped list in the
 * desktop sidebar and the mobile drawer. `header` items live in the top bar
 * (Notifications: the bell) and `footer` items in the plan card (Billing); both
 * stay in the catalog so permissions, tab titles and audits still see them.
 */
export type NavPlacement = "sidebar" | "header" | "footer";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** The sidebar section this item belongs to. */
  group: NavGroupId;
  /** Where the item is rendered; omit for the sidebar. */
  placement?: NavPlacement;
  /** Permission string required to see this item. Omit for always-visible items. */
  permission?: string;
  /**
   * Visible to a member holding ANY of these. Used where two different roles
   * do different work on the same screen: Approvals is the profit-approval
   * queue for `approve:requests` AND the deposit-request queue for whoever may
   * confirm receipt (`confirm:finance_disbursement`, i.e. accountants), and
   * gating it on `manage:users` alone left accountants with no way in
   * (SCRUM-444). When present it replaces `permission`.
   */
  anyPermission?: readonly string[];
  /** When true, only the OWNER role may see this item — overrides `permission`. */
  ownerOnly?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  /** Translation key of the section caption; omit for the uncaptioned top block. */
  captionKey?: string;
  /** Only Settings collapses: daily-work sections stay open so nothing is hidden. */
  collapsible?: boolean;
}

/** Sidebar sections in display order. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "overview" },
  { id: "customersSales", captionKey: "NavGroupCustomersSales" },
  { id: "inventorySourcing", captionKey: "NavGroupInventorySourcing" },
  { id: "financeReports", captionKey: "NavGroupFinanceReports" },
  { id: "settings", captionKey: "Settings", collapsible: true },
];

/**
 * Primary navigation. Array order is display order within a group, so keep each
 * group's items together. Notifications is reached from the header bell.
 */
export const mainNavigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, group: "overview", permission: "manage:users" },
  { name: "Tasks", href: "/tasks", icon: ListChecks, group: "overview", permission: "view:tasks" },
  {
    name: "Approvals",
    href: "/approvals",
    icon: Shield,
    group: "overview",
    anyPermission: ["approve:requests", "confirm:finance_disbursement"],
  },
  { name: "Notifications", href: "/notifications", icon: Bell, group: "overview", placement: "header" },
  { name: "Leads", href: "/leads", icon: Target, group: "customersSales", permission: "view:leads" },
  { name: "SocialInbox", href: "/social-inbox", icon: MessageCircle, group: "customersSales", permission: "view:leads" },
  { name: "Customers", href: "/customers", icon: Users, group: "customersSales", permission: "view:customers" },
  // The Deals list is the one entry into every deal, cash or financed; the
  // legacy `/applications` list stays reachable by URL (SCRUM-215).
  { name: "DealsTitle", href: "/deals", icon: FileText, group: "customersSales", permission: "view:sales" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, group: "customersSales", permission: "view:sales" },
  { name: "Vehicles", href: "/vehicles", icon: Car, group: "inventorySourcing", permission: "view:vehicles" },
  { name: "Sourcing", href: "/sourcing", icon: Truck, group: "inventorySourcing", permission: "view:finance" },
  {
    name: "MarketplaceRequests",
    href: "/marketplace/requests",
    icon: Handshake,
    group: "inventorySourcing",
    permission: "marketplace:respond",
  },
  { name: "Accounting", href: "/accounting", icon: BookOpen, group: "financeReports", permission: "view:finance" },
  { name: "Expenses", href: "/expenses", icon: Receipt, group: "financeReports", permission: "view:expenses" },
  { name: "Commissions", href: "/commissions", icon: TrendingUp, group: "financeReports", permission: "view:commissions" },
  { name: "Payroll", href: "/payroll", icon: Wallet, group: "financeReports", permission: "view:payroll" },
  { name: "Reports", href: "/reports", icon: LineChart, group: "financeReports", permission: "view:reports" },
];

// Every /settings/* route is gated to the OWNER role at the layout level
// (app/(dashboard)/[orgId]/settings/layout.tsx uses RoleGuard ownerOnly),
// since settings administration can't be delegated. "Team" is the
// exception — it lives outside /settings and gates itself internally
// (Members tab stays open to anyone with manage:users; only its own
// Roles & Permissions tab is OWNER-only). Billing is the plan card in the
// sidebar footer.
export const settingsNavigation: NavItem[] = [
  { name: "Team", href: "/team", icon: UserCog, group: "settings", permission: "manage:users" },
  { name: "GeneralSettings", href: "/settings/general", icon: Settings, group: "settings", ownerOnly: true },
  { name: "Branches", href: "/settings/branches", icon: Store, group: "settings", ownerOnly: true },
  { name: "FinanceSettings", href: "/settings/finance", icon: Building2, group: "settings", ownerOnly: true },
  { name: "Pipeline", href: "/settings/pipeline", icon: GitBranch, group: "settings", ownerOnly: true },
  { name: "LeadSources", href: "/settings/lead-sources", icon: Sliders, group: "settings", ownerOnly: true },
  { name: "CustomFields", href: "/settings/custom-fields", icon: FormInput, group: "settings", ownerOnly: true },
  // "Commission rules" (not "Commission"): the earned Commissions screen is in Finance.
  { name: "CommissionRules", href: "/settings/commission", icon: Percent, group: "settings", ownerOnly: true },
  { name: "Integrations", href: "/settings/integrations", icon: Plug, group: "settings", ownerOnly: true },
  { name: "Website", href: "/settings/website", icon: Globe2, group: "settings", ownerOnly: true },
  { name: "MarketplaceSettingsTitle", href: "/settings/marketplace", icon: Network, group: "settings", ownerOnly: true },
  { name: "FeedbackInbox", href: "/settings/feedback", icon: MessageSquarePlus, group: "settings", ownerOnly: true },
  { name: "Billing", href: "/settings/billing", icon: CreditCard, group: "settings", placement: "footer", ownerOnly: true },
];

/** Whether a member holding `permissions` may see `item` (ownerOnly is handled by callers). */
export function navItemPermitted(item: NavItem, permissions: readonly string[]): boolean {
  if (item.anyPermission) return item.anyPermission.some((p) => permissions.includes(p));
  if (!item.permission) return true;
  return permissions.includes(item.permission);
}

/**
 * The one visibility rule for every nav surface: an owner-only item is for the
 * qualified OWNER role alone and ignores `permission`; every other item follows
 * `navItemPermitted`.
 */
export function isNavItemVisible(item: NavItem, permissions: readonly string[], isOwner: boolean): boolean {
  if (item.ownerOnly) return isOwner;
  return navItemPermitted(item, permissions);
}

export interface VisibleNavGroup {
  group: NavGroup;
  items: NavItem[];
}

/** Where `item` is rendered (the sidebar unless it says otherwise). */
export function navPlacementOf(item: NavItem): NavPlacement {
  return item.placement ?? "sidebar";
}

/**
 * The sidebar sections this member sees, in display order, with sections that
 * have nothing visible dropped. Header and footer items are not part of it; see
 * `visibleFooterNavItems`.
 */
export function visibleNavGroups(permissions: readonly string[], isOwner: boolean): VisibleNavGroup[] {
  const catalog = [...mainNavigation, ...settingsNavigation];
  return NAV_GROUPS.map((group) => ({
    group,
    items: catalog.filter(
      (item) =>
        item.group === group.id &&
        navPlacementOf(item) === "sidebar" &&
        isNavItemVisible(item, permissions, isOwner)
    ),
  })).filter((section) => section.items.length > 0);
}

/** Footer items (the owner's plan card) this member sees. */
export function visibleFooterNavItems(permissions: readonly string[], isOwner: boolean): NavItem[] {
  return [...mainNavigation, ...settingsNavigation].filter(
    (item) => navPlacementOf(item) === "footer" && isNavItemVisible(item, permissions, isOwner)
  );
}

/**
 * Whether `pathname` is on `href` or beneath it. Matching on a path-segment
 * boundary keeps `/org/sales-reports` from lighting up `/org/sales`.
 */
export function isNavPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Routes nested under a nav section that are a different kind of page and
 * export their own title: a sale's deal page lives under /sales but is a deal.
 */
const OWN_TITLE_ROUTES: readonly RegExp[] = [/\/sales\/[^/]+\/deal\/?$/];

/**
 * The nav section whose localized name titles the browser tab for `pathname`
 * (SCRUM-631), or null when the route's own metadata title should stand —
 * off-nav routes, the routes above, and before the org is known.
 */
export function tabTitleNavItem(pathname: string, orgId: string | null | undefined): NavItem | null {
  if (!orgId) return null;
  if (OWN_TITLE_ROUTES.some((route) => route.test(pathname))) return null;
  return (
    [...mainNavigation, ...settingsNavigation].find((item) =>
      pathname.startsWith(`/${orgId}${item.href}`)
    ) ?? null
  );
}
