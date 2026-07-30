"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { Lock, CheckCheck } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LeadCustomerMessagesProps {
  orgId: Id<"organizations">;
  leadId: Id<"leads">;
}

/** Enough to see what they're asking about without turning the dialog into an inbox. */
const COLLAPSED_COUNT = 3;

/**
 * What the customer actually said, verbatim and read-only.
 *
 * The lead's `notes` field only ever captured the truncated first message, so
 * before this panel a rep opening a social lead had no way to see the rest of
 * the conversation from the lead itself. Nothing here is editable — these are
 * the customer's own words, and there is no mutation behind the query.
 */
export function LeadCustomerMessages({ orgId, leadId }: LeadCustomerMessagesProps) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  const data = useQuery(api.leads.customerMessages, { orgId, leadId });

  if (data === undefined) {
    return <div className="h-16 rounded-md bg-muted animate-pulse" aria-busy="true" />;
  }

  // Not every lead comes from social — a walk-in has nothing to show here.
  if (data.total === 0) return null;

  const shown = expanded ? data.messages : data.messages.slice(0, COLLAPSED_COUNT);
  const hiddenCount = data.total - shown.length;

  const formatTimestamp = (ts: number) =>
    new Date(ts).toLocaleString(locale === "ar" ? "ar" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="rounded-md border bg-muted/30">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">
          {t("CustomerMessages" as any) || "What the customer asked"}
        </span>
        {data.unansweredCount > 0 && (
          <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
            {data.unansweredCount} {t("Unanswered" as any) || "unanswered"}
          </Badge>
        )}
        <span className="ms-auto text-[10px] text-muted-foreground">
          {t("ReadOnly" as any) || "Read-only"}
        </span>
      </div>

      <ul className="divide-y">
        {shown.map((message) => {
          // lucide dropped its brand icons, so the platform is named in text.
          const platformLabel = message.platform === "instagram" ? "Instagram" : "Facebook";
          return (
            <li key={message.id} className="px-3 py-2">
              <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-muted-foreground">
                <span className="font-medium">{platformLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="uppercase">
                  {message.kind === "dm"
                    ? t("DM" as any) || "DM"
                    : t("Comment" as any) || "Comment"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatTimestamp(message.createdAt)}</span>
                {message.manualRepliedAt && (
                  <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCheck className="h-3 w-3" />
                    {t("Replied" as any) || "Replied"}
                  </span>
                )}
              </div>
              <p className="text-sm mt-0.5 break-words whitespace-pre-wrap">{message.text}</p>
            </li>
          );
        })}
      </ul>

      {hiddenCount > 0 && (
        <div className="px-3 py-1.5 border-t">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => setExpanded(true)}
          >
            {(t("ShowAllMessages" as any) || "Show all {count}").replace(
              "{count}",
              String(data.total)
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
