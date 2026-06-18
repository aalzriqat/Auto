"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function LiveChatWidget() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  const startOrGetMyThread = useMutation(api.liveChat.startOrGetMyThread);
  const sendDealerMessage = useMutation(api.liveChat.sendDealerMessage);
  const markThreadReadByDealer = useMutation(api.liveChat.markThreadReadByDealer);

  const threadInfo = useQuery(api.liveChat.getMyThread, activeOrgId ? { orgId: activeOrgId } : "skip");
  const messages = useQuery(
    api.liveChat.getThreadMessages,
    threadInfo?.thread ? { threadId: threadInfo.thread._id } : "skip"
  );

  const unreadCount =
    threadInfo?.thread && messages
      ? messages.filter(
          (m) =>
            m.senderType === "AGENT" &&
            (!threadInfo.thread!.dealerLastReadAt || m.createdAt > threadInfo.thread!.dealerLastReadAt)
        ).length
      : 0;

  useEffect(() => {
    if (open && threadInfo?.thread) {
      markThreadReadByDealer({ threadId: threadInfo.thread._id });
    }
  }, [open, threadInfo?.thread, messages?.length, markThreadReadByDealer]);

  async function handleOpen() {
    setOpen(true);
    if (activeOrgId && !threadInfo?.thread) {
      await startOrGetMyThread({ orgId: activeOrgId });
    }
  }

  async function handleSend() {
    if (!message.trim() || !activeOrgId) return;
    let threadId = threadInfo?.thread?._id;
    if (!threadId) {
      threadId = await startOrGetMyThread({ orgId: activeOrgId });
    }
    const text = message.trim();
    setMessage("");
    try {
      await sendDealerMessage({ threadId, bodyText: text });
    } catch {
      setMessage(text);
    }
  }

  if (!activeOrgId) return null;

  const thread = threadInfo?.thread;

  let statusText = t("LiveChatConnecting");
  if (!thread) {
    statusText = t("LiveChatStartPrompt");
  } else if (thread.status === "WAITING" || thread.status === "OFFERED") {
    statusText = threadInfo?.anyAgentOnline
      ? t("LiveChatQueuePosition").replace("{position}", String(threadInfo?.queuePosition ?? 1))
      : t("LiveChatNoAgentsOnline");
  } else if (thread.status === "ACTIVE") {
    statusText = t("LiveChatAgentConnected").replace("{name}", threadInfo?.claimedByName ?? "Support");
  } else if (thread.status === "CLOSED") {
    statusText = t("LiveChatConversationEnded");
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] end-5 z-40 flex items-center justify-center h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/10 hover:bg-primary/90 transition-colors"
        aria-label={t("LiveChatWidgetTitle")}
      >
        <MessageCircle className="h-5 w-5" />
        {unreadCount > 0 && !open && (
          <span className="absolute -top-1 -end-1 h-5 w-5 rounded-full bg-rose-500 text-white text-[10px] flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end p-4 sm:pe-6 sm:pb-32">
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />

          <div className="relative w-full sm:w-96 bg-background rounded-xl border shadow-xl flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <p className="text-sm font-semibold">{t("LiveChatWidgetTitle")}</p>
                <p className="text-xs text-muted-foreground">{statusText}</p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-muted text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-[200px]">
              {messages?.map((m) => (
                <div
                  key={m._id}
                  className={cn(
                    "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                    m.senderType === "DEALER" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted"
                  )}
                >
                  {m.bodyText}
                </div>
              ))}
              {(!messages || messages.length === 0) && (
                <p className="text-sm text-muted-foreground">{t("LiveChatStartPrompt")}</p>
              )}
            </div>

            <div className="p-3 border-t flex gap-2">
              <Textarea
                placeholder={t("LiveChatMessagePlaceholder")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={1}
                className="resize-none min-h-0"
              />
              <Button onClick={handleSend} disabled={!message.trim()}>
                {t("LiveChatSend")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
