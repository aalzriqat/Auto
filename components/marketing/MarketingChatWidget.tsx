"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { marketingFaqCategories } from "@/lib/marketingFaq";
import { playChatMessagePing } from "@/lib/chatSound";
import { useTicker } from "@/hooks/useTicker";
import { firstName } from "@/lib/utils";
import { LIVE_CHAT_ENABLED } from "@/lib/featureFlags";
import {
  MessageCircle,
  X,
  Send,
  ThumbsUp,
  Rocket,
  ShieldCheck,
  GitBranch,
  type LucideIcon,
} from "lucide-react";

const LEAD_ID_STORAGE_KEY = "autoflow-lead-id";
const TYPING_TIMEOUT_MS = 4_000;
const TYPING_THROTTLE_MS = 2_000;

const FAQ_CATEGORY_ICONS: Record<string, LucideIcon> = {
  "getting-started": Rocket,
  "features-permissions": ShieldCheck,
  "multi-branch-language": GitBranch,
};

const copy = {
  en: {
    widgetTitle: "AutoFlow Assistant",
    greeting: "👋 Hi there! I'm the AutoFlow assistant. Pick a topic below, or tell us you'd like to talk to a human.",
    questionsPrompt: "Here are some common questions:",
    helped: "👍 That answered my question",
    talkToHuman: "💬 Talk to a human",
    helpedFollowUp: "Glad I could help! Anything else?",
    captureLeadPrompt: "Before I connect you, what's your name and email? (optional)",
    namePlaceholder: "Your name",
    emailPlaceholder: "you@dealership.com",
    connectNow: "Connect me now",
    startChat: "Start chat",
    liveConnecting: "Connecting...",
    liveQueuePosition: "You're #{position} in line — an agent will be with you shortly.",
    liveNoAgents: "Our team is offline right now — leave a message and we'll reply by email.",
    liveAgentConnected: "{name} is now chatting with you",
    liveAgentTyping: "{name} is typing...",
    liveConversationEnded: "This conversation has ended.",
    liveStartPrompt: "Send a message to connect with our team.",
    messagePlaceholder: "Type a message...",
    send: "Send",
    endChat: "End chat",
  },
  ar: {
    widgetTitle: "مساعد أوتوفلو",
    greeting: "👋 مرحباً! أنا مساعد أوتوفلو الافتراضي. اختر موضوعاً أدناه، أو أخبرنا أنك ترغب بالتحدث مع أحد فريقنا.",
    questionsPrompt: "إليك بعض الأسئلة الشائعة:",
    helped: "👍 هذا أجاب على سؤالي",
    talkToHuman: "💬 التحدث مع شخص",
    helpedFollowUp: "سعيد بأنني ساعدتك! هل من شيء آخر؟",
    captureLeadPrompt: "قبل أن أوصلك، ما اسمك وبريدك الإلكتروني؟ (اختياري)",
    namePlaceholder: "اسمك",
    emailPlaceholder: "you@dealership.com",
    connectNow: "وصّلني الآن",
    startChat: "ابدأ المحادثة",
    liveConnecting: "جارٍ الاتصال...",
    liveQueuePosition: "أنت بالترتيب رقم {position} — سيتواصل معك أحد الموظفين قريباً.",
    liveNoAgents: "فريقنا غير متصل حالياً — اترك رسالة وسنرد عليك عبر البريد الإلكتروني.",
    liveAgentConnected: "{name} يتحدث معك الآن",
    liveAgentTyping: "{name} يكتب...",
    liveConversationEnded: "انتهت هذه المحادثة.",
    liveStartPrompt: "أرسل رسالة للتواصل مع فريقنا.",
    messagePlaceholder: "اكتب رسالة...",
    send: "إرسال",
    endChat: "إنهاء المحادثة",
  },
};

type TranscriptEntry = { id: string; from: "bot" | "user"; text: string };
type BotStep =
  | { kind: "categories" }
  | { kind: "questions"; categoryId: string }
  | { kind: "answered"; categoryId: string; entryId: string }
  | { kind: "captureLead" };

