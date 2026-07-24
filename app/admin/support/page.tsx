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
import { ArrowLeft } from "lucide-react";

export default function AdminSupportPage() {
  const [inbox, setInbox] = useState<"support" | "info" | "subscriptions">("support");
  const [activeThreadId, setActiveThreadId] = useState<Id<"supportThreads"> | null>(null);

  const { results: threads, loadMore, status } = usePaginatedQuery(
    api.support.listThreads,
    { inbox },
    { initialNumItems: 30 }
  );

  return (
    <div className="flex h-[calc(100dvh-8rem)] gap-4 lg:h-[calc(100dvh-6rem)]">
      {/* Thread list */}
      <Card
        className={cn(
          "w-full shrink-0 overflow-y-auto p-0 lg:w-80",
          activeThreadId && "hidden lg:block"
        )}
      >
        <div className="flex shrink-0 border-b border-border">
          {(["support", "info", "subscriptions"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setInbox(tab);
                setActiveThreadId(null);
              }}
              className={cn(
                "flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                inbox === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "support" ? "Support" : tab === "info" ? "Info" : "Billing"}
            </button>
          ))}
        </div>
        {threads.length === 0 && <p className="p-4 text-sm text-muted-foreground">No messages yet.</p>}
        {threads.map((thread) => (
          <button
            key={thread._id}
            onClick={() => setActiveThreadId(thread._id)}
            className={cn(
              "w-full border-b border-border px-4 py-3 text-start transition-colors hover:bg-muted/50",
              activeThreadId === thread._id && "bg-muted"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-foreground">
                {thread.participantName || thread.participantEmail}
              </p>
              {thread.status === "OPEN" ? (
                <Badge variant="secondary" className="shrink-0">Open</Badge>
              ) : (
                <Badge variant="outline" className="shrink-0">Closed</Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">{thread.participantEmail}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{thread.subject}</p>
          </button>
        ))}
        {status === "CanLoadMore" && (
          <Button variant="outline" className="m-3 w-[calc(100%-1.5rem)]" onClick={() => loadMore(30)}>
            Load more
          </Button>
        )}
      </Card>

      {/* Thread view */}
      <Card
        className={cn(
          "flex-1 overflow-hidden p-0",
          !activeThreadId && "hidden lg:block"
        )}
      >
        {activeThreadId ? (
          <ThreadView threadId={activeThreadId} onBack={() => setActiveThreadId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a conversation
          </div>
        )}
      </Card>
    </div>
  );
}

function ThreadView({ threadId, onBack }: { threadId: Id<"supportThreads">; onBack: () => void }) {
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
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  const { thread, messages } = data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="-ms-2 h-8 w-8 lg:hidden" onClick={onBack} aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{thread.participantName || thread.participantEmail}</p>
            <p className="truncate text-xs text-muted-foreground">{thread.participantEmail}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setThreadStatus({ threadId, status: thread.status === "OPEN" ? "CLOSED" : "OPEN" })}
        >
          {thread.status === "OPEN" ? "Close" : "Reopen"}
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.map((m: (typeof messages)[number]) => (
          <div
            key={m._id}
            className={cn(
              "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm sm:max-w-[75%]",
              m.direction === "OUTBOUND"
                ? "self-end bg-primary text-primary-foreground"
                : "self-start bg-muted text-foreground"
            )}
          >
            <p>{m.bodyText || "(no text content)"}</p>
            <p
              className={cn(
                "mt-1 text-[10px]",
                m.direction === "OUTBOUND" ? "text-primary-foreground/70" : "text-muted-foreground"
              )}
            >
              {format(m.createdAt, "PP p")}
            </p>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-4">
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
