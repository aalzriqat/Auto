"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, X } from "lucide-react";
import { cn, firstName } from "@/lib/utils";
import { playChatMessagePing } from "@/lib/chatSound";
import { useTicker } from "@/hooks/useTicker";
import { format } from "date-fns";

const TYPING_TIMEOUT_MS = 4_000;
const TYPING_THROTTLE_MS = 2_000;
const PRESENCE_REPORT_INTERVAL_MS = 10_000;

export function LiveChatWidget() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  useTicker(1000);

  const startOrGetMyThread = useMutation(api.liveChat.startOrGetMyThread);
  const sendDealerMessage = useMutation(api.liveChat.sendDealerMessage);
  const markThreadReadByDealer = useMutation(api.liveChat.markThreadReadByDealer);
  const setDealerTyping = useMutation(api.liveChat.setDealerTyping);
  const updateDealerPresence = useMutation(api.liveChat.updateDealerPresence);

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

  // Sound + tab-title flash when a new agent message (or close notice)
  // arrives while the widget is closed or the tab isn't focused.
  const prevUnreadRef = useRef(0);
  useEffect(() => {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (unreadCount > prevUnreadRef.current && (!open || hidden)) {
      playChatMessagePing();
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount, open]);

  useEffect(() => {
    if (unreadCount === 0 || open) return;
    const original = document.title;
    let toggled = false;
    const id = setInterval(() => {
      document.title = toggled ? original : `(${unreadCount}) ${t("LiveChatWidgetTitle")}`;
      toggled = !toggled;
    }, 1500);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [unreadCount, open, t]);

  // Report presence (active/idle) to the agent while the widget is open.
  useEffect(() => {
    const threadId = threadInfo?.thread?._id;
    if (!open || !threadId) return;

    const report = () => {
      const state = document.visibilityState === "visible" ? "active" : "idle";
      updateDealerPresence({ threadId, state });
    };
    report();
    const interval = setInterval(report, PRESENCE_REPORT_INTERVAL_MS);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
    };
  }, [open, threadInfo?.thread?._id, updateDealerPresence]);

  const lastTypingSentRef = useRef(0);
  function handleTyping(value: string) {
    setMessage(value);
    const threadId = threadInfo?.thread?._id;
    if (!threadId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now;
      setDealerTyping({ threadId });
    }
  }

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
  const agentDisplayName = firstName(threadInfo?.claimedByName) ?? "Support";
  const agentIsTyping = Boolean(
    thread?.agentTypingAt && Date.now() - thread.agentTypingAt < TYPING_TIMEOUT_MS
  );

  let statusText = t("LiveChatConnecting");
  if (!thread) {
    statusText = t("LiveChatStartPrompt");
  } else if (thread.status === "WAITING" || thread.status === "OFFERED") {
    statusText = threadInfo?.anyAgentOnline
      ? t("LiveChatQueuePosition").replace("{position}", String(threadInfo?.queuePosition ?? 1))
      : t("LiveChatNoAgentsOnline");
  } else if (thread.status === "ACTIVE") {
    statusText = agentIsTyping
      ? t("LiveChatAgentTyping").replace("{name}", agentDisplayName)
      : t("LiveChatAgentConnected").replace("{name}", agentDisplayName);
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
              {messages?.map((m) =>
                m.isSystem ? (
                  <p key={m._id} className="self-center text-[11px] text-muted-foreground italic">
                    {m.bodyText}
                  </p>
                ) : (
                  <div
                    key={m._id}
                    className={cn(
                      "max-w-[80%] flex flex-col gap-0.5",
                      m.senderType === "DEALER" ? "self-end items-end" : "self-start items-start"
                    )}
                  >
                    {m.senderType === "AGENT" && (
                      <span className="text-[10px] text-muted-foreground px-1">{firstName(m.senderName) ?? "Support"}</span>
                    )}
                    <div
                      className={cn(
                        "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                        m.senderType === "DEALER" ? "bg-primary text-primary-foreground" : "bg-muted"
                      )}
                    >
                      {m.bodyText}
                    </div>
                    <span className="text-[10px] text-muted-foreground px-1">{format(m.createdAt, "p")}</span>
                  </div>
                )
              )}
              {(!messages || messages.length === 0) && (
                <p className="text-sm text-muted-foreground">{t("LiveChatStartPrompt")}</p>
              )}
              {agentIsTyping && (
                <p className="self-start text-[11px] text-muted-foreground italic">
                  {t("LiveChatAgentTyping").replace("{name}", agentDisplayName)}
                </p>
              )}
            </div>

            <div className="p-3 border-t flex gap-2">
              <Textarea
                placeholder={t("LiveChatMessagePlaceholder")}
                value={message}
                onChange={(e) => handleTyping(e.target.value)}
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
