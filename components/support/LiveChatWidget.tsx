"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, X, ChevronLeft, Car, Users, DollarSign, UserCog, BarChart3, KeyRound, type LucideIcon } from "lucide-react";
import { cn, firstName, formatElapsed } from "@/lib/utils";
import { playChatMessagePing } from "@/lib/chatSound";
import { useTicker } from "@/hooks/useTicker";
import { format } from "date-fns";
import { supportFaqCategories } from "@/lib/supportFaq";
import { LIVE_CHAT_ENABLED } from "@/lib/featureFlags";

const TYPING_TIMEOUT_MS = 4_000;
const TYPING_THROTTLE_MS = 2_000;
const PRESENCE_REPORT_INTERVAL_MS = 10_000;
const AGENT_PRESENCE_STALE_MS = 25_000;

const FAQ_CATEGORY_ICONS: Record<string, LucideIcon> = {
  vehicles: Car,
  "customers-leads": Users,
  "sales-financing": DollarSign,
  "team-roles": UserCog,
  "reports-settings": BarChart3,
  "account-access": KeyRound,
};

type FaqStep =
  | { step: "categories" }
  | { step: "questions"; categoryId: string }
  | { step: "answer"; categoryId: string; entryId: string };

export function LiveChatWidget() {
  if (!LIVE_CHAT_ENABLED) return null;
  return <LiveChatWidgetImpl />;
}

