"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Send, Loader2, MessageCircle, CheckCircle2 } from "lucide-react";

interface SocialConversationDialogProps {
  leadId: Id<"leads"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SocialConversationDialog({ leadId, open, onOpenChange }: SocialConversationDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const events = useQuery(
    api.instagramEngagement.listEventsForLead,
    activeOrgId && leadId ? { orgId: activeOrgId, leadId } : "skip"
  );
  const replyToComment = useAction(api.instagramEngagement.replyToInstagramComment);
  const sendDirectMessage = useAction(api.instagramEngagement.sendInstagramDirectMessage);

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [dmDraft, setDmDraft] = useState("");
  const [sendingDm, setSendingDm] = useState(false);

  const handleReply = async (eventId: Id<"instagramEvents">) => {
    if (!activeOrgId) return;
    const message = (replyDrafts[eventId] ?? "").trim();
    if (!message) return;
    setBusyEventId(eventId);
    try {
      await replyToComment({ orgId: activeOrgId, instagramEventId: eventId, message });
      setReplyDrafts((prev) => ({ ...prev, [eventId]: "" }));
      toast.success(t("ReplySentSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setBusyEventId(null);
    }
  };

  const handleSendDm = async () => {
    if (!activeOrgId || !leadId) return;
    const message = dmDraft.trim();
    if (!message) return;
    setSendingDm(true);
    try {
      await sendDirectMessage({ orgId: activeOrgId, leadId, message: dmDraft });
      setDmDraft("");
      toast.success(t("MessageSentSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setSendingDm(false);
    }
  };

  const hasDmEvent = events?.some((e) => e.kind === "dm") ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            {t("Conversation" as any)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {events === undefined && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("Loading" as any)}
            </div>
          )}
          {events && events.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("NoConversation" as any)}</p>
          )}
          {events?.map((event) => (
            <div key={event._id} className="bg-muted/30 p-3 rounded-lg border text-sm space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs">
                  <span className="font-semibold">{event.senderUsername ?? event.senderInstagramId}</span>{" "}
                  <Badge variant="secondary" className="text-[10px] py-0">
                    {event.kind === "dm" ? t("DM" as any) : t("Comment" as any)}
                  </Badge>
                </p>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(event._creationTime).toLocaleString()}
                </span>
              </div>
              <p className="text-sm">{event.text}</p>

              {event.autoRepliedAt && (
                <div className="bg-background p-2 rounded border text-xs flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-muted-foreground">{t("AutoReplied" as any)}: </span>
                    {event.autoReplyText}
                  </div>
                </div>
              )}
              {!event.autoRepliedAt && event.manualRepliedAt && (
                <div className="bg-background p-2 rounded border text-xs flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-muted-foreground">{t("Replied" as any)}: </span>
                    {event.manualReplyText}
                  </div>
                </div>
              )}
              {!event.autoRepliedAt && !event.manualRepliedAt && event.kind === "comment" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={replyDrafts[event._id] ?? ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [event._id]: e.target.value }))}
                    placeholder={t("WriteAReply" as any)}
                    className="flex-1 h-7 text-xs px-2 rounded border bg-background"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0 shrink-0"
                    disabled={busyEventId === event._id || !(replyDrafts[event._id] ?? "").trim()}
                    onClick={() => handleReply(event._id)}
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        {hasDmEvent && (
          <div className="flex items-center gap-1.5 border-t pt-3">
            <input
              type="text"
              value={dmDraft}
              onChange={(e) => setDmDraft(e.target.value)}
              placeholder={t("WriteAMessage" as any)}
              className="flex-1 h-9 text-sm px-3 rounded border bg-background"
            />
            <Button size="sm" disabled={sendingDm || !dmDraft.trim()} onClick={handleSendDm}>
              {sendingDm ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
