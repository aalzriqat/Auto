import {
  Car,
  Users,
  LayoutDashboard,
  Target,
  BadgeDollarSign,
  Shield,
  Receipt,
  ClipboardList,
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
  Camera,
  MessageCircle,
  Bell,
  Globe2,
  CreditCard,
  Truck,
  Handshake,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Permission string required to see this item. Omit for always-visible items. */
  permission?: string;
  /** When true, only the OWNER role may see this item — overrides `permission`. */
  ownerOnly?: boolean;
}

/** Primary navigation, shown in both the desktop sidebar and the mobile drawer. */
export const mainNavigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "manage:users" },
  { name: "Vehicles", href: "/vehicles", icon: Car, permission: "view:vehicles" },
  { name: "Customers", href: "/customers", icon: Users, permission: "view:customers" },
  { name: "Leads", href: "/leads", icon: Target, permission: "view:leads" },
  { name: "SocialInbox", href: "/social-inbox", icon: MessageCircle, permission: "view:leads" },
  { name: "FinanceApplications", href: "/applications", icon: ClipboardList, permission: "view:sales" },
  { name: "Sourcing", href: "/sourcing", icon: Truck, permission: "view:finance" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Commissions", href: "/commissions", icon: TrendingUp, permission: "view:commissions" },
  { name: "Payroll", href: "/payroll", icon: Wallet, permission: "view:payroll" },
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Accounting", href: "/accounting", icon: BookOpen, permission: "view:finance" },
  { name: "Reports", href: "/reports", icon: LineChart, permission: "view:reports" },
  { name: "Approvals", href: "/approvals", icon: Shield, permission: "manage:users" },
  { name: "MarketplaceRequests", href: "/marketplace/requests", icon: Handshake, permission: "marketplace:respond" },
];

// Every /settings/* route is gated to the OWNER role at the layout level
// (app/(dashboard)/[orgId]/settings/layout.tsx uses RoleGuard ownerOnly),
// since settings administration can't be delegated. "Team" is the
// exception — it lives outside /settings and gates itself internally
// (Members tab stays open to anyone with manage:users; only its own
// Roles & Permissions tab is OWNER-only).
export const settingsNavigation: NavItem[] = [
  { name: "Team", href: "/team", icon: Users, permission: "manage:users" },
  { name: "GeneralSettings", href: "/settings/general", icon: Settings, ownerOnly: true },
  { name: "FinanceSettings", href: "/settings/finance", icon: Building2, ownerOnly: true },
  { name: "Pipeline", href: "/settings/pipeline", icon: GitBranch, ownerOnly: true },
  { name: "LeadSources", href: "/settings/lead-sources", icon: Sliders, ownerOnly: true },
  { name: "CustomFields", href: "/settings/custom-fields", icon: FormInput, ownerOnly: true },
  { name: "Commission", href: "/settings/commission", icon: Percent, ownerOnly: true },
  { name: "Branches", href: "/settings/branches", icon: Store, ownerOnly: true },
  { name: "Integrations", href: "/settings/integrations", icon: Camera, ownerOnly: true },
  { name: "Website", href: "/settings/website", icon: Globe2, ownerOnly: true },
  { name: "MarketplaceSettingsTitle", href: "/settings/marketplace", icon: Handshake, ownerOnly: true },
  { name: "FeedbackInbox", href: "/settings/feedback", icon: MessageSquarePlus, ownerOnly: true },
  { name: "Billing", href: "/settings/billing", icon: CreditCard, ownerOnly: true },
];
