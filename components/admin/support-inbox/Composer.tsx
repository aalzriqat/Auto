"use client";

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { CornerUpLeft, TriangleAlert } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { isNoReplyAddress } from "@/lib/supportMail";
import { errorToastMessage, INBOX_ADDRESS, replySubject } from "./format";
import type { SupportThread } from "./types";

interface ComposerProps {
  thread: Pick<SupportThread, "_id" | "participantEmail" | "participantName" | "subject" | "inbox" | "status">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 border-b border-border px-3.5 py-1.5 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

export function Composer({ thread, open, onOpenChange }: ComposerProps) {
  const { t } = useLanguage();
  const sendReply = useAction(api.support.sendReply);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  // Same predicate the backend uses to refuse: a reply would only bounce.
  if (isNoReplyAddress(thread.participantEmail)) {
    return (
      <div
        role="note"
        className="mt-3 flex items-start gap-2.5 rounded-lg bg-amber-100 px-4 py-3 text-[13px] text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("SupportInboxNoReplyNotice")}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="outline" onClick={() => onOpenChange(true)} className="gap-2">
          <CornerUpLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
          {t("SupportInboxReply")}
        </Button>
      </div>
    );
  }

  const canSend = body.trim().length > 0 && !sending;

  async function submit(closeAfter: boolean) {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    let outcome: { closed?: boolean; newerInbound?: boolean } | null;
    try {
      // Send & close is ONE backend call: the server closes the thread in the
      // same transaction as the reply, and only if no newer inbound message
      // arrived while the email was being sent.
      outcome = await sendReply({
        threadId: thread._id as Id<"supportThreads">,
        bodyText: text,
        ...(closeAfter ? { closeAfterSend: true } : {}),
      });
    } catch (error) {
      toast.error(errorToastMessage(error, t("SupportInboxReplyFailed")));
      setSending(false);
      return;
    }
    // The reply is out; from here the draft must be cleared whatever happens.
    setBody("");
    onOpenChange(false);
    if (outcome?.newerInbound) {
      toast.warning(t("SupportInboxReplySentNewerInbound"));
    } else if (closeAfter && outcome?.closed) {
      toast.success(t("SupportInboxReplySentClosed"));
    } else {
      toast.success(t("SupportInboxReplySent"));
    }
    setSending(false);
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-card shadow-sm">
      <Field label={t("SupportInboxComposerFrom")}>
        <bdi dir="ltr">{INBOX_ADDRESS[thread.inbox]}</bdi>
      </Field>
      <Field label={t("SupportInboxComposerTo")}>
        <bdi dir="ltr">
          {thread.participantName ? `${thread.participantName} <${thread.participantEmail}>` : thread.participantEmail}
        </bdi>
      </Field>
      <Field label={t("SupportInboxComposerSubject")}>
        <span dir="auto">{replySubject(thread.subject)}</span>
      </Field>
      <Textarea
        ref={textareaRef}
        dir="auto"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit(false);
          }
        }}
        placeholder={t("SupportInboxComposerPlaceholder")}
        aria-label={t("SupportInboxReply")}
        disabled={sending}
        className="min-h-36 resize-y rounded-none border-0 px-3.5 py-3 text-sm leading-relaxed shadow-none focus-visible:ring-inset focus-visible:ring-offset-0"
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
        <Button onClick={() => void submit(false)} disabled={!canSend}>
          {sending ? t("SupportInboxSending") : t("SupportInboxSend")}
        </Button>
        {thread.status === "OPEN" ? (
          <Button variant="outline" onClick={() => void submit(true)} disabled={!canSend}>
            {t("SupportInboxSendAndClose")}
          </Button>
        ) : null}
        <span className="hidden text-xs text-muted-foreground sm:inline">{t("SupportInboxSendHint")}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          disabled={sending}
          onClick={() => {
            setBody("");
            onOpenChange(false);
          }}
        >
          {t("SupportInboxDiscard")}
        </Button>
      </div>
    </div>
  );
}
