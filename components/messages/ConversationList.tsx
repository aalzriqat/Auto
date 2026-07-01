"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, Users, BellOff } from "lucide-react";
import { NewConversationDialog } from "./NewConversationDialog";

interface Props {
  orgId: Id<"organizations">;
  currentUserId: Id<"users">;
  activeId: Id<"dmConversations"> | null;
  onSelect: (id: Id<"dmConversations">) => void;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ConversationList({ orgId, currentUserId, activeId, onSelect }: Props) {
  const { t, isRtl } = useLanguage();
  const [search, setSearch] = useState("");
  const [dialogMode, setDialogMode] = useState<"dm" | "group" | null>(null);

  const conversations = useQuery(api.directMessages.listConversations, { orgId });

  type ConvMember = { _id: string; name?: string; imageUrl?: string } | null;
  type ConvItem = { _id: Id<"dmConversations">; type: string; name?: string; members?: ConvMember[]; isMuted?: boolean; hasUnread?: boolean; lastMessageAt: number; lastMessageSenderId?: string; lastMessageBody?: string };
  const filtered = (conversations ?? [] as ConvItem[]).filter((c: ConvItem) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (c.name?.toLowerCase().includes(q)) return true;
    return c.members?.some((m: ConvMember) => m?.name?.toLowerCase().includes(q));
  });

  return (
    <div className="flex flex-col h-full border-e border-slate-200/50 bg-white w-72 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200/50 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">{t("Messages")}</h2>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setDialogMode("dm")}
              title={t("MessagesNewDm")}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setDialogMode("group")}
              title={t("MessagesNewGroup")}
            >
              <Users className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Input
          placeholder={t("MessagesSearchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm bg-slate-50 border-slate-200"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            <p className="font-medium">{t("MessagesNoConversations")}</p>
            <p className="text-xs mt-1">{t("MessagesNoConversationsHint")}</p>
          </div>
        )}

        {filtered.map((conv: ConvItem) => {
          const isDm = conv.type === "DM";
          const other = isDm
            ? conv.members?.find((m: ConvMember) => m?._id !== currentUserId)
            : null;

          const displayName = isDm
            ? (other?.name ?? "…")
            : (conv.name ?? t("MessagesGroupWith"));

          const displayImage = isDm ? other?.imageUrl : undefined;
          const isActive = conv._id === activeId;

          return (
            <button
              key={conv._id}
              onClick={() => onSelect(conv._id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 transition-colors text-start",
                isActive
                  ? "bg-primary/10"
                  : "hover:bg-slate-50"
              )}
            >
              <div className="relative shrink-0">
                <Avatar className="h-10 w-10">
                  {displayImage && <AvatarImage src={displayImage} />}
                  <AvatarFallback className="text-sm bg-slate-200">
                    {displayName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                {conv.hasUnread && (
                  <span className="absolute -top-0.5 -end-0.5 w-3 h-3 rounded-full bg-blue-500 border-2 border-white" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={cn(
                      "text-sm truncate",
                      conv.hasUnread ? "font-semibold text-slate-900" : "font-medium text-slate-700"
                    )}
                  >
                    {displayName}
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">
                    {formatRelativeTime(conv.lastMessageAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <p
                    className={cn(
                      "text-xs truncate flex-1",
                      conv.hasUnread ? "text-slate-700 font-medium" : "text-slate-400"
                    )}
                  >
                    {conv.lastMessageBody
                      ? (conv.lastMessageSenderId === currentUserId
                          ? `${t("MessagesYou")}: ${conv.lastMessageBody}`
                          : conv.lastMessageBody)
                      : "…"}
                  </p>
                  {conv.isMuted && (
                    <BellOff className="h-3 w-3 text-slate-300 shrink-0" />
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Dialogs */}
      {dialogMode && (
        <NewConversationDialog
          orgId={orgId}
          open={true}
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onConversationCreated={(id) => {
            onSelect(id);
            setDialogMode(null);
          }}
        />
      )}
    </div>
  );
}
