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
    <Card className={cn("p-0 bg-slate-900 border-slate-800 overflow-hidden", item.status === "CLOSED" && "opacity-60")}>
      {/* Header row */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className={cn("mt-0.5 shrink-0", isBug ? "text-rose-400" : "text-amber-400")}>
          {isBug ? <Bug className="h-4 w-4" /> : <Lightbulb className="h-4 w-4" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-100 truncate">{item.title}</span>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] shrink-0",
                item.status === "OPEN" ? "border-emerald-600 text-emerald-400" : "border-slate-600 text-slate-400"
              )}
            >
              {item.status}
            </Badge>
            {item.adminReply && (
              <Badge variant="outline" className="text-[10px] border-blue-700 text-blue-400 shrink-0">
                <MessageSquare className="h-2.5 w-2.5 me-1" />
                Replied
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400 flex-wrap">
            <span className="font-medium text-slate-300">{item.orgName}</span>
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
                  className="flex items-center gap-0.5 text-blue-400 hover:underline"
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
          className="text-slate-500 hover:text-slate-300 shrink-0 p-1"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-800 pt-3">
          {item.description && (
            <p className="text-sm text-slate-300 whitespace-pre-wrap">{item.description}</p>
          )}

          {/* Admin reply */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">Admin reply</label>
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply visible internally (for your records)..."
              rows={3}
              className="resize-none bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 text-sm"
            />
            {item.adminRepliedAt && (
              <p className="text-[10px] text-slate-500">
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
              className={cn(
                "gap-1.5",
                item.status === "OPEN"
                  ? "border-emerald-700 text-emerald-400 hover:bg-emerald-900/30"
                  : "border-slate-600 text-slate-400 hover:bg-slate-800"
              )}
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
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Feedback Inbox</h1>
        <p className="text-sm text-slate-400 mt-0.5">Bug reports and feature requests from all organizations.</p>
      </div>

      {/* Type filter */}
      <div className="flex items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={String(tab.type)}
            onClick={() => setTypeFilter(tab.type)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
              typeFilter === tab.type
                ? "bg-amber-500/15 text-amber-400"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            )}
          >
            {tab.label}
          </button>
        ))}
        <div className="h-5 w-px bg-slate-700 mx-1" />
        {statusTabs.map((tab) => (
          <button
            key={String(tab.status)}
            onClick={() => setStatusFilter(tab.status)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
              statusFilter === tab.status
                ? "bg-slate-700 text-slate-100"
                : "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      {items === undefined ? (
        <div className="text-sm text-slate-500">Loading...</div>
      ) : items.length === 0 ? (
        <Card className="p-8 bg-slate-900 border-slate-800 text-center text-sm text-slate-500">
          No submissions found.
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <FeedbackCard key={item._id} item={item} />
          ))}
          <p className="text-xs text-slate-600 text-center">{items.length} item{items.length !== 1 ? "s" : ""}</p>
        </div>
      )}
    </div>
  );
}
