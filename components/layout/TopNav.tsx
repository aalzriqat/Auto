"use client";

import { Menu, Search, X, MessagesSquare } from "lucide-react";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { useMessenger } from "@/components/messages/MessengerContext";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useState, useRef } from "react";
import { mainNavigation, settingsNavigation, type NavItem } from "@/lib/navigation";

// Flat list (main + settings) used only to resolve the current page title —
// the drawer itself renders the two sections separately, same as the desktop Sidebar.
const navigation = [...mainNavigation, ...settingsNavigation];

export function TopNav() {
  const { t, isRtl } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const mobileSearchRef = useRef<HTMLInputElement>(null);

  const currentNavItem = navigation.find(item => pathname.startsWith(`/${activeOrgId}${item.href}`));
  const pageTitle = currentNavItem ? t(currentNavItem.name as any) : "AutoFlow";

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

  const { toggleList } = useMessenger();
  const unreadMessages = useQuery(
    api.directMessages.getUnreadCount,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const visibleMainNavigation = mainNavigation.filter(item => {
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  const visibleSettingsNavigation = settingsNavigation.filter(item => {
    if (item.ownerOnly) return isOwner;
    if (!item.permission) return true;
    return permissions.includes(item.permission);
  });

  const renderMobileNavItem = (item: NavItem) => {
    const href = `/${activeOrgId}${item.href}`;
    const isActive = pathname.startsWith(href);
    const isApprovals = item.name === "Approvals";
    return (
      <Link
        key={item.name}
        href={href}
        onClick={() => setIsMobileMenuOpen(false)}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "hover:bg-slate-50 text-slate-600 hover:text-slate-900"
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
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
                <nav className="flex flex-col gap-1">
                  {visibleMainNavigation.map(renderMobileNavItem)}
                </nav>

                {visibleSettingsNavigation.length > 0 && (
                  <div className="mt-4">
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      {t("Settings" as any)}
                    </p>
                    <nav className="flex flex-col gap-1 mt-1">
                      {visibleSettingsNavigation.map(renderMobileNavItem)}
                    </nav>
                  </div>
                )}
              </div>
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
          {/* Messenger button */}
          <button
            onClick={toggleList}
            className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label="Messages"
            id="topnav-messenger-btn"
          >
            <MessagesSquare className="h-5 w-5" />
            {unreadMessages != null && unreadMessages > 0 && (
              <span className="absolute -top-0.5 -end-0.5 min-w-[16px] h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 border-2 border-white">
                {unreadMessages > 9 ? "9+" : unreadMessages}
              </span>
            )}
          </button>
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
