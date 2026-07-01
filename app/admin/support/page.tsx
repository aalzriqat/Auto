"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";

export default function AdminSupportPage() {
  const [inbox, setInbox] = useState<"support" | "info" | "subscriptions">("support");
  const [activeThreadId, setActiveThreadId] = useState<Id<"supportThreads"> | null>(null);

  const { results: threads, loadMore, status } = usePaginatedQuery(
    api.support.listThreads,
    { inbox },
    { initialNumItems: 30 }
  );

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      <Card className="w-80 shrink-0 overflow-y-auto p-0">
        <div className="flex border-b border-slate-800 shrink-0">
          {(["support", "info", "subscriptions"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setInbox(tab);
                setActiveThreadId(null);
              }}
              className={cn(
                "flex-1 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors",
                inbox === tab
                  ? "border-amber-500 text-amber-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              )}
            >
              {tab === "support" ? "Support" : tab === "info" ? "Info" : "Billing"}
            </button>
          ))}
        </div>
        {threads.length === 0 && (
          <p className="text-sm text-slate-500 p-4">No messages yet.</p>
        )}
        {threads.map((thread) => (
          <button
            key={thread._id}
            onClick={() => setActiveThreadId(thread._id)}
            className={cn(
              "w-full text-start px-4 py-3 border-b border-slate-800 hover:bg-slate-800/50 transition-colors",
              activeThreadId === thread._id && "bg-slate-800"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-100 truncate">
                {thread.participantName || thread.participantEmail}
              </p>
              {thread.status === "OPEN" ? (
                <Badge variant="secondary" className="shrink-0">Open</Badge>
              ) : (
                <Badge variant="outline" className="shrink-0">Closed</Badge>
              )}
            </div>
            <p className="text-xs text-slate-500 truncate">{thread.participantEmail}</p>
            <p className="text-xs text-slate-400 truncate mt-1">{thread.subject}</p>
          </button>
        ))}
        {status === "CanLoadMore" && (
          <Button variant="outline" className="m-3 w-[calc(100%-1.5rem)]" onClick={() => loadMore(30)}>
            Load more
          </Button>
        )}
      </Card>

      <Card className="flex-1 overflow-hidden p-0">
        {activeThreadId ? (
          <ThreadView threadId={activeThreadId} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            Select a conversation
          </div>
        )}
      </Card>
    </div>
  );
}

function ThreadView({ threadId }: { threadId: Id<"supportThreads"> }) {
  const data = useQuery(api.support.getThreadMessages, { threadId });
  const setThreadStatus = useMutation(api.support.setThreadStatus);
  const sendReply = useAction(api.support.sendReply);

  const [reply, setReply] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function handleSend() {
    if (!reply.trim()) return;
    setIsSending(true);
    try {
      await sendReply({ threadId, bodyText: reply.trim() });
      setReply("");
      toast.success("Reply sent");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setIsSending(false);
    }
  }

  if (!data) {
    return <div className="h-full flex items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  const { thread, messages } = data;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
        <div>
          <p className="text-sm font-medium text-slate-100">{thread.participantName || thread.participantEmail}</p>
          <p className="text-xs text-slate-500">{thread.participantEmail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setThreadStatus({ threadId, status: thread.status === "OPEN" ? "CLOSED" : "OPEN" })}
        >
          {thread.status === "OPEN" ? "Close thread" : "Reopen thread"}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.map((m: (typeof messages)[number]) => (
          <div
            key={m._id}
            className={cn(
              "max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
              m.direction === "OUTBOUND"
                ? "self-end bg-amber-500 text-white"
                : "self-start bg-slate-100 text-slate-900"
            )}
          >
            <p>{m.bodyText || "(no text content)"}</p>
            <p className={cn("text-[10px] mt-1", m.direction === "OUTBOUND" ? "text-amber-100" : "text-slate-400")}>{format(m.createdAt, "PP p")}</p>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-slate-800 shrink-0 flex flex-col gap-2">
        <Textarea
          placeholder="Type a reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={3}
        />
        <Button onClick={handleSend} disabled={isSending || !reply.trim()} className="self-end">
          {isSending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </div>
  );
}
