"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatElapsed } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";
import { playChatOfferChime, playChatMessagePing } from "@/lib/chatSound";
import { useTicker } from "@/hooks/useTicker";
import { LIVE_CHAT_ENABLED } from "@/lib/featureFlags";

const TYPING_TIMEOUT_MS = 4_000;
const TYPING_THROTTLE_MS = 2_000;
const DEALER_PRESENCE_STALE_MS = 25_000;
const OFFER_RING_REPEAT_MS = 6_000;

function useCountdown(expiresAt: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function OfferedCard({ thread }: { thread: any }) {
  const acceptOffer = useMutation(api.liveChat.acceptOffer);
  const rejectOffer = useMutation(api.liveChat.rejectOffer);
  const secondsLeft = useCountdown(thread.offerExpiresAt);
  const isLead = thread.kind === "LEAD";

  return (
    <Card className="p-4 border-amber-300 bg-amber-50">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-slate-900">
          {thread.dealerName || (isLead ? "A website visitor" : "A dealer")} needs help
          {isLead && <Badge variant="secondary" className="ms-2 align-middle">Website Lead</Badge>}
        </p>
        <Badge className="bg-amber-500/20 text-amber-700 border-amber-400">{secondsLeft}s</Badge>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await acceptOffer({ threadId: thread._id });
            } catch (e: any) {
              toast.error(e);
            }
          }}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await rejectOffer({ threadId: thread._id });
            } catch (e: any) {
              toast.error(e);
            }
          }}
        >
          Reject
        </Button>
      </div>
    </Card>
  );
}

export default function SupportConsolePage() {
  if (!LIVE_CHAT_ENABLED) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-400">
        Live chat is currently disabled.
      </div>
    );
  }
  return <SupportConsoleImpl />;
}

function SupportConsoleImpl() {
  const queue = useQuery(api.liveChat.listQueue, {});
  const myActive = useQuery(api.liveChat.listMyActiveThreads, {});
  const claimThread = useMutation(api.liveChat.claimThread);

  const [activeThreadId, setActiveThreadId] = useState<Id<"liveChatThreads"> | null>(null);

  // Restore the selected conversation after a refresh — activeThreadId is
  // plain component state, so a reload would otherwise drop back to "Select
  // a conversation" even though the chat itself is still active server-side.
  // Only runs once, on first load, so it doesn't fight a deliberate close.
  const didRestoreSelectionRef = useRef(false);
  useEffect(() => {
    if (didRestoreSelectionRef.current || myActive === undefined) return;
    didRestoreSelectionRef.current = true;
    if (myActive.length > 0) setActiveThreadId(myActive[0]._id);
  }, [myActive]);

  // Ring on a new offer, and keep gently ringing every few seconds while one
  // is still pending — like an incoming call — until it's accepted/rejected/expires.
  const knownOfferIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set<string>((queue?.offeredToMe ?? []).map((t: { _id: string }) => t._id));
    let hasNew = false;
    for (const id of ids) {
      if (!knownOfferIdsRef.current.has(id)) hasNew = true;
    }
    knownOfferIdsRef.current = ids;
    if (hasNew) playChatOfferChime();
  }, [queue?.offeredToMe]);

  useEffect(() => {
    if (!queue?.offeredToMe.length) return;
    const interval = setInterval(() => playChatOfferChime(), OFFER_RING_REPEAT_MS);
    return () => clearInterval(interval);
  }, [queue?.offeredToMe.length]);

  // Ping when an unselected active thread gets a new dealer message.
  const lastSeenMessageAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const thread of myActive ?? []) {
      const id = thread._id as string;
      const prev = lastSeenMessageAtRef.current.get(id) ?? thread.lastMessageAt;
      const isUnread = thread.lastMessageAt > (thread.agentLastReadAt ?? 0);
      if (thread.lastMessageAt > prev && isUnread && activeThreadId !== thread._id) {
        playChatMessagePing();
      }
      lastSeenMessageAtRef.current.set(id, thread.lastMessageAt);
    }
  }, [myActive, activeThreadId]);

  return (
    <div className="flex h-full gap-4">
      <div className="w-80 shrink-0 overflow-y-auto flex flex-col gap-4">
        {queue?.offeredToMe.map((thread: any) => (
          <OfferedCard key={thread._id} thread={thread} />
        ))}

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">My active chats</p>
          <Card className="overflow-hidden p-0">
            {myActive?.length === 0 && <p className="text-sm text-slate-500 p-4">No active chats.</p>}
            {myActive?.map((thread: any) => {
              const isUnread =
                thread.lastMessageAt > (thread.agentLastReadAt ?? 0) && activeThreadId !== thread._id;
              return (
                <button
                  key={thread._id}
                  onClick={() => setActiveThreadId(thread._id)}
                  className={cn(
                    "w-full text-start px-4 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors flex items-center justify-between gap-2",
                    activeThreadId === thread._id && "bg-primary/10"
                  )}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={cn("text-sm truncate", isUnread ? "font-semibold text-slate-900" : "text-slate-700")}>
                      {thread.dealerName || (thread.kind === "LEAD" ? "Website visitor" : "Dealer")}
                    </span>
                    {thread.kind === "LEAD" && <Badge variant="secondary" className="shrink-0 text-[10px]">Lead</Badge>}
                  </span>
                  {isUnread && <span className="h-2 w-2 rounded-full bg-rose-500 shrink-0" />}
                </button>
              );
            })}
          </Card>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Unassigned</p>
          <Card className="overflow-hidden p-0">
            {queue?.unassigned.length === 0 && <p className="text-sm text-slate-500 p-4">Nothing waiting.</p>}
            {queue?.unassigned.map((thread: any) => (
              <div key={thread._id} className="flex items-center justify-between px-4 py-3 border-b border-slate-100 last:border-b-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm text-slate-700 truncate">
                    {thread.dealerName || (thread.kind === "LEAD" ? "Website visitor" : "Dealer")}
                  </span>
                  {thread.kind === "LEAD" && <Badge variant="secondary" className="shrink-0 text-[10px]">Lead</Badge>}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await claimThread({ threadId: thread._id });
                      setActiveThreadId(thread._id);
                    } catch (e: any) {
                      toast.error(e);
                    }
                  }}
                >
                  Claim
                </Button>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Card className="flex-1 overflow-hidden p-0">
        {activeThreadId ? (
          <ThreadView threadId={activeThreadId} onClosed={() => setActiveThreadId(null)} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-slate-400">
            Select a conversation
          </div>
        )}
      </Card>
    </div>
  );
}

