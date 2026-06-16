"use client";

import { Menu, Car, Users, LayoutDashboard, Target, BadgeDollarSign, Shield, Receipt, ClipboardList, LineChart, Settings, Store, Search, X } from "lucide-react";
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
import { useState, useRef } from "react";

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
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const mobileSearchRef = useRef<HTMLInputElement>(null);

  const currentNavItem = navigation.find(item => pathname.startsWith(item.href));
  const pageTitle = currentNavItem ? t(currentNavItem.name as any) : "AutoFlow";

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const visibleNavigation = navigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  return (
    <header className="sticky top-0 z-30 w-full border-b border-slate-200/50 bg-white/95 backdrop-blur shadow-sm shrink-0">
      {/* Main nav bar */}
      <div className="h-14 md:h-16 flex w-full items-center justify-between gap-2 px-3 md:px-6">

        {/* Left: Mobile Menu + Page Title / Desktop Title + Search */}
        <div className="flex items-center gap-2 md:gap-4 flex-1 min-w-0">
          <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden shrink-0">
                <Menu className="h-5 w-5" />
                <span className="sr-only">{t("ToggleNavigationMenu" as any)}</span>
              </Button>
            </SheetTrigger>
            <SheetContent side={isRtl ? "right" : "left"} className="w-[280px] p-0 flex flex-col">
              <SheetHeader className="p-4 border-b border-slate-100 text-start shrink-0">
                <SheetTitle className="flex items-center gap-2">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Organization Logo" className="w-28 h-auto object-contain max-h-10" />
                  ) : (
                    <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="w-28 h-auto object-contain max-h-10" priority />
                  )}
                </SheetTitle>
              </SheetHeader>
              <nav className="flex-1 overflow-y-auto flex flex-col gap-1 p-3">
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

          {/* Mobile: page title */}
          <h1 className="text-sm font-bold tracking-tight text-slate-900 truncate md:hidden">
            {pageTitle}
          </h1>

          {/* Desktop: title + search */}
          <div className="hidden md:flex items-center gap-6 w-full ms-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap">
              {pageTitle}
            </h1>
            <div className="relative max-w-md w-full ms-4">
              <Search className="absolute start-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder={t("Search" as any)}
                className="ps-9 pe-4 py-2 bg-slate-100 border-transparent rounded-lg text-sm w-full focus:bg-white focus:border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          </div>
        </div>

        {/* Right: mobile search toggle + org + lang + bell + user */}
        <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-10 w-10"
            onClick={() => {
              setIsMobileSearchOpen(v => !v);
              if (!isMobileSearchOpen) setTimeout(() => mobileSearchRef.current?.focus(), 50);
            }}
          >
            {isMobileSearchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
          </Button>
          <OrgSwitcher />
          <LanguageSwitcher />
          <NotificationsBell />
          <div className="flex items-center justify-center">
            <UserButton />
          </div>
        </div>
      </div>

      {/* Mobile search bar — expands below the nav row */}
      {isMobileSearchOpen && (
        <div className="md:hidden px-3 pb-3">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              ref={mobileSearchRef}
              type="text"
              placeholder={t("Search" as any)}
              className="ps-9 pe-4 py-2 bg-slate-100 border-transparent rounded-lg text-sm w-full focus:bg-white focus:border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>
        </div>
      )}
    </header>
  );
}
