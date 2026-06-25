"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, Loader2, MessageCircle, Car, ExternalLink, RefreshCw } from "lucide-react";

/** Identifies a specific conversation thread in the Social Inbox. */
export type ConversationKey = {
  customerId: Id<"customers">;
  platform: "instagram" | "facebook";
  conversationKind: "comment" | "dm";
  conversationPostId: string | null;
};

interface SocialConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Social Inbox path: opens only the events for this specific thread
   * (platform × customer × post for comments; platform × customer for DMs).
   */
  conversationKey?: ConversationKey | null;
  /**
   * Leads page path: opens all events for this customer across all platforms
   * and threads. Ignored when conversationKey is provided.
   */
  customerId?: Id<"customers"> | null;
}

function buildPostUrl(
  platform: "instagram" | "facebook",
  kind: "comment" | "dm",
  postId: string | undefined | null,
  senderHandle: string | undefined | null
): string | null {
  if (kind === "dm") {
    return platform === "facebook"
      ? "https://www.facebook.com/messages/"
      : "https://www.instagram.com/direct/inbox/";
  }
  if (platform === "facebook" && postId) {
    return `https://www.facebook.com/${postId}`;
  }
  if (platform === "instagram" && senderHandle) {
    return `https://www.instagram.com/${senderHandle}/`;
  }
  return null;
}

