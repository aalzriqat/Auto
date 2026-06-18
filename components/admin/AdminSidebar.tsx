"use client";

import { LayoutDashboard, Building2, Users, Database, History, Inbox, Headset } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Overview", href: "/admin", icon: LayoutDashboard },
  { name: "Organizations", href: "/admin/organizations", icon: Building2 },
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Data Browser", href: "/admin/data", icon: Database },
  { name: "Support Inbox", href: "/admin/support", icon: Inbox },
  { name: "Support Agents", href: "/admin/support-agents", icon: Headset },
  { name: "Audit Log", href: "/admin/audit", icon: History },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-64 border-e border-slate-800 bg-slate-900 shrink-0">
      <div className="h-16 flex items-center px-6 border-b border-slate-800 shrink-0">
        <span className="text-sm font-semibold text-white tracking-wide">AutoFlow · Super Admin</span>
      </div>
      <nav className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
        {navigation.map((item) => {
          const isActive = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                isActive ? "bg-amber-500/15 text-amber-400" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              )}
            >
              <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-amber-400" : "text-slate-500")} />
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-slate-800">
        <p className="text-[10px] text-slate-500">Cross-tenant access — every action here is audit-logged.</p>
      </div>
    </aside>
  );
}
