"use client";

import { Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList, LineChart, Settings, Store } from "lucide-react";
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
  { name: "Applications", href: "/applications", icon: ClipboardList, permission: "view:sales" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Team", href: "/team", icon: Shield, permission: "manage:users" },
  { name: "Accounting", href: "/accounting", icon: BadgeDollarSign, permission: "view:finance" },
  { name: "Reports", href: "/reports", icon: LineChart, permission: "view:reports" },
  { name: "Finance Settings", href: "/settings/finance", icon: Settings, permission: "view:settings" },
  { name: "Branches", href: "/settings/branches", icon: Store, permission: "manage:users" },
];

export function Sidebar() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];

  const visibleNavigation = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  return (
    <aside className="hidden md:flex flex-col w-64 border-e border-slate-200/50 bg-white shadow-sm shrink-0">
      <div className="h-20 flex items-center px-6 border-b border-slate-200/50 shrink-0">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="w-28 h-auto object-contain" priority />
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto py-6 px-3">
        <nav className="flex flex-col gap-1">
          {visibleNavigation.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <item.icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-slate-400")} />
                {t(item.name as any)}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200/50">
        <div className="rounded-xl bg-slate-50 p-4 border border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-1">AutoFlow PRO</p>
          <p className="text-[10px] text-slate-400">Dealership Plan Active</p>
        </div>
      </div>
    </aside>
  );
}
