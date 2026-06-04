"use client";

import { Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt } from "lucide-react";
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

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Vehicles", href: "/vehicles", icon: Car },
  { name: "Customers", href: "/customers", icon: Users },
  { name: "Leads", href: "/leads", icon: Target },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign },
  { name: "Expenses", href: "/expenses", icon: Receipt },
  { name: "Team", href: "/team", icon: Shield },
];

export function AppSidebar() {
  const { user } = useUser();
  // We don't have usePathname working perfectly in app router without a small trick, 
  // but let's use it from next/navigation
  const pathname = typeof window !== 'undefined' ? window.location.pathname : "";

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 flex flex-row items-center gap-3">
        <UserButton />
        <div className="flex flex-col overflow-hidden">
          <span className="text-sm font-medium truncate">{user?.fullName || "User"}</span>
          <span className="text-xs text-muted-foreground truncate">{user?.primaryEmailAddress?.emailAddress}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
