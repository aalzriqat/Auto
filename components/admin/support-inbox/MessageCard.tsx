"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { buildPreview } from "@/lib/supportMail";
import { avatarColorClass, formatFullDate, formatListTime, isAutomatedAck, senderInitial } from "./format";
import { MessageBody } from "./MessageBody";
import type { SupportMessage, SupportThread } from "./types";

interface MessageCardProps {
  message: SupportMessage;
  thread: Pick<SupportThread, "participantEmail" | "participantName" | "inbox">;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}

/** One email in the conversation: a stacked card, not a chat bubble. */
export function MessageCard({ message, thread, expanded, onToggle, now }: MessageCardProps) {
  const { t, locale } = useLanguage();
  const outbound = message.direction === "OUTBOUND";
  const automatedAck = isAutomatedAck(message);
  const senderName = outbound
    ? automatedAck
      ? "AutoFlow"
      : t("SupportInboxYou")
    : thread.participantName || thread.participantEmail;
  const senderEmail = message.fromEmail;
  const avatarClass = outbound ? "bg-primary text-primary-foreground" : cn(avatarColorClass(thread.participantEmail), "text-white");
  const snippet = useMemo(
    () => (automatedAck ? t("SupportInboxAutoAck") : buildPreview(message.bodyText, message.bodyHtml)),
    [automatedAck, message.bodyText, message.bodyHtml, t]
  );
  const full = formatFullDate(message.createdAt, locale);

  const avatar = (
    <span
      aria-hidden="true"
      className={cn("flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-semibold", avatarClass)}
    >
      {outbound ? "A" : senderInitial(thread.participantName || thread.participantEmail)}
    </span>
  );

  return (
    <article
      className={cn(
        "rounded-lg border border-border bg-card",
        outbound && "border-s-[3px] border-s-primary"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? undefined : t("SupportInboxExpandMessage")}
        className={cn(
          "grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-4 py-3 text-start transition-colors",
          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        )}
      >
        {avatar}
        {expanded ? (
          <span className="min-w-0">
            <span className="block truncate text-sm">
              <b dir="auto" className="font-semibold">
                {senderName}
              </b>{" "}
              <bdi dir="ltr" className="text-xs text-muted-foreground">
                &lt;{senderEmail}&gt;
              </bdi>
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {t("SupportInboxTo")} <bdi dir="ltr">{message.toEmail}</bdi>
            </span>
          </span>
        ) : (
          <span className="flex min-w-0 items-baseline gap-2.5 text-sm">
            <b dir="auto" className="shrink-0 font-semibold">
              {senderName}
            </b>
            <span dir="auto" className="min-w-0 truncate text-[13px] text-muted-foreground">
              {snippet}
            </span>
          </span>
        )}
        <span title={full} className="whitespace-nowrap text-end text-xs text-muted-foreground tabular-nums">
          {expanded ? full : formatListTime(message.createdAt, now, locale)}
        </span>
      </button>
      {expanded ? (
        <div className="px-4 pb-4 ps-[3.75rem] max-sm:ps-4">
          {automatedAck ? (
            <span className="mb-2 inline-block rounded-md bg-muted px-2 py-px text-xs text-muted-foreground">
              {t("SupportInboxAutoAck")}
            </span>
          ) : null}
          <MessageBody message={message} />
        </div>
      ) : null}
    </article>
  );
}
