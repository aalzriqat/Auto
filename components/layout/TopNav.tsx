"use client";

import { Menu, Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList, LineChart, Settings, Store, Search } from "lucide-react";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
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
  { name: "Applications", href: "/applications", icon: ClipboardList, permission: "view:sales" },
  { name: "Sales", href: "/sales", icon: BadgeDollarSign, permission: "view:sales" },
  { name: "Tasks", href: "/tasks", icon: ClipboardList, permission: "view:tasks" },
  { name: "Expenses", href: "/expenses", icon: Receipt, permission: "view:expenses" },
  { name: "Team", href: "/team", icon: Shield, permission: "manage:users" },
  { name: "Accounting", href: "/accounting", icon: BadgeDollarSign, permission: "view:finance" },
  { name: "Reports", href: "/reports", icon: LineChart, permission: "view:reports" },
  { name: "FinanceSettings", href: "/settings/finance", icon: Settings, permission: "view:settings" },
  { name: "Branches", href: "/settings/branches", icon: Store, permission: "manage:users" },
];

export function TopNav() {
  const { t, isRtl } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];

  const visibleNavigation = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  return (
    <header className="sticky top-0 z-30 w-full border-b border-slate-200/50 bg-white/95 backdrop-blur shadow-sm h-16 flex items-center shrink-0">
      <div className="flex w-full items-center justify-between gap-4 px-4 md:px-6">

        {/* Left Side: Mobile Menu & Title & Search */}
        <div className="flex items-center gap-2 md:gap-4 flex-1">
          <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden shrink-0">
                <Menu className="h-5 w-5" />
                <span className="sr-only">{t("ToggleNavigationMenu" as any)}</span>
              </Button>
            </SheetTrigger>
            <SheetContent side={isRtl ? "right" : "left"} className="w-[280px] p-0">
              <SheetHeader className="p-6 border-b border-slate-100 text-start">
                <SheetTitle className="flex items-center gap-2">
                  <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="w-32 h-auto object-contain" priority />
                </SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 p-4">
                {visibleNavigation.map((item) => {
                  const isActive = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-slate-50 text-slate-600 hover:text-slate-900"
                      )}
                    >
                      <item.icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-slate-400")} />
                      {t(item.name as any)}
                    </Link>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>

          <div className="hidden md:flex items-center gap-6 w-full ml-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap">
              {navigation.find(item => pathname.startsWith(item.href)) ? t(navigation.find(item => pathname.startsWith(item.href))!.name as any) : "AutoFlow"}
            </h1>

            <div className="relative max-w-md w-full ml-4">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder={t("Search" as any)}
                className="pl-9 pr-4 py-2 bg-slate-100 border-transparent rounded-lg text-sm w-full focus:bg-white focus:border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          </div>
        </div>

        {/* Right Side: Tools & Profile */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:block">
            <OrgSwitcher />
          </div>
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
