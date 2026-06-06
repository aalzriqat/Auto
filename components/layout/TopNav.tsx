"use client";

import { Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList, Menu, LineChart } from "lucide-react";
import { UserButton, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "manage:users" },
  { name: "Vehicles", href: "/vehicles", icon: Car, permission: "view:vehicles" },
  { name: "Customers", href: "/customers", icon: Users, permission: "view:customers" },
  { name: "Leads", href: "/leads", icon: Target, permission: "view:leads" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Team", href: "/team", icon: Shield, permission: "manage:users" },
  { name: "Reports", href: "/reports", icon: LineChart, permission: "view:reports" },
];

export function TopNav() {
  const { user } = useUser();
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = typeof window !== 'undefined' ? window.location.pathname : "";
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];

  const visibleNavigation = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="flex w-full h-14 items-center justify-between gap-4 px-4 md:px-6 lg:px-8">
        
        {/* Left Side: Mobile Menu & Logo / Org Switcher */}
        <div className="flex items-center gap-2 md:gap-4">
          <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden shrink-0">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[280px] sm:w-[300px]">
              <SheetHeader>
                <SheetTitle className="text-left">Navigation</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-2 mt-4">
                {visibleNavigation.map((item) => {
                  const isActive = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                        isActive 
                          ? "bg-primary/10 text-primary" 
                          : "hover:bg-muted text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {t(item.name as any)}
                    </Link>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2">
            {/* You can add a text logo or image here if desired */}
            <OrgSwitcher />
          </div>
        </div>

        {/* Center: Desktop Navigation */}
        <nav className="hidden md:flex items-center gap-1 lg:gap-2 absolute left-1/2 -translate-x-1/2">
          {visibleNavigation.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-full text-sm font-medium transition-colors",
                  isActive 
                    ? "bg-primary/10 text-primary" 
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                <span className="hidden lg:inline">{t(item.name as any)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right Side: Tools & Profile */}
        <div className="flex items-center gap-2 shrink-0">
          <LanguageSwitcher />
          <NotificationsBell />
          <div className="ml-2 flex items-center justify-center">
            <UserButton />
          </div>
        </div>
      </div>
    </header>
  );
}