function LiveChatWidgetImpl() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [faqStep, setFaqStep] = useState<FaqStep>({ step: "categories" });
  useTicker(1000);

  const startOrGetMyThread = useMutation(api.liveChat.startOrGetMyThread);
  const sendDealerMessage = useMutation(api.liveChat.sendDealerMessage);
  const markThreadReadByDealer = useMutation(api.liveChat.markThreadReadByDealer);
  const setDealerTyping = useMutation(api.liveChat.setDealerTyping);
  const updateDealerPresence = useMutation(api.liveChat.updateDealerPresence);
  const endThreadByDealer = useMutation(api.liveChat.endThreadByDealer);

  const threadInfo = useQuery(api.liveChat.getMyThread, activeOrgId ? { orgId: activeOrgId } : "skip");
  const messages = useQuery(
    api.liveChat.getThreadMessages,
    threadInfo?.thread ? { threadId: threadInfo.thread._id } : "skip"
  );

  const unreadCount =
    threadInfo?.thread && messages
      ? messages.filter(
          (m: Doc<"liveChatMessages">) =>
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

  const thread = threadInfo?.thread;
  const inFaqMode = !thread || thread.status === "CLOSED";

  // Reset to the FAQ start screen each time the widget is freshly opened
  // (but only matters while there's no live conversation to jump back into).
  useEffect(() => {
    if (open) setFaqStep({ step: "categories" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleOpen() {
    setOpen(true);
  }

  async function handleStartChatFromFaq(prefillBodyText?: string) {
    if (!activeOrgId) return;
    const threadId = await startOrGetMyThread({ orgId: activeOrgId });
    if (prefillBodyText) {
      await sendDealerMessage({ threadId, bodyText: prefillBodyText });
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

  const agentDisplayName = firstName(threadInfo?.claimedByName) ?? "Support";
  const agentIsTyping = Boolean(
    thread?.agentTypingAt && Date.now() - thread.agentTypingAt < TYPING_TIMEOUT_MS
  );
  const agentIsPresent = Boolean(
    thread?.agentPresenceAt && Date.now() - thread.agentPresenceAt < AGENT_PRESENCE_STALE_MS
  );
  const agentIdleText =
    thread?.status === "ACTIVE" && !agentIsTyping
      ? agentIsPresent && thread.agentPresence === "idle" && thread.agentPresenceSince
        ? t("LiveChatIdleFor").replace("{time}", formatElapsed(Date.now() - thread.agentPresenceSince))
        : !agentIsPresent && thread.agentPresenceAt
        ? t("LiveChatAwayFor").replace("{time}", formatElapsed(Date.now() - thread.agentPresenceAt))
        : null
      : null;

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
          <button
            type="button"
            className="absolute inset-0 bg-black/20"
            onClick={() => setOpen(false)}
            aria-label={t("Close")}
          />

          <div className="relative w-full sm:w-96 bg-background rounded-xl border shadow-xl flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                {inFaqMode ? (
                  <>
                    <p className="text-sm font-semibold">{t("LiveChatFaqTitle")}</p>
                    <p className="text-xs text-muted-foreground">{t("LiveChatFaqSubtitle")}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold">{t("LiveChatWidgetTitle")}</p>
                    <p className="text-xs text-muted-foreground">{statusText}</p>
                    {agentIdleText && <p className="text-[10px] text-muted-foreground">{agentIdleText}</p>}
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                {thread && thread.status !== "CLOSED" && (
                  <button
                    onClick={() => endThreadByDealer({ threadId: thread._id })}
                    className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {t("LiveChatEndChat")}
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-muted text-muted-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-[200px]">
              {inFaqMode ? (
                <FaqBody
                  step={faqStep}
                  locale={locale}
                  t={t}
                  onSelectCategory={(categoryId) => setFaqStep({ step: "questions", categoryId })}
                  onSelectQuestion={(categoryId, entryId) => setFaqStep({ step: "answer", categoryId, entryId })}
                  onBackToCategories={() => setFaqStep({ step: "categories" })}
                  onBackToQuestions={(categoryId) => setFaqStep({ step: "questions", categoryId })}
                  onHelped={() => setOpen(false)}
                  onTalkToAgent={(prefill) => handleStartChatFromFaq(prefill)}
                />
              ) : (
                <>
                  {messages?.map((m: Doc<"liveChatMessages">) =>
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
                </>
              )}
            </div>

            {!inFaqMode && (
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
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FaqBody({
  step,
  locale,
  t,
  onSelectCategory,
  onSelectQuestion,
  onBackToCategories,
  onBackToQuestions,
  onHelped,
  onTalkToAgent,
}: {
  step: FaqStep;
  locale: "en" | "ar";
  t: (key: string) => string;
  onSelectCategory: (categoryId: string) => void;
  onSelectQuestion: (categoryId: string, entryId: string) => void;
  onBackToCategories: () => void;
  onBackToQuestions: (categoryId: string) => void;
  onHelped: () => void;
  onTalkToAgent: (prefillBodyText?: string) => void;
}) {
  if (step.step === "categories") {
    return (
      <div className="flex flex-col gap-2">
        {supportFaqCategories.map((cat) => {
          const Icon = FAQ_CATEGORY_ICONS[cat.id] ?? MessageCircle;
          return (
            <button
              key={cat.id}
              onClick={() => onSelectCategory(cat.id)}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-start text-sm hover:bg-muted transition-colors"
            >
              <Icon className="h-4 w-4 text-primary shrink-0" />
              {cat.label[locale]}
            </button>
          );
        })}
        <button
          onClick={() => onTalkToAgent()}
          className="mt-1 text-xs text-primary hover:underline self-start"
        >
          {t("LiveChatFaqTalkToAgent")}
        </button>
      </div>
    );
  }

  const category = supportFaqCategories.find((c) => c.id === step.categoryId);
  if (!category) return null;

  if (step.step === "questions") {
    return (
      <div className="flex flex-col gap-2">
        <button
          onClick={onBackToCategories}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1 self-start"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> {t("LiveChatFaqBack")}
        </button>
        {category.entries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => onSelectQuestion(category.id, entry.id)}
            className="rounded-lg border px-3 py-2.5 text-start text-sm hover:bg-muted transition-colors"
          >
            {entry.question[locale]}
          </button>
        ))}
        <button
          onClick={() => onTalkToAgent()}
          className="mt-1 text-xs text-primary hover:underline self-start"
        >
          {t("LiveChatFaqTalkToAgent")}
        </button>
      </div>
    );
  }

  const entry = category.entries.find((e) => e.id === step.entryId);
  if (!entry) return null;

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => onBackToQuestions(category.id)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground self-start"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> {t("LiveChatFaqBack")}
      </button>
      <p className="text-sm font-medium">{entry.question[locale]}</p>
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{entry.answer[locale]}</p>
      <div className="flex flex-col gap-2 mt-1">
        <Button variant="outline" size="sm" onClick={onHelped}>
          {t("LiveChatFaqHelped")}
        </Button>
        <Button size="sm" onClick={() => onTalkToAgent(entry.question[locale])}>
          {t("LiveChatFaqStillNeedHelp")}
        </Button>
      </div>
    </div>
  );
}
