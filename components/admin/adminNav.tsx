"use client";

import {
  LayoutDashboard,
  Building2,
  Users,
  Database,
  ClipboardCheck,
  History,
  Inbox,
  Headset,
  Megaphone,
  MessageSquarePlus,
  ScrollText,
  BarChart3,
  Handshake,
  type LucideIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

type NavItem = { name: string; href: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ name: "Dashboard", href: "/admin", icon: LayoutDashboard }],
  },
  {
    label: "Tenants",
    items: [
      { name: "Organizations", href: "/admin/organizations", icon: Building2 },
      { name: "Users", href: "/admin/users", icon: Users },
      { name: "Reviews", href: "/admin/reviews", icon: ClipboardCheck },
      { name: "Data Browser", href: "/admin/data", icon: Database },
    ],
  },
  {
    label: "Growth",
    items: [
      { name: "Analytics", href: "/admin/analytics", icon: BarChart3 },
      { name: "Marketplace", href: "/admin/marketplace", icon: Handshake },
    ],
  },
  {
    label: "Communications",
    items: [
      { name: "Notifications", href: "/admin/notifications", icon: Megaphone },
      { name: "Changelog", href: "/admin/changelog", icon: ScrollText },
      { name: "Feedback", href: "/admin/feedback", icon: MessageSquarePlus },
    ],
  },
  {
    label: "Support",
    items: [
      { name: "Support Inbox", href: "/admin/support", icon: Inbox },
      { name: "Support Agents", href: "/admin/support-agents", icon: Headset },
    ],
  },
  {
    label: "System",
    items: [{ name: "Audit Log", href: "/admin/audit", icon: History }],
  },
];

/** Flat lookup of the current page's title, for the mobile top bar. */
export function useActiveNavTitle(): string {
  const pathname = usePathname();
  const all = navGroups.flatMap((g) => g.items);
  const match = all
    .filter((i) => (i.href === "/admin" ? pathname === "/admin" : pathname.startsWith(i.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.name ?? "Admin";
}

export function AdminNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6">
      {navGroups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group.label}
          </p>
          {group.items.map((item) => {
            const isActive =
              item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    isActive ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground"
                  )}
                />
                {item.name}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
