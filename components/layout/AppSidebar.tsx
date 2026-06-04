"use client";

import { Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList } from "lucide-react";
import { UserButton, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Vehicles", href: "/vehicles", icon: Car, permission: "view:vehicles" },
  { name: "Customers", href: "/customers", icon: Users, permission: "view:customers" },
  { name: "Leads", href: "/leads", icon: Target, permission: "view:leads" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Team", href: "/team", icon: Shield, permission: "view:users" },
];

export function AppSidebar() {
  const { user } = useUser();
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = typeof window !== 'undefined' ? window.location.pathname : "";

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];

  const visibleNavigation = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleNavigation.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{t(item.name as any)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 flex flex-row items-center justify-between gap-2 border-t">
        <div className="flex flex-row items-center gap-3 overflow-hidden group-data-[collapsible=icon]:hidden">
          <UserButton />
          <div className="flex flex-col overflow-hidden">
            <span className="text-sm font-medium truncate">{user?.fullName || "User"}</span>
            <span className="text-xs text-muted-foreground truncate">{user?.primaryEmailAddress?.emailAddress}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
          <LanguageSwitcher />
          <NotificationsBell />
        </div>
        <div className="hidden group-data-[collapsible=icon]:flex items-center justify-center w-full">
          <UserButton />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
