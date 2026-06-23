"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, X } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";

// A new build only happens on deploys, not continuously — so this checks far
// less often than presence (PresenceTracker.tsx), and hits a static env-var
// route handler, not Convex, so it has no bearing on database usage.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function UpdateBanner() {
  const { t } = useLanguage();
  const [newBuildAvailable, setNewBuildAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/build-id", { cache: "no-store" });
      if (!res.ok) return;
      const { buildSha } = (await res.json()) as { buildSha: string };
      const current = process.env.NEXT_PUBLIC_BUILD_SHA;
      // "dev" means local/non-Vercel build — there's no meaningful "latest" to compare against.
      if (current && current !== "dev" && buildSha !== current) {
        setNewBuildAvailable(true);
      }
    } catch {
      // Offline or a transient network blip — next interval will retry.
    }
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [check]);

  if (!newBuildAvailable || dismissed) return null;

  return (
    <div className="w-full bg-primary/10 border-b border-primary/20 px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs sm:text-sm shrink-0">
      <span>
        {t("UpdateBannerMessage" as any)}{" "}
        <span className="text-muted-foreground">{t("UpdateBannerWarning" as any)}</span>
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          className="h-6 px-2 text-xs gap-1"
          onClick={() => window.location.reload()}
        >
          <RefreshCw className="h-3 w-3" /> {t("UpdateBannerButton" as any)}
        </Button>
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("UpdateBannerDismiss" as any)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
