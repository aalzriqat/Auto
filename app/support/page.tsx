"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";

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

  return (
    <Card className="p-4 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-slate-100">{thread.dealerName || "A dealer"} needs help</p>
        <Badge variant="secondary">{secondsLeft}s</Badge>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await acceptOffer({ threadId: thread._id });
            } catch (e: any) {
              toast.error(e?.data?.message ?? e?.message ?? "Failed to accept");
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
              toast.error(e?.data?.message ?? e?.message ?? "Failed to reject");
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
  const queue = useQuery(api.liveChat.listQueue, {});
  const myActive = useQuery(api.liveChat.listMyActiveThreads, {});
  const claimThread = useMutation(api.liveChat.claimThread);

  const [activeThreadId, setActiveThreadId] = useState<Id<"liveChatThreads"> | null>(null);

  return (
    <div className="flex h-full gap-4">
      <div className="w-80 shrink-0 overflow-y-auto flex flex-col gap-4">
        {queue?.offeredToMe.map((thread) => (
          <OfferedCard key={thread._id} thread={thread} />
        ))}

        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">My active chats</p>
          <Card className="overflow-hidden p-0">
            {myActive?.length === 0 && <p className="text-sm text-slate-500 p-4">No active chats.</p>}
            {myActive?.map((thread) => (
              <button
                key={thread._id}
                onClick={() => setActiveThreadId(thread._id)}
                className={cn(
                  "w-full text-start px-4 py-3 border-b border-slate-800 hover:bg-slate-800/50 transition-colors",
                  activeThreadId === thread._id && "bg-slate-800"
                )}
              >
                <p className="text-sm font-medium text-slate-100 truncate">{thread.dealerName || "Dealer"}</p>
              </button>
            ))}
          </Card>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Unassigned</p>
          <Card className="overflow-hidden p-0">
            {queue?.unassigned.length === 0 && <p className="text-sm text-slate-500 p-4">Nothing waiting.</p>}
            {queue?.unassigned.map((thread) => (
              <div key={thread._id} className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <span className="text-sm text-slate-100 truncate">{thread.dealerName || "Dealer"}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await claimThread({ threadId: thread._id });
                      setActiveThreadId(thread._id);
                    } catch (e: any) {
                      toast.error(e?.data?.message ?? e?.message ?? "Failed to claim");
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
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            Select a conversation
          </div>
        )}
      </Card>
    </div>
  );
}

function ThreadView({ threadId, onClosed }: { threadId: Id<"liveChatThreads">; onClosed: () => void }) {
  const messages = useQuery(api.liveChat.getThreadMessages, { threadId });
  const sendAgentMessage = useMutation(api.liveChat.sendAgentMessage);
  const closeThread = useMutation(api.liveChat.closeThread);
  const requestOrgAccess = useMutation(api.liveChat.requestOrgAccess);
  const revokeOrgAccess = useMutation(api.liveChat.revokeOrgAccess);

  const [reply, setReply] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [accessGrant, setAccessGrant] = useState<{ orgId: string; expiresAt: number } | null>(null);
  const secondsLeft = useCountdown(accessGrant?.expiresAt);

  async function handleSend() {
    if (!reply.trim()) return;
    setIsSending(true);
    try {
      await sendAgentMessage({ threadId, bodyText: reply.trim() });
      setReply("");
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Failed to send reply");
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
      toast.error(e?.data?.message ?? e?.message ?? "Failed to get access");
    }
  }

  async function handleRevokeAccess() {
    try {
      await revokeOrgAccess({ threadId });
      setAccessGrant(null);
      toast.success("Access revoked");
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Failed to revoke access");
    }
  }

  if (!messages) {
    return <div className="h-full flex items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
        <p className="text-sm font-medium text-slate-100">Conversation</p>
        <div className="flex items-center gap-2">
          {accessGrant && secondsLeft > 0 ? (
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
          )}
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

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.map((m) => (
          <div
            key={m._id}
            className={cn(
              "max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
              m.senderType === "AGENT"
                ? "self-end bg-amber-500/15 text-amber-100"
                : "self-start bg-slate-800 text-slate-100"
            )}
          >
            <p>{m.bodyText}</p>
            <p className="text-[10px] text-slate-500 mt-1">{format(m.createdAt, "PP p")}</p>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-slate-800 shrink-0 flex flex-col gap-2">
        <Textarea
          placeholder="Type a reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
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