function ThreadView({ threadId, onClosed }: { threadId: Id<"liveChatThreads">; onClosed: () => void }) {
  const thread = useQuery(api.liveChat.getThreadForAgent, { threadId });
  const messages = useQuery(api.liveChat.getThreadMessages, { threadId });
  const sendAgentMessage = useMutation(api.liveChat.sendAgentMessage);
  const closeThread = useMutation(api.liveChat.closeThread);
  const requestOrgAccess = useMutation(api.liveChat.requestOrgAccess);
  const revokeOrgAccess = useMutation(api.liveChat.revokeOrgAccess);
  const markThreadReadByAgent = useMutation(api.liveChat.markThreadReadByAgent);
  const setAgentTyping = useMutation(api.liveChat.setAgentTyping);
  const updateAgentPresence = useMutation(api.liveChat.updateAgentPresence);
  useTicker(1000);

  const [reply, setReply] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [accessGrant, setAccessGrant] = useState<{ orgId: string; expiresAt: number } | null>(null);
  const secondsLeft = useCountdown(accessGrant?.expiresAt);

  useEffect(() => {
    markThreadReadByAgent({ threadId });
  }, [threadId, messages?.length, markThreadReadByAgent]);

  // Report presence (active/idle) for this specific conversation while it's
  // the one selected — lets the dealer see when the agent steps away.
  useEffect(() => {
    const report = () => {
      const state = document.visibilityState === "visible" ? "active" : "idle";
      updateAgentPresence({ threadId, state });
    };
    report();
    const interval = setInterval(report, 10_000);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
    };
  }, [threadId, updateAgentPresence]);

  const lastTypingSentRef = useRef(0);
  function handleReplyChange(value: string) {
    setReply(value);
    const now = Date.now();
    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now;
      setAgentTyping({ threadId });
    }
  }

  async function handleSend() {
    if (!reply.trim()) return;
    setIsSending(true);
    try {
      await sendAgentMessage({ threadId, bodyText: reply.trim() });
      setReply("");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setIsSending(false);
    }
  }

  async function handleRequestAccess() {
    try {
      const result = await requestOrgAccess({ threadId });
      setAccessGrant(result);
      toast.success("Access granted");
    } catch (e: any) {
      toast.error(e);
    }
  }

  async function handleRevokeAccess() {
    try {
      await revokeOrgAccess({ threadId });
      setAccessGrant(null);
      toast.success("Access revoked");
    } catch (e: any) {
      toast.error(e);
    }
  }

  if (!messages || thread === undefined) {
    return <div className="h-full flex items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  const dealerIsTyping = Boolean(
    thread?.dealerTypingAt && Date.now() - thread.dealerTypingAt < TYPING_TIMEOUT_MS
  );
  const dealerIsPresent = Boolean(
    thread?.dealerPresenceAt && Date.now() - thread.dealerPresenceAt < DEALER_PRESENCE_STALE_MS
  );
  const dealerPresenceLabel = !dealerIsPresent
    ? thread?.dealerPresenceAt
      ? `Away ${formatElapsed(Date.now() - thread.dealerPresenceAt)}`
      : "Away"
    : thread?.dealerPresence === "idle"
    ? thread.dealerPresenceSince
      ? `Idle ${formatElapsed(Date.now() - thread.dealerPresenceSince)}`
      : "Idle"
    : "Online";
  const dealerPresenceColor = !dealerIsPresent
    ? "bg-slate-400"
    : thread?.dealerPresence === "idle"
    ? "bg-amber-500"
    : "bg-emerald-500";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-900">
            {thread?.dealerName || (thread?.kind === "LEAD" ? "Website visitor" : "Conversation")}
          </p>
          {thread?.kind === "LEAD" ? (
            <>
              <Badge variant="secondary">Website Lead{thread.leadEmail ? ` · ${thread.leadEmail}` : ""}</Badge>
              {dealerIsTyping && <span className="text-xs text-slate-500">Typing…</span>}
            </>
          ) : (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <span className={cn("h-2 w-2 rounded-full", dealerPresenceColor)} />
              {dealerIsTyping ? "Typing…" : dealerPresenceLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {thread?.orgId &&
            (accessGrant && secondsLeft > 0 ? (
              <>
                <Badge variant="secondary">Access {Math.ceil(secondsLeft / 60)}m left</Badge>
                <Button size="sm" variant="outline" asChild>
                  <a href={`/${accessGrant.orgId}/dashboard`} target="_blank" rel="noreferrer">
                    Open dealer dashboard ↗
                  </a>
                </Button>
                <Button size="sm" variant="outline" onClick={handleRevokeAccess}>
                  Revoke now
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={handleRequestAccess}>
                Get access to dealer's dashboard
              </Button>
            ))}
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await closeThread({ threadId });
              onClosed();
            }}
          >
            Close
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-slate-50/50">
        {messages.map((m: any) =>
          m.isSystem ? (
            <p key={m._id} className="self-center text-xs text-slate-400 italic">
              {m.bodyText}
            </p>
          ) : (
            <div
              key={m._id}
              className={cn(
                "max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                m.senderType === "AGENT"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-white border border-slate-200 text-slate-900"
              )}
            >
              <p>{m.bodyText}</p>
              <p className={cn("text-[10px] mt-1", m.senderType === "AGENT" ? "text-primary-foreground/70" : "text-slate-400")}>
                {format(m.createdAt, "PP p")}
              </p>
            </div>
          )
        )}
        {dealerIsTyping && <p className="self-start text-xs text-slate-400 italic">{thread?.dealerName || "Dealer"} is typing…</p>}
      </div>

      <div className="p-4 border-t border-slate-100 shrink-0 flex flex-col gap-2">
        <Textarea
          placeholder="Type a reply…"
          value={reply}
          onChange={(e) => handleReplyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={3}
        />
        <Button onClick={handleSend} disabled={isSending || !reply.trim()} className="self-end">
          {isSending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
