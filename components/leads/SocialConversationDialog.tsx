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
import { Send, Loader2, MessageCircle, Car } from "lucide-react";

interface SocialConversationDialogProps {
  customerId: Id<"customers"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SocialConversationDialog({ customerId, open, onOpenChange }: SocialConversationDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const events = useQuery(
    api.socialInbox.listEventsForCustomer,
    activeOrgId && customerId ? { orgId: activeOrgId, customerId } : "skip"
  );
  const replyToInstagramComment = useAction(api.instagramEngagement.replyToInstagramComment);
  const sendInstagramDirectMessage = useAction(api.instagramEngagement.sendInstagramDirectMessage);
  const replyToFacebookComment = useAction(api.facebookEngagement.replyToFacebookComment);
  const sendFacebookDirectMessage = useAction(api.facebookEngagement.sendFacebookDirectMessage);

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [dmDraft, setDmDraft] = useState("");
  const [sendingDm, setSendingDm] = useState(false);

  const handleReply = async (event: { _id: string; platform: "instagram" | "facebook" }) => {
    if (!activeOrgId) return;
    const message = (replyDrafts[event._id] ?? "").trim();
    if (!message) return;
    setBusyEventId(event._id);
    try {
      if (event.platform === "facebook") {
        await replyToFacebookComment({
          orgId: activeOrgId,
          facebookEventId: event._id as Id<"facebookEvents">,
          message,
        });
      } else {
        await replyToInstagramComment({
          orgId: activeOrgId,
          instagramEventId: event._id as Id<"instagramEvents">,
          message,
        });
      }
      setReplyDrafts((prev) => ({ ...prev, [event._id]: "" }));
      toast.success(t("ReplySentSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setBusyEventId(null);
    }
  };

  const dmEvent = events?.find((e) => e.kind === "dm");

  const handleSendDm = async () => {
    if (!activeOrgId || !customerId || !dmEvent) return;
    const message = dmDraft.trim();
    if (!message) return;
    setSendingDm(true);
    try {
      if (dmEvent.platform === "facebook") {
        await sendFacebookDirectMessage({ orgId: activeOrgId, customerId, message: dmDraft });
      } else {
        await sendInstagramDirectMessage({ orgId: activeOrgId, customerId, message: dmDraft });
      }
      setDmDraft("");
      toast.success(t("MessageSentSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setSendingDm(false);
    }
  };

  const hasDmEvent = Boolean(dmEvent);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            {t("Conversation" as any)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {events === undefined && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("Loading" as any)}
            </div>
          )}
          {events && events.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("NoConversation" as any)}</p>
          )}
          {events?.map((event, index) => {
            const replied = event.autoRepliedAt ? "auto" : event.manualRepliedAt ? "manual" : null;
            const showVehicleLabel =
              event.vehicleSummary && event.vehicleSummary !== events[index - 1]?.vehicleSummary;
            return (
              <div key={event._id} className="space-y-1.5">
                {showVehicleLabel && (
                  <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground py-1">
                    <Car className="h-3 w-3" />
                    {event.vehicleSummary}
                  </div>
                )}

                {/* Customer bubble (start-aligned) */}
                <div className="flex justify-start">
                  <div className="max-w-[85%] bg-muted rounded-2xl rounded-bl-sm px-3 py-2 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold">{event.senderDisplayName}</span>
                      <Badge variant="secondary" className="text-[9px] py-0 px-1.5">
                        {event.kind === "dm" ? t("DM" as any) : t("Comment" as any)}
                      </Badge>
                    </div>
                    <p className="text-sm">{event.text}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(event._creationTime).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Our reply bubble (end-aligned) — visually distinct so staff can tell their own replies apart */}
                {replied && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-3 py-2 space-y-1">
                      <span className="text-[10px] opacity-80 font-medium">
                        {replied === "auto" ? t("AutoReply" as any) : event.manualRepliedByName ?? t("You" as any)}
                      </span>
                      <p className="text-sm">{replied === "auto" ? event.autoReplyText : event.manualReplyText}</p>
                      <p className="text-[10px] opacity-70">
                        {new Date((replied === "auto" ? event.autoRepliedAt : event.manualRepliedAt) ?? 0).toLocaleString()}
                      </p>
                    </div>
                  </div>
                )}

                {/* Inline reply composer — only when this comment hasn't been replied to yet */}
                {!replied && event.kind === "comment" && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] w-full flex items-center gap-1.5">
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
                        onClick={() => handleReply(event)}
                      >
                        <Send className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
