"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { Bug, Lightbulb, CheckCircle2, RotateCcw, MessageSquare, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/admin/ui";

type FeedbackType = "BUG" | "FEATURE" | undefined;
type FeedbackStatus = "OPEN" | "CLOSED" | undefined;

type FeedbackItem = {
  _id: Id<"feedback">;
  orgName: string;
  userName: string;
  type: "BUG" | "FEATURE";
  title: string;
  description?: string;
  url?: string;
  status: "OPEN" | "CLOSED";
  createdAt: number;
  adminReply?: string;
  adminRepliedAt?: number;
  resolvedAt?: number;
};

function FeedbackCard({ item }: { item: FeedbackItem }) {
  const [expanded, setExpanded] = useState(false);
  const [replyText, setReplyText] = useState(item.adminReply ?? "");
  const [savingReply, setSavingReply] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  const adminReply = useMutation(api.feedback.adminReply);
  const adminSetStatus = useMutation(api.feedback.adminSetStatus);

  async function handleSaveReply() {
    if (!replyText.trim()) return;
    setSavingReply(true);
    try {
      await adminReply({ feedbackId: item._id, reply: replyText });
      toast.success("Reply saved.");
    } catch {
      toast.error("Failed to save reply.");
    } finally {
      setSavingReply(false);
    }
  }

  async function handleToggleStatus() {
    setTogglingStatus(true);
    try {
      await adminSetStatus({
        feedbackId: item._id,
        status: item.status === "OPEN" ? "CLOSED" : "OPEN",
      });
      toast.success(item.status === "OPEN" ? "Marked as resolved." : "Reopened.");
    } catch {
      toast.error("Failed to update status.");
    } finally {
      setTogglingStatus(false);
    }
  }

  const isBug = item.type === "BUG";

  return (
    <Card className={cn("overflow-hidden p-0 shadow-sm", item.status === "CLOSED" && "opacity-60")}>
      {/* Header row */}
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <div className={cn("mt-0.5 shrink-0", isBug ? "text-destructive" : "text-amber-500")}>
          {isBug ? <Bug className="h-4 w-4" /> : <Lightbulb className="h-4 w-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[10px]",
                item.status === "OPEN"
                  ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                  : "border-border text-muted-foreground"
              )}
            >
              {item.status}
            </Badge>
            {item.adminReply && (
              <Badge variant="outline" className="shrink-0 border-primary/40 text-[10px] text-primary">
                <MessageSquare className="me-1 h-2.5 w-2.5" />
                Replied
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{item.orgName}</span>
            <span>·</span>
            <span>{item.userName}</span>
            <span>·</span>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
            {item.url && (
              <>
                <span>·</span>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-primary hover:underline"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  {item.url}
                </a>
              </>
            )}
          </div>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
          {item.description && (
            <p className="whitespace-pre-wrap text-sm text-foreground">{item.description}</p>
          )}

          {/* Admin reply */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Admin reply</label>
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply visible internally (for your records)..."
              rows={3}
              className="resize-none text-sm"
            />
            {item.adminRepliedAt && (
              <p className="text-[10px] text-muted-foreground">
                Last saved {new Date(item.adminRepliedAt).toLocaleString()}
              </p>
            )}
            <Button
              size="sm"
              onClick={handleSaveReply}
              disabled={savingReply || !replyText.trim()}
            >
              {savingReply ? "Saving..." : "Save reply"}
            </Button>
          </div>

          {/* Status action */}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={handleToggleStatus}
              disabled={togglingStatus}
              className="gap-1.5"
            >
              {item.status === "OPEN" ? (
                <><CheckCircle2 className="h-3.5 w-3.5" /> Mark resolved</>
              ) : (
                <><RotateCcw className="h-3.5 w-3.5" /> Reopen</>
              )}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function AdminFeedbackPage() {
  const [typeFilter, setTypeFilter] = useState<FeedbackType>(undefined);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus>("OPEN");

  const items = useQuery(api.feedback.adminList, {
    type: typeFilter,
    status: statusFilter,
  }) as FeedbackItem[] | undefined;

  const tabs: { label: string; type: FeedbackType }[] = [
    { label: "All", type: undefined },
    { label: "Bugs", type: "BUG" },
    { label: "Feature Requests", type: "FEATURE" },
  ];

  const statusTabs: { label: string; status: FeedbackStatus }[] = [
    { label: "Open", status: "OPEN" },
    { label: "Closed", status: "CLOSED" },
    { label: "All", status: undefined },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Feedback Inbox" description="Bug reports and feature requests from all organizations." />

      {/* Type filter */}
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={String(tab.type)}
            onClick={() => setTypeFilter(tab.type)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              typeFilter === tab.type
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        {statusTabs.map((tab) => (
          <button
            key={String(tab.status)}
            onClick={() => setStatusFilter(tab.status)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              statusFilter === tab.status
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      {items === undefined ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No submissions found.
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <FeedbackCard key={item._id} item={item} />
          ))}
          <p className="text-center text-xs text-muted-foreground">{items.length} item{items.length !== 1 ? "s" : ""}</p>
        </div>
      )}
    </div>
  );
}
