"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ChevronLeft, ChevronRight, Check, RotateCcw } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { interpolate } from "@/lib/i18n/interpolate";
import { resolveThreadCategory } from "@/lib/supportMail";
import { Composer } from "./Composer";
import { errorToastMessage, INBOX_ADDRESS, isAutomatedAck, isTypingTarget } from "./format";
import { MessageCard } from "./MessageCard";

interface ReadingPaneProps {
  threadId: Id<"supportThreads">;
  /** 1-based position in the visible list, or null when the thread is not in it. */
  position: number | null;
  total: number;
  now: number;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

const INBOX_LABEL_KEY = {
  support: "SupportInboxMailboxSupport",
  info: "SupportInboxMailboxInfo",
  subscriptions: "SupportInboxMailboxBilling",
} as const;

function PaneSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-6" aria-hidden="true">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ReadingPane({ threadId, position, total, now, onBack, onPrevious, onNext }: ReadingPaneProps) {
  const { t } = useLanguage();
  const data = useQuery(api.support.getThreadMessages, { threadId });
  const setThreadStatus = useMutation(api.support.setThreadStatus);
  const setThreadCategory = useMutation(api.support.setThreadCategory);
  const [composerOpen, setComposerOpen] = useState(false);
  // Per-message expansion overrides; absent = use the default (latest substantive).
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});

  const thread = data?.thread;
  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);

  // The message a reader wants open: the last one that is not an automated ack
  // (the ack lands seconds after the real message, so "last" would hide it).
  const defaultOpenId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (!isAutomatedAck(message)) return message._id;
    }
    return messages[messages.length - 1]?._id;
  }, [messages]);

  async function toggleStatus() {
    if (!thread) return;
    try {
      await setThreadStatus({ threadId, status: thread.status === "OPEN" ? "CLOSED" : "OPEN" });
    } catch (error) {
      toast.error(errorToastMessage(error, t("SupportInboxStatusFailed")));
    }
  }

  async function toggleCategory() {
    if (!thread) return;
    const current = resolveThreadCategory(thread);
    try {
      await setThreadCategory({ threadId, category: current === "automated" ? "people" : "automated" });
    } catch (error) {
      toast.error(errorToastMessage(error, t("SupportInboxCategoryFailed")));
    }
  }

  // r = reply, e = close/reopen. j/k/Esc/"/" are handled by the shell.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "r") {
        event.preventDefault();
        setComposerOpen(true);
      } else if (event.key === "e") {
        event.preventDefault();
        void toggleStatus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // toggleStatus closes over `thread`; re-bind when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.status, threadId]);

  if (!data || !thread) return <PaneSkeleton />;

  const category = resolveThreadCategory(thread);
  const open = thread.status === "OPEN";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-3 py-2 sm:px-4">
        <Button variant="ghost" size="sm" className="gap-1.5 lg:hidden" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          {t("SupportInboxBack")}
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void toggleStatus()}>
          {open ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          )}
          {open ? t("SupportInboxCloseConversation") : t("SupportInboxReopen")}
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void toggleCategory()}>
          {category === "automated" ? t("SupportInboxNotAutomated") : t("SupportInboxMarkAutomated")}
        </Button>
        <span className="flex-1" />
        {position !== null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {interpolate(t("SupportInboxPosition"), { current: position, total })}
          </span>
        ) : null}
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrevious} aria-label={t("SupportInboxPrevious")}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext} aria-label={t("SupportInboxNext")}>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
        <div className="mx-auto max-w-[54rem]">
          <header className="mb-4">
            <h2 dir="auto" className="mb-2 text-xl font-bold leading-snug text-foreground">
              {thread.subject}
            </h2>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
                {t(INBOX_LABEL_KEY[thread.inbox])} · <bdi dir="ltr">{INBOX_ADDRESS[thread.inbox]}</bdi>
              </span>
              <span
                className={cn(
                  "rounded-md px-2 py-0.5",
                  open
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {open ? t("SupportInboxStatusOpen") : t("SupportInboxStatusClosed")}
              </span>
              {category === "automated" ? (
                <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  {t("SupportInboxCatAutomated")}
                </span>
              ) : null}
              <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground tabular-nums">
                {messages.length === 1
                  ? t("SupportInboxMessageCountOne")
                  : interpolate(t("SupportInboxMessageCount"), { count: messages.length })}
              </span>
            </div>
          </header>

          <div className="flex flex-col gap-2">
            {messages.map((message) => (
              <MessageCard
                key={message._id}
                message={message}
                thread={thread}
                now={now}
                expanded={expandedOverride[message._id] ?? message._id === defaultOpenId}
                onToggle={() =>
                  setExpandedOverride((current) => ({
                    ...current,
                    [message._id]: !(current[message._id] ?? message._id === defaultOpenId),
                  }))
                }
              />
            ))}
          </div>

          <Composer thread={thread} open={composerOpen} onOpenChange={setComposerOpen} />
        </div>
      </div>
    </div>
  );
}
