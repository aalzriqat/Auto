"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";

export function SupportAccessBanner() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const grant = useQuery(api.liveChat.getActiveOrgAccessGrant, activeOrgId ? { orgId: activeOrgId } : "skip");

  if (!grant) return null;

  const time = new Date(grant.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="w-full bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-center text-xs sm:text-sm text-amber-700 dark:text-amber-300 shrink-0">
      {t("SupportAccessBannerText").replace("{time}", time)}
    </div>
  );
}
