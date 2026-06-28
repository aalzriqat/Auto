"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
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
    <div
      role="status"
      aria-live="polite"
      className="w-full shrink-0 border-b border-amber-600 bg-amber-400 px-4 py-3 text-slate-950 shadow-sm"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-amber-300 shadow-sm">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <p className="text-sm font-semibold leading-snug sm:text-base">
            {t("UpdateBannerMessage" as any)}{" "}
            <span className="block text-sm font-medium text-slate-800 sm:inline">
              {t("UpdateBannerWarning" as any)}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2">
          <Button
            size="sm"
            className="h-9 bg-slate-950 px-4 text-sm font-semibold text-white shadow hover:bg-slate-800"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-4 w-4" /> {t("UpdateBannerButton" as any)}
          </Button>
          <button
            onClick={() => setDismissed(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-800 transition-colors hover:bg-amber-300 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
            aria-label={t("UpdateBannerDismiss" as any)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
