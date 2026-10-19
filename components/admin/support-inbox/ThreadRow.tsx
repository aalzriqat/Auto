"use client";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { resolveThreadCategory } from "@/lib/supportMail";
import { avatarColorClass, formatListTime, senderInitial } from "./format";
import type { SupportThread } from "./types";

interface ThreadRowProps {
  thread: SupportThread;
  selected: boolean;
  now: number;
  onSelect: (thread: SupportThread) => void;
}

/**
 * One conversation in the list. A real <button> (keyboard focusable, Enter and
 * Space work) with a single quiet flag at the end of the second line.
 */
export function ThreadRow({ thread, selected, now, onSelect }: ThreadRowProps) {
  const { t, locale } = useLanguage();
  const automated = resolveThreadCategory(thread) === "automated";
  const sender = thread.participantName || thread.participantEmail;
  const needsReply = thread.status === "OPEN" && thread.awaitingReply === true;

  return (
    <button
      type="button"
      onClick={() => onSelect(thread)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b border-border px-3 py-2.5 text-start transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-primary/10 hover:bg-primary/10"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "row-span-2 flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold",
          automated ? "bg-muted text-muted-foreground" : cn(avatarColorClass(thread.participantEmail), "text-white")
        )}
      >
        {senderInitial(sender)}
      </span>
      <span dir="auto" className="min-w-0 truncate text-sm text-foreground">
        {sender}
      </span>
      <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
        {formatListTime(thread.lastMessageAt, now, locale)}
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-1.5">
        <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{thread.subject}</span>
          {thread.lastMessagePreview ? ` — ${thread.lastMessagePreview}` : ""}
        </span>
        {thread.status === "CLOSED" ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">
            {t("SupportInboxFlagClosed")}
          </span>
        ) : needsReply ? (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-px text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {t("SupportInboxFlagNeedsReply")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