function getOrCreateLeadId(): string {
  let id = window.localStorage.getItem(LEAD_ID_STORAGE_KEY);
  if (!id) {
    id = window.crypto?.randomUUID?.() ?? `lead_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(LEAD_ID_STORAGE_KEY, id);
  }
  return id;
}

export function MarketingChatWidget() {
  if (!LIVE_CHAT_ENABLED) return null;
  return <MarketingChatWidgetImpl />;
}

function MarketingChatWidgetImpl() {
  const { locale, isRtl } = useLanguage();
  const t = copy[locale] || copy.en;
  useTicker(1000);

  const [open, setOpen] = useState(false);
  const [leadId, setLeadId] = useState("");
  useEffect(() => {
    setLeadId(getOrCreateLeadId());
  }, []);

  const startOrGetLeadThread = useMutation(api.liveChat.startOrGetLeadThread);
  const sendLeadMessage = useMutation(api.liveChat.sendLeadMessage);
  const markLeadThreadRead = useMutation(api.liveChat.markLeadThreadRead);
  const setLeadTyping = useMutation(api.liveChat.setLeadTyping);
  const endThreadByLead = useMutation(api.liveChat.endThreadByLead);

  const threadInfo = useQuery(api.liveChat.getLeadThread, leadId ? { leadId } : "skip");
  const thread = threadInfo?.thread;
  const inLiveMode = Boolean(thread && thread.status !== "CLOSED");
  const messages = useQuery(
    api.liveChat.getLeadThreadMessages,
    thread && inLiveMode ? { threadId: thread._id, leadId } : "skip"
  );

  // ─── Bot transcript (shown until the visitor escalates to a live thread) ──
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [step, setStep] = useState<BotStep>({ kind: "categories" });
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const greetedRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inLiveMode || greetedRef.current) return;
    greetedRef.current = true;
    setTranscript([{ id: "greeting", from: "bot", text: t.greeting }]);
  }, [open, inLiveMode, t.greeting]);

  useEffect(() => {
    if (open && !inLiveMode) setStep({ kind: "categories" });
  }, [open, inLiveMode]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, messages?.length, step]);

  function pushTranscript(entries: Omit<TranscriptEntry, "id">[]) {
    setTranscript((prev) => [
      ...prev,
      ...entries.map((e, i) => ({ ...e, id: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}` })),
    ]);
  }

  function handleSelectCategory(categoryId: string) {
    const category = marketingFaqCategories.find((c) => c.id === categoryId);
    if (!category) return;
    pushTranscript([
      { from: "user", text: category.label[locale] || category.label.en },
      { from: "bot", text: t.questionsPrompt },
    ]);
    setStep({ kind: "questions", categoryId });
  }

  function handleSelectQuestion(categoryId: string, entryId: string) {
    const category = marketingFaqCategories.find((c) => c.id === categoryId);
    const entry = category?.entries.find((e) => e.id === entryId);
    if (!entry) return;
    pushTranscript([
      { from: "user", text: entry.question[locale] || entry.question.en },
      { from: "bot", text: entry.answer[locale] || entry.answer.en },
    ]);
    setStep({ kind: "answered", categoryId, entryId });
  }

  function handleHelped() {
    pushTranscript([{ from: "bot", text: t.helpedFollowUp }]);
    setStep({ kind: "categories" });
  }

  function handleTalkToHuman() {
    pushTranscript([{ from: "bot", text: t.captureLeadPrompt }]);
    setStep({ kind: "captureLead" });
  }

  async function handleConnect() {
    const name = leadName.trim() || undefined;
    const email = leadEmail.trim() || undefined;
    await startOrGetLeadThread({ leadId, name, email });
  }

  // ─── Live thread ────────────────────────────────────────────────────────
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (open && thread && inLiveMode) {
      markLeadThreadRead({ threadId: thread._id, leadId });
    }
    // thread is a fresh object reference on every reactive re-run (e.g. every
    // agent presence heartbeat) — depend on its stable id instead, or this
    // re-fires (and re-patches the thread, triggering more re-runs) every ~10s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, thread?._id, inLiveMode, messages?.length, markLeadThreadRead, leadId]);

  const unreadCount =
    thread && messages
      ? messages.filter((m: Doc<"liveChatMessages">) => m.senderType === "AGENT" && (!thread.dealerLastReadAt || m.createdAt > thread.dealerLastReadAt)).length
      : 0;

  const prevUnreadRef = useRef(0);
  useEffect(() => {
    if (unreadCount > prevUnreadRef.current && !open) {
      playChatMessagePing();
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount, open]);

  const lastTypingSentRef = useRef(0);
  function handleTyping(value: string) {
    setMessage(value);
    if (!thread) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now;
      setLeadTyping({ threadId: thread._id, leadId });
    }
  }

  async function handleSend() {
    if (!message.trim() || !thread) return;
    const text = message.trim();
    setMessage("");
    try {
      await sendLeadMessage({ threadId: thread._id, leadId, bodyText: text });
    } catch {
      setMessage(text);
    }
  }

  if (!leadId) return null;

  const agentDisplayName = firstName(threadInfo?.claimedByName) ?? "Support";
  const agentIsTyping = Boolean(thread?.agentTypingAt && Date.now() - thread.agentTypingAt < TYPING_TIMEOUT_MS);

  let statusText = t.liveConnecting;
  if (thread) {
    if (thread.status === "WAITING" || thread.status === "OFFERED") {
      statusText = threadInfo?.anyAgentOnline
        ? t.liveQueuePosition.replace("{position}", String(threadInfo?.queuePosition ?? 1))
        : t.liveNoAgents;
    } else if (thread.status === "ACTIVE") {
      statusText = agentIsTyping ? t.liveAgentTyping.replace("{name}", agentDisplayName) : t.liveAgentConnected.replace("{name}", agentDisplayName);
    } else if (thread.status === "CLOSED") {
      statusText = t.liveConversationEnded;
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 end-6 z-40 flex items-center justify-center h-14 w-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_30px_rgba(59,130,246,0.5)] transition-all duration-300 cursor-pointer"
        aria-label={t.widgetTitle}
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        {unreadCount > 0 && !open && (
          <span className="absolute -top-1 -end-1 h-5 w-5 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-[#030014]">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          dir={isRtl ? "rtl" : "ltr"}
          className="fixed bottom-24 end-6 z-40 w-[calc(100vw-3rem)] sm:w-96 max-h-[70vh] bg-[#0a0721] border border-white/10 rounded-2xl shadow-[0_0_60px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/5 bg-white/[0.02]">
            <div>
              <p className="text-sm font-bold text-white">{t.widgetTitle}</p>
              {inLiveMode && <p className="text-[11px] text-white/50">{statusText}</p>}
            </div>
            <div className="flex items-center gap-1">
              {inLiveMode && thread && thread.status !== "CLOSED" && (
                <button
                  onClick={() => endThreadByLead({ threadId: thread._id, leadId })}
                  className="rounded-md px-2 py-1 text-[11px] text-white/50 hover:bg-white/10 hover:text-white transition-colors"
                >
                  {t.endChat}
                </button>
              )}
              <button onClick={() => setOpen(false)} className="rounded-md p-1.5 hover:bg-white/10 text-white/50 hover:text-white transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-[280px]">
            {inLiveMode ? (
              <>
                {messages?.map((m: Doc<"liveChatMessages">) =>
                  m.isSystem ? (
                    <p key={m._id} className="self-center text-[11px] text-white/40 italic">
                      {m.bodyText}
                    </p>
                  ) : (
                    <div
                      key={m._id}
                      className={`max-w-[80%] flex flex-col gap-0.5 ${m.senderType === "DEALER" ? "self-end items-end" : "self-start items-start"}`}
                    >
                      {m.senderType === "AGENT" && <span className="text-[10px] text-white/40 px-1">{firstName(m.senderName) ?? "Support"}</span>}
                      <div
                        className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                          m.senderType === "DEALER" ? "bg-blue-600 text-white" : "bg-white/10 text-white/90"
                        }`}
                      >
                        {m.bodyText}
                      </div>
                    </div>
                  )
                )}
                {(!messages || messages.length === 0) && <p className="text-sm text-white/50">{t.liveStartPrompt}</p>}
                {agentIsTyping && <p className="self-start text-[11px] text-white/40 italic">{t.liveAgentTyping.replace("{name}", agentDisplayName)}</p>}
              </>
            ) : (
              <>
                {transcript.map((entry) => (
                  <div key={entry.id} className={`max-w-[85%] ${entry.from === "user" ? "self-end" : "self-start"}`}>
                    <div
                      className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                        entry.from === "user" ? "bg-blue-600 text-white" : "bg-white/10 text-white/90"
                      }`}
                    >
                      {entry.text}
                    </div>
                  </div>
                ))}

                <ChipMenu step={step} locale={locale} t={t} onSelectCategory={handleSelectCategory} onSelectQuestion={handleSelectQuestion} onHelped={handleHelped} onTalkToHuman={handleTalkToHuman} />

                {step.kind === "captureLead" && (
                  <div className="flex flex-col gap-2 mt-1">
                    <input
                      value={leadName}
                      onChange={(e) => setLeadName(e.target.value)}
                      placeholder={t.namePlaceholder}
                      maxLength={200}
                      className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                    />
                    <input
                      value={leadEmail}
                      onChange={(e) => setLeadEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      type="email"
                      maxLength={320}
                      className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                    />
                    <button
                      onClick={handleConnect}
                      className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2.5 transition-colors cursor-pointer"
                    >
                      {leadName.trim() || leadEmail.trim() ? t.startChat : t.connectNow}
                    </button>
                  </div>
                )}
              </>
            )}
            <div ref={transcriptEndRef} />
          </div>

          {inLiveMode && (
            <div className="p-3 border-t border-white/5 flex gap-2">
              <input
                value={message}
                onChange={(e) => handleTyping(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={t.messagePlaceholder}
                disabled={thread?.status === "CLOSED"}
                className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={!message.trim() || thread?.status === "CLOSED"}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 transition-colors cursor-pointer"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ChipMenu({
  step,
  locale,
  t,
  onSelectCategory,
  onSelectQuestion,
  onHelped,
  onTalkToHuman,
}: {
  step: BotStep;
  locale: "en" | "ar";
  t: typeof copy.en;
  onSelectCategory: (categoryId: string) => void;
  onSelectQuestion: (categoryId: string, entryId: string) => void;
  onHelped: () => void;
  onTalkToHuman: () => void;
}) {
  if (step.kind === "captureLead") return null;

  if (step.kind === "categories") {
    return (
      <div className="flex flex-col gap-2">
        {marketingFaqCategories.map((cat) => {
          const Icon = FAQ_CATEGORY_ICONS[cat.id] ?? MessageCircle;
          return (
            <button
              key={cat.id}
              onClick={() => onSelectCategory(cat.id)}
              className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-start text-sm text-white/85 hover:bg-white/10 hover:border-white/20 transition-colors cursor-pointer"
            >
              <Icon className="h-4 w-4 text-blue-400 shrink-0" />
              {cat.label[locale] || cat.label.en}
            </button>
          );
        })}
        <button onClick={onTalkToHuman} className="mt-1 text-xs text-blue-400 hover:text-blue-300 self-start cursor-pointer">
          {t.talkToHuman}
        </button>
      </div>
    );
  }

  const category = marketingFaqCategories.find((c) => c.id === step.categoryId);
  if (!category) return null;

  if (step.kind === "questions") {
    return (
      <div className="flex flex-col gap-2">
        {category.entries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => onSelectQuestion(category.id, entry.id)}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-start text-sm text-white/85 hover:bg-white/10 hover:border-white/20 transition-colors cursor-pointer"
          >
            {entry.question[locale] || entry.question.en}
          </button>
        ))}
        <button onClick={onTalkToHuman} className="mt-1 text-xs text-blue-400 hover:text-blue-300 self-start cursor-pointer">
          {t.talkToHuman}
        </button>
      </div>
    );
  }

  // answered
  return (
    <div className="flex flex-col gap-2 mt-1">
      <button
        onClick={onHelped}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 hover:bg-white/10 transition-colors cursor-pointer"
      >
        <ThumbsUp className="h-3.5 w-3.5" /> {t.helped}
      </button>
      <button
        onClick={onTalkToHuman}
        className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-3 py-2 transition-colors cursor-pointer"
      >
        {t.talkToHuman}
      </button>
    </div>
  );
}
