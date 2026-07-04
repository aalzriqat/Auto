"use client";

import { useEffect, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Megaphone, Sparkles, Wrench, Zap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const LAST_SEEN_KEY = "autoflow_whats_new_last_seen";

const TYPE_ICON = { FEATURE: Sparkles, FIX: Wrench, IMPROVEMENT: Zap } as const;
const TYPE_BADGE_CLASS = {
  FEATURE: "bg-violet-100 text-violet-700 border-violet-200",
  FIX: "bg-rose-100 text-rose-700 border-rose-200",
  IMPROVEMENT: "bg-blue-100 text-blue-700 border-blue-200",
} as const;

export function WhatsNewButton() {
  const { t, locale } = useLanguage();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(0);

  const latestPublishedAt = useQuery(api.changelog.getLatestPublishedAt);
  const { results: entries, status, loadMore } = usePaginatedQuery(
    api.changelog.list,
    open ? {} : "skip",
    { initialNumItems: 20 }
  );

  useEffect(() => {
    setLastSeen(Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0));
  }, []);

  const hasUnread = latestPublishedAt != null && latestPublishedAt > lastSeen;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      const now = Date.now();
      localStorage.setItem(LAST_SEEN_KEY, String(now));
      setLastSeen(now);
    }
  }

  const localeCode = locale === "ar" ? "ar-JO" : "en-US";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-10 w-10 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        aria-label={t("WhatsNew")}
        onClick={() => handleOpenChange(true)}
      >
        <Megaphone className="h-5 w-5" />
        {hasUnread && (
          <span className="absolute top-1.5 end-1.5 h-2 w-2 rounded-full bg-blue-500 border border-white" />
        )}
      </Button>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("WhatsNew")}</DialogTitle>
          <DialogDescription>{t("WhatsNewDesc")}</DialogDescription>
        </DialogHeader>

        {entries === undefined ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">{t("NoChangelogEntries")}</p>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => {
              const Icon = TYPE_ICON[entry.type];
              const title = locale === "ar" ? entry.titleAr : entry.titleEn;
              const description = locale === "ar" ? entry.descriptionAr : entry.descriptionEn;
              return (
                <div key={entry._id} className="border-b border-slate-100 pb-4 last:border-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge variant="outline" className={`gap-1 ${TYPE_BADGE_CLASS[entry.type]}`}>
                      <Icon className="w-3 h-3" />
                      {t(entry.type === "FEATURE" ? "ChangelogFeature" : entry.type === "FIX" ? "ChangelogFix" : "ChangelogImprovement")}
                    </Badge>
                    <span className="text-xs text-slate-400">
                      {new Date(entry.publishedAt).toLocaleDateString(localeCode, { year: "numeric", month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
                  <p className="text-sm text-slate-600 mt-0.5 whitespace-pre-line">{description}</p>
                </div>
              );
            })}
            {status === "CanLoadMore" && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" size="sm" onClick={() => loadMore(20)}>
                  {t("LoadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
