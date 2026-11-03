"use client";

import { Menu, Search, MessagesSquare, MessageSquarePlus } from "lucide-react";
import { openFeedbackPanel } from "@/components/feedback/feedbackWidgetStore";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { WhatsNewButton } from "@/components/layout/WhatsNewButton";
import { MESSENGER_TRIGGER_ID, useMessenger } from "@/components/messages/MessengerContext";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import GlobalSearchModal from "@/components/search/GlobalSearchModal";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useState } from "react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { mainNavigation, settingsNavigation, tabTitleNavItem } from "@/lib/navigation";
import { NavSections, PlanCard } from "@/components/layout/NavSections";

// Flat list (main + settings) used only to resolve the current page title —
// the drawer renders the grouped sections through the same NavSections as the desktop Sidebar.
const navigation = [...mainNavigation, ...settingsNavigation];

export function TopNav() {
  const { t, isRtl } = useLanguage();
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const currentNavItem = navigation.find(item => pathname.startsWith(`/${activeOrgId}${item.href}`));
  const pageTitle = currentNavItem ? t(currentNavItem.name as any) : "AutoFlow";
  // SCRUM-631: the tab says which section this is, in the user's language. Off-nav
  // routes and the deal pages keep their own metadata title.
  const titleNavItem = tabTitleNavItem(pathname, activeOrgId);
  // Same list and match order as `currentNavItem`, so `pageTitle` is its name.
  useDocumentTitle(titleNavItem ? `${pageTitle} | AutoFlow` : null);

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];
  const isOwner = myMembership?.isSystemOwnerRole === true;
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const canSeeApprovals = permissions.includes("approve:requests");
  const pendingCount = useQuery(
    api.approvals.countPending,
    activeOrgId && canSeeApprovals ? { orgId: activeOrgId } : "skip"
  );

  const { toggleList, isListOpen } = useMessenger();
  const unreadMessages = useQuery(
    api.directMessages.getUnreadCount,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  return (
    <header className="sticky top-0 z-30 w-full border-b border-slate-200/50 bg-white/95 backdrop-blur shadow-sm shrink-0">
      <GlobalSearchModal open={searchOpen} onOpenChange={setSearchOpen} />
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
              <SheetHeader className="h-16 justify-center space-y-0 px-4 py-0 border-b border-slate-100 text-start shrink-0">
                <SheetTitle className="flex items-center justify-center">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Organization Logo" className="h-10 w-auto max-w-[160px] object-contain" />
                  ) : (
                    <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="h-10 w-auto max-w-[160px] object-contain" priority />
                  )}
                </SheetTitle>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto px-3 pt-3 pb-4">
                <NavSections
                  permissions={permissions}
                  isOwner={isOwner}
                  density="drawer"
                  badges={{ Approvals: pendingCount }}
                  onNavigate={() => setIsMobileMenuOpen(false)}
                />
              </div>
              <div className="shrink-0 border-t border-slate-100 p-3 flex flex-col gap-2">
                <PlanCard
                  permissions={permissions}
                  isOwner={isOwner}
                  density="drawer"
                  onNavigate={() => setIsMobileMenuOpen(false)}
                />
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    openFeedbackPanel();
                  }}
                  className="flex h-11 w-full items-center gap-3 px-3 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  <span className="flex-1 text-start">{t("FeedbackWidgetTitle" as any)}</span>
                </button>
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
                placeholder={t("SearchPlaceholder" as any)}
                onClick={() => setSearchOpen(true)}
                readOnly
                className="ps-9 pe-14 py-2 bg-slate-100 border-transparent rounded-lg text-sm w-full cursor-pointer focus:bg-white focus:border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
              <span className="absolute end-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                ⌘K
              </span>
            </div>
          </div>
        </div>

        {/* Right: mobile search toggle + org + lang + bell + user */}
        <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-10 w-10"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <OrgSwitcher />
          <LanguageSwitcher />
          {/* Messenger button — the only entry to the conversation list (no floating button, SCRUM-612) */}
          <button
            type="button"
            onClick={toggleList}
            className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label={t("Messages" as any)}
            aria-expanded={isListOpen}
            id={MESSENGER_TRIGGER_ID}
          >
            <MessagesSquare className="h-5 w-5" />
            {unreadMessages != null && unreadMessages > 0 && (
              <span className="absolute -top-0.5 -end-0.5 min-w-[16px] h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 border-2 border-white">
                {unreadMessages > 9 ? "9+" : unreadMessages}
              </span>
            )}
          </button>
          {/* Feedback — desktop top bar; on phones it lives in the menu drawer */}
          <button
            type="button"
            onClick={openFeedbackPanel}
            className="hidden md:inline-flex p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label={t("FeedbackWidgetTitle" as any)}
            title={t("FeedbackWidgetTitle" as any)}
          >
            <MessageSquarePlus className="h-5 w-5" />
          </button>
          <WhatsNewButton />
          <NotificationsBell />
          <div className="flex items-center justify-center">
            <UserButton />
          </div>
        </div>
      </div>

    </header>
  );
}
