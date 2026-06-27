"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bug, Lightbulb, Loader2, ExternalLink, MessageSquare } from "lucide-react";
import { format } from "date-fns";

export default function FeedbackInboxPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const [typeFilter, setTypeFilter] = useState<"ALL" | "BUG" | "FEATURE">("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");

  const items = useQuery(
    api.feedback.myList,
    activeOrgId
      ? {
          orgId: activeOrgId,
          type: typeFilter !== "ALL" ? (typeFilter as "BUG" | "FEATURE") : undefined,
          status: statusFilter !== "ALL" ? (statusFilter as "OPEN" | "CLOSED") : undefined,
        }
      : "skip"
  );

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("FeedbackPageTitle" as any)}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("FeedbackPageDesc" as any)}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {(["ALL", "BUG", "FEATURE"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setTypeFilter(f)}
            className={`rounded-full px-3 py-1 text-sm font-medium border transition-colors ${
              typeFilter === f
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:bg-muted"
            }`}
          >
            {f === "ALL"
              ? t("FeedbackFilterAll" as any)
              : f === "BUG"
              ? t("FeedbackFilterBug" as any)
              : t("FeedbackFilterFeature" as any)}
          </button>
        ))}
        <span className="border-s mx-1" />
        {(["OPEN", "CLOSED", "ALL"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium border transition-colors ${
              statusFilter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:bg-muted"
            }`}
          >
            {s === "ALL"
              ? t("FeedbackFilterAll" as any)
              : s === "OPEN"
              ? t("FeedbackOpen" as any)
              : t("FeedbackClosed" as any)}
          </button>
        ))}
      </div>

      {/* List */}
      {items === undefined ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin me-2" />
          {t("Loading" as any)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-sm gap-2">
          {t("FeedbackNoItems" as any)}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item._id} className={`border-border ${item.status === "CLOSED" ? "opacity-70" : ""}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start gap-2.5 flex-1 min-w-0">
                  {item.type === "BUG" ? (
                    <Bug className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
                  ) : (
                    <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm leading-snug">{item.title}</CardTitle>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                      <Badge
                        variant="outline"
                        className={
                          item.type === "BUG"
                            ? "text-rose-600 border-rose-300 text-xs"
                            : "text-amber-600 border-amber-300 text-xs"
                        }
                      >
                        {item.type === "BUG"
                          ? t("FeedbackTypeBug" as any)
                          : t("FeedbackTypeFeature" as any)}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={
                          item.status === "OPEN"
                            ? "text-green-600 border-green-300 text-xs"
                            : "text-slate-500 border-slate-300 text-xs"
                        }
                      >
                        {item.status === "OPEN"
                          ? t("FeedbackOpen" as any)
                          : t("FeedbackClosed" as any)}
                      </Badge>
                      {item.adminReply && (
                        <Badge variant="outline" className="text-blue-600 border-blue-300 text-xs gap-1">
                          <MessageSquare className="h-2.5 w-2.5" />
                          {t("FeedbackReplied" as any)}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(item.createdAt), "MMM d, yyyy")}
                      </span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              {(item.description || item.url || item.adminReply) && (
                <CardContent className="pt-0 ps-9 space-y-3">
                  {item.description && (
                    <CardDescription className="text-sm whitespace-pre-wrap">
                      {item.description}
                    </CardDescription>
                  )}
                  {item.url && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <ExternalLink className="h-3 w-3" />
                      <span className="font-mono">{item.url}</span>
                    </div>
                  )}
                  {item.adminReply && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-3 space-y-1">
                      <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        {t("FeedbackAdminReply" as any)}
                      </p>
                      <p className="text-sm text-blue-900 dark:text-blue-200 whitespace-pre-wrap">
                        {item.adminReply}
                      </p>
                      {item.adminRepliedAt && (
                        <p className="text-[11px] text-blue-500 dark:text-blue-500">
                          {format(new Date(item.adminRepliedAt), "MMM d, yyyy · HH:mm")}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