export function SocialConversationDialog({
  open,
  onOpenChange,
  conversationKey,
  customerId,
}: SocialConversationDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const isManager = hasPermission(PERMISSIONS.APPROVE_REQUESTS);

  const ck = conversationKey ?? null;
  const effectiveCustomerId = ck?.customerId ?? customerId ?? null;

  // Social Inbox mode: fetch only this conversation's events
  const conversationEvents = useQuery(
    api.socialInbox.listEventsForConversation,
    ck && activeOrgId
      ? {
          orgId: activeOrgId,
          customerId: ck.customerId,
          platform: ck.platform,
          conversationKind: ck.conversationKind,
          ...(ck.conversationPostId != null ? { conversationPostId: ck.conversationPostId } : {}),
        }
      : "skip"
  );

  // Leads page mode: fetch all events for this customer
  const customerEvents = useQuery(
    api.socialInbox.listEventsForCustomer,
    !ck && activeOrgId && effectiveCustomerId
      ? { orgId: activeOrgId, customerId: effectiveCustomerId }
      : "skip"
  );

  const events = ck ? conversationEvents : customerEvents;

  const vehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId && isManager ? { orgId: activeOrgId } : "skip"
  );

  // Full Messenger thread — only fetched for Facebook DM conversations.
  const isFbDm = ck?.platform === "facebook" && ck?.conversationKind === "dm";

  const fbMessages = useQuery(
    api.facebookEngagement.listFbMessages,
    isFbDm && activeOrgId && effectiveCustomerId
      ? { orgId: activeOrgId, customerId: effectiveCustomerId }
      : "skip"
  );

  const fetchFbHistory = useAction(api.facebookEngagement.fetchFbConversationHistory);
  const [syncing, setSyncing] = useState(false);
  const autoSyncedRef = useRef(false);

  // Auto-trigger history sync the first time the dialog opens with no messages.
  useEffect(() => {
    if (!isFbDm || !activeOrgId || !effectiveCustomerId) return;
    if (fbMessages === undefined) return; // still loading
    if (fbMessages.length > 0 || autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    setSyncing(true);
    fetchFbHistory({ orgId: activeOrgId, customerId: effectiveCustomerId })
      .catch(() => {})
      .finally(() => setSyncing(false));
  }, [isFbDm, fbMessages, activeOrgId, effectiveCustomerId]);

  // Reset auto-sync flag when dialog closes so re-open re-syncs if still empty.
  useEffect(() => {
    if (!open) autoSyncedRef.current = false;
  }, [open]);

  const replyToInstagramComment = useAction(api.instagramEngagement.replyToInstagramComment);
  const sendInstagramDirectMessage = useAction(api.instagramEngagement.sendInstagramDirectMessage);
  const replyToFacebookComment = useAction(api.facebookEngagement.replyToFacebookComment);
  const sendFacebookDirectMessage = useAction(api.facebookEngagement.sendFacebookDirectMessage);
  const setConversationVehicle = useMutation(api.socialInbox.setConversationVehicle);

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [dmDraft, setDmDraft] = useState("");
  const [sendingDm, setSendingDm] = useState(false);
  const [linkingVehicle, setLinkingVehicle] = useState(false);

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
    if (!activeOrgId || !effectiveCustomerId || !dmEvent) return;
    const message = dmDraft.trim();
    if (!message) return;
    setSendingDm(true);
    try {
      if (dmEvent.platform === "facebook") {
        await sendFacebookDirectMessage({ orgId: activeOrgId, customerId: effectiveCustomerId, message: dmDraft });
      } else {
        await sendInstagramDirectMessage({ orgId: activeOrgId, customerId: effectiveCustomerId, message: dmDraft });
      }
      setDmDraft("");
      toast.success(t("MessageSentSuccess" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setSendingDm(false);
    }
  };

  const handleLinkVehicle = async (vehicleId: string) => {
    if (!activeOrgId || !effectiveCustomerId) return;
    setLinkingVehicle(true);
    try {
      await setConversationVehicle({
        orgId: activeOrgId,
        customerId: effectiveCustomerId,
        vehicleId: vehicleId as Id<"vehicles">,
        // Scope to this conversation when in Social Inbox mode
        ...(ck
          ? {
              platform: ck.platform,
              conversationKind: ck.conversationKind,
              ...(ck.conversationPostId != null ? { conversationPostId: ck.conversationPostId } : {}),
            }
          : {}),
      });
      toast.success(t("VehicleLinked" as any));
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setLinkingVehicle(false);
    }
  };

  const handleSyncHistory = async () => {
    if (!activeOrgId || !effectiveCustomerId) return;
    setSyncing(true);
    try {
      const result = await fetchFbHistory({ orgId: activeOrgId, customerId: effectiveCustomerId });
      toast.success(`Synced ${result.synced} messages`);
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setSyncing(false);
    }
  };

  const hasDmEvent = isFbDm
    ? Boolean(fbMessages && fbMessages.length > 0)
    : Boolean(dmEvent);
  const conversationVehicleId = events?.find((e) => e.vehicleId)?.vehicleId;
  const anyUnlinked = events?.some((e) => !e.vehicleId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            {t("Conversation" as any)}
          </DialogTitle>
        </DialogHeader>

        {/* Manager-only: vehicle linker — shown when any event in the thread is unlinked */}
        {isManager && anyUnlinked && vehicles && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/60 border border-dashed">
            <Car className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground flex-1">
              {conversationVehicleId
                ? t("VehicleAutoLinked" as any)
                : t("LinkVehiclePrompt" as any)}
            </span>
            <Select onValueChange={handleLinkVehicle} disabled={linkingVehicle} value={conversationVehicleId ?? ""}>
              <SelectTrigger className="h-7 text-xs w-44 shrink-0">
                <SelectValue placeholder={t("SelectVehicle" as any)} />
              </SelectTrigger>
              <SelectContent>
                {vehicles.map((v) => (
                  <SelectItem key={v._id} value={v._id}>
                    {v.year} {v.make} {v.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {linkingVehicle && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
          </div>
        )}

        {/* ── Facebook DM: full Messenger-style thread ── */}
        {isFbDm ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {fbMessages === undefined || syncing
                  ? t("Loading" as any)
                  : `${fbMessages.length} messages`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 text-[10px] px-2"
                onClick={handleSyncHistory}
                disabled={syncing}
              >
                {syncing
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
                {syncing ? t("Loading" as any) : "Sync history"}
              </Button>
            </div>

            {fbMessages !== undefined && fbMessages.length === 0 && !syncing && (
              <p className="text-sm text-muted-foreground">{t("NoConversation" as any)}</p>
            )}

            {fbMessages?.map((msg) => (
              <div
                key={msg._id}
                className={`flex ${msg.direction === "out" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 space-y-0.5 ${
                    msg.direction === "out"
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-muted rounded-bl-sm"
                  }`}
                >
                  {msg.text && <p className="text-sm">{msg.text}</p>}
                  <p className={`text-[10px] ${msg.direction === "out" ? "opacity-70" : "text-muted-foreground"}`}>
                    {new Date(msg.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ── All other conversations: event-based view ── */
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
              const postUrl = buildPostUrl(event.platform, event.kind, event.postId, event.senderHandle);
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-semibold">{event.senderDisplayName}</span>
                        <Badge variant="secondary" className="text-[9px] py-0 px-1.5">
                          {event.kind === "dm" ? t("DM" as any) : t("Comment" as any)}
                        </Badge>
                        {postUrl && (
                          <a
                            href={postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-2.5 w-2.5" />
                            {event.kind === "dm" ? t("OpenInbox" as any) : t("ViewPost" as any)}
                          </a>
                        )}
                      </div>
                      <p className="text-sm">{event.text}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(event._creationTime).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  {/* Our reply bubble (end-aligned) */}
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

                  {/* Inline reply composer — comments only */}
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
        )}

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
