"use client";

import { useMemo } from "react";
import { TopNav } from "@/components/layout/TopNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { OrgProvider, useOrg } from "@/components/providers/OrgProvider";
import { Toaster } from "@/components/ui/sonner";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { FeedbackWidget } from "@/components/feedback/FeedbackWidget";
import { SupportAccessBanner } from "@/components/support/SupportAccessBanner";
import { ImpersonationBanner } from "@/components/admin/ImpersonationBanner";
import { PresenceTracker } from "@/components/providers/PresenceTracker";
import { LocaleSync } from "@/components/providers/LocaleSync";
import { UpdateBanner } from "@/components/layout/UpdateBanner";
import { hexToHslString } from "@/lib/colorUtils";
import { MessengerProvider } from "@/components/messages/MessengerContext";
import { FloatingMessenger } from "@/components/messages/FloatingMessenger";
import { MessengerOnboarding } from "@/components/messages/MessengerOnboarding";
import { GlobalSearchOnboarding } from "@/components/search/GlobalSearchOnboarding";
import { WebsiteOnboarding } from "@/components/website/WebsiteOnboarding";

function DashboardWrapper({ children }: { children: React.ReactNode }) {
  const { activeOrgId, isLoading } = useOrg();
  const orgSettings = useOrgSettings();

  const brandStyle = useMemo(() => {
    const hsl = orgSettings?.primaryColor
      ? hexToHslString(orgSettings.primaryColor)
      : null;
    if (!hsl) return undefined;
    return { "--primary": `hsl(${hsl})` } as React.CSSProperties;
  }, [orgSettings]);

  // While the orgId from the URL is still being validated against the
  // user's memberships (or is invalid and OrgProvider is redirecting away),
  // show a loading state instead of rendering chrome for an unknown org.
  if (isLoading || !activeOrgId) {
    return (
      <div className="flex h-screen items-center justify-center bg-muted/30 flex-col gap-4">
        <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Loading your workspace...</p>
      </div>
    );
  }

  return (
    <MessengerProvider>
      <div
        className="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-zinc-950/40"
        style={brandStyle}
      >
        <PresenceTracker orgId={activeOrgId} />
        <LocaleSync />
        <Sidebar />
        <div className="flex flex-col flex-1 w-full overflow-hidden">
          <UpdateBanner />
          <SupportAccessBanner />
          <ImpersonationBanner />
          <TopNav />
          <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 relative pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-8">
            {children}
          </main>
        </div>
        <Toaster />
        <FeedbackWidget />
        <FloatingMessenger orgId={activeOrgId} />
        <MessengerOnboarding />
        <GlobalSearchOnboarding />
        <WebsiteOnboarding />
      </div>
    </MessengerProvider>
  );
}

export default function OrgDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgProvider>
      <DashboardWrapper>{children}</DashboardWrapper>
    </OrgProvider>
  );
}
