"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Id } from "@/convex/_generated/dataModel";

export type RunAmortizationNowResult = {
  posted: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; monthsPosted: number }>;
  blocked: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; reason: string }>;
  failed: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; error: string }>;
  upToDateCount: number;
  scheduleCount: number;
};

export function RunNowResultsDialog({
  result,
  onOpenChange,
}: Readonly<{
  result: RunAmortizationNowResult;
  onOpenChange: (open: boolean) => void;
}>) {
  const { t } = useLanguage();
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("RunNowResultsTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {result.posted.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-emerald-600 dark:text-emerald-400">{t("RunNowPostedSection")}</p>
              {result.posted.map((r) => (
                <div key={r.scheduleId} className="flex justify-between text-muted-foreground">
                  <span>{r.title}</span>
                  <span>{t("RunNowMonthsPosted").replace("{count}", String(r.monthsPosted))}</span>
                </div>
              ))}
            </div>
          )}
          {result.blocked.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-amber-600 dark:text-amber-400">{t("RunNowBlockedSection")}</p>
              {result.blocked.map((r) => (
                <div key={r.scheduleId} className="text-muted-foreground">
                  <span className="font-medium">{r.title}</span>: {r.reason}
                </div>
              ))}
            </div>
          )}
          {result.failed.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-rose-600 dark:text-rose-400">{t("RunNowFailedSection")}</p>
              {result.failed.map((r) => (
                <div key={r.scheduleId} className="text-muted-foreground">
                  <span className="font-medium">{r.title}</span>: {r.error}
                </div>
              ))}
            </div>
          )}
          {result.upToDateCount > 0 && (
            <p className="text-muted-foreground">{t("RunNowUpToDateCount").replace("{count}", String(result.upToDateCount))}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
