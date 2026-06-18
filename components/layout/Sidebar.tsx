"use client";

import { Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList, LineChart, Settings, Store, BookOpen, TrendingUp, Sliders, GitBranch, FormInput, Percent, Building2, MessageSquarePlus } from "lucide-react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "manage:users" },
  { name: "Vehicles", href: "/vehicles", icon: Car, permission: "view:vehicles" },
  { name: "Customers", href: "/customers", icon: Users, permission: "view:customers" },
  { name: "Leads", href: "/leads", icon: Target, permission: "view:leads" },
  { name: "FinanceApplications", href: "/applications", icon: ClipboardList, permission: "view:sales" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Commissions", href: "/commissions", icon: TrendingUp, permission: "view:commissions" },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Accounting", href: "/accounting", icon: BookOpen, permission: "view:finance" },
  { name: "Reports", href: "/reports", icon: LineChart, permission: "view:reports" },
  { name: "Approvals", href: "/approvals", icon: Shield, permission: "manage:users" },
];

// Every /settings/* route is gated to the OWNER role at the layout level
// (app/(dashboard)/[orgId]/settings/layout.tsx uses RoleGuard ownerOnly),
// since settings administration can't be delegated. "Team" is the
// exception — it lives outside /settings and gates itself internally
// (Members tab stays open to anyone with manage:users; only its own
// Roles & Permissions tab is OWNER-only).
const settingsNavigation = [
  { name: "Team", href: "/team", icon: Users, permission: "manage:users" },
  { name: "GeneralSettings", href: "/settings/general", icon: Settings, ownerOnly: true },
  { name: "FinanceSettings", href: "/settings/finance", icon: Building2, ownerOnly: true },
  { name: "Pipeline", href: "/settings/pipeline", icon: GitBranch, ownerOnly: true },
  { name: "LeadSources", href: "/settings/lead-sources", icon: Sliders, ownerOnly: true },
  { name: "CustomFields", href: "/settings/custom-fields", icon: FormInput, ownerOnly: true },
  { name: "Commission", href: "/settings/commission", icon: Percent, ownerOnly: true },
  { name: "Branches", href: "/settings/branches", icon: Store, ownerOnly: true },
  { name: "FeedbackInbox", href: "/settings/feedback", icon: MessageSquarePlus, ownerOnly: true },
];

export function Sidebar() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];
  const isOwner = myMembership?.roleName === "OWNER";
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const canSeeApprovals = permissions.includes("approve:requests");
  const pendingCount = useQuery(
    api.approvals.countPending,
    activeOrgId && canSeeApprovals ? { orgId: activeOrgId } : "skip"
  );

  const visibleNav = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  const visibleSettings = settingsNavigation.filter(item => {
    if ((item as { ownerOnly?: boolean }).ownerOnly) return isOwner;
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  const renderNavItem = (item: { name: string; href: string; icon: typeof navigation[0]["icon"] }) => {
    const href = `/${activeOrgId}${item.href}`;
    const isActive = pathname.startsWith(href);
    const isApprovals = item.name === "Approvals";

    return (
      <Link
        key={item.name}
        href={href}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        )}
      >
        <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "text-slate-400")} />
        <span className="flex-1">{t(item.name as any)}</span>
        {isApprovals && pendingCount != null && pendingCount > 0 && (
          <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
            {pendingCount}
          </span>
        )}
      </Link>
    );
  };

  return (
    <aside className="hidden md:flex flex-col w-64 border-e border-slate-200/50 bg-white shadow-sm shrink-0">
      <div className="h-20 flex items-center px-6 border-b border-slate-200/50 shrink-0">
        <Link href={`/${activeOrgId}/dashboard`} className="flex items-center gap-2">
          {logoUrl ? (
            <img src={logoUrl} alt="Organization Logo" className="w-28 h-auto object-contain max-h-12" />
          ) : (
            <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="w-28 h-auto object-contain" priority />
          )}
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
        <nav className="flex flex-col gap-1">
          {visibleNav.map(renderNavItem)}
        </nav>

        {visibleSettings.length > 0 && (
          <div className="mt-4">
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("Settings" as any)}
            </p>
            <nav className="flex flex-col gap-1 mt-1">
              {visibleSettings.map(renderNavItem)}
            </nav>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-slate-200/50">
        <div className="rounded-xl bg-slate-50 p-4 border border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-1">{t("AutoFlowPro" as any)}</p>
          <p className="text-[10px] text-slate-400">{t("DealershipPlanActive" as any)}</p>
        </div>
      </div>
    </aside>
  );
}
