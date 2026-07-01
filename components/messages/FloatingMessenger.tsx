"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMessenger } from "./MessengerContext";
import { FloatingChatWindow } from "./FloatingChatWindow";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { playSound } from "@/lib/messageSounds";
import { cn } from "@/lib/utils";
import { MessagesSquare, MessageSquarePlus, Users, BellOff, Search, X } from "lucide-react";
import { NewConversationDialog } from "./NewConversationDialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChatThread } from "./ChatThread";

interface Props {
  orgId: Id<"organizations">;
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

// Desktop: floating panel + windows
// Mobile: bottom sheet conversation list + full-screen sheet for chat
function FloatingMessengerInner({ orgId }: Props) {
  const { t, isRtl } = useLanguage();
  const { isListOpen, toggleList, closeList, openChats, openChat } = useMessenger();
  const [search, setSearch] = useState("");
  const [dialogMode, setDialogMode] = useState<"dm" | "group" | null>(null);
  const [mobileOpenId, setMobileOpenId] = useState<Id<"dmConversations"> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const me = useQuery(api.users.getMe);
  const conversations = useQuery(api.directMessages.listConversations, { orgId });
  const unreadCount = useQuery(api.directMessages.getUnreadCount, { orgId });

  // ── Global sound notifications ──────────────────────────────────────────────
  const prevTimestampsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!conversations || !me) return;
    for (const conv of conversations) {
      const prev = prevTimestampsRef.current[conv._id] ?? 0;
      if (
        conv.lastMessageAt > prev &&
        prev > 0 &&
        conv.lastMessageSenderId !== me._id &&
        !conv.isMuted
      ) {
        playSound("received");
      }
      prevTimestampsRef.current[conv._id] = conv.lastMessageAt;
    }
  }, [conversations]);

  // Close list panel when clicking outside
  useEffect(() => {
    if (!isListOpen) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeList();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isListOpen, closeList]);

  type ConvMember = { _id: string; name?: string; imageUrl?: string } | null;
  type ConvItem = { _id: Id<"dmConversations">; type: string; name?: string; members?: ConvMember[]; isMuted?: boolean; hasUnread?: boolean; lastMessageAt: number; lastMessageSenderId?: string; lastMessageBody?: string };
  const filtered = (conversations ?? [] as ConvItem[]).filter((c: ConvItem) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (c.name?.toLowerCase().includes(q)) return true;
    return c.members?.some((m: ConvMember) => m?.name?.toLowerCase().includes(q));
  });

  // FAB position
  const fabPosition = isRtl
    ? "fixed bottom-6 left-6 z-50"
    : "fixed bottom-6 right-6 z-50";

  // Panel position (above FAB, same side)
  const panelPosition = isRtl
    ? "fixed bottom-[72px] left-6 z-50"
    : "fixed bottom-[72px] right-6 z-50";

  function handleSelectConversation(id: Id<"dmConversations">) {
    // Mobile: open sheet; Desktop: open floating window
    if (window.innerWidth < 768) {
      setMobileOpenId(id);
      closeList();
    } else {
      openChat(id);
    }
  }

  if (!me) return null;

  return (
    <>
      {/* ── FAB button ──────────────────────────────────────────────────────── */}
      <button
        onClick={toggleList}
        className={cn(
          fabPosition,
          "h-14 w-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-200",
          "bg-gradient-to-br from-blue-600 to-blue-500 text-white hover:scale-105 active:scale-95",
          isListOpen && "rotate-0"
        )}
        aria-label={t("Messages")}
      >
        {isListOpen ? (
          <X className="h-6 w-6" />
        ) : (
          <MessagesSquare className="h-6 w-6" />
        )}
        {/* Unread badge */}
        {!isListOpen && unreadCount != null && unreadCount > 0 && (
          <span className="absolute -top-1 -end-1 min-w-[20px] h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1 border-2 border-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* ── Conversation list panel ──────────────────────────────────────────── */}
      {isListOpen && (
        <div
          ref={panelRef}
          className={cn(
            panelPosition,
            "w-[320px] bg-white rounded-2xl shadow-2xl border border-slate-200/50 overflow-hidden flex flex-col",
            "max-h-[480px]"
          )}
        >
          {/* Panel header */}
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="flex items-center justify-between mb-2.5">
              <h3 className="text-base font-bold text-slate-900">{t("Messages")}</h3>
              <div className="flex gap-1">
                <button
                  onClick={() => setDialogMode("dm")}
                  className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-slate-500"
                  title={t("MessagesNewDm")}
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setDialogMode("group")}
                  className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-slate-500"
                  title={t("MessagesNewGroup")}
                >
                  <Users className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("MessagesSearchPlaceholder")}
                className="ps-8 h-8 text-sm bg-slate-50 border-slate-200 rounded-full"
              />
            </div>
          </div>

          {/* Conversation rows */}
          <div className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-slate-400">
                {t("MessagesNoConversations")}
              </div>
            )}

            {filtered.map((conv: ConvItem) => {
              const isDm = conv.type === "DM";
              const other = isDm
                ? conv.members?.find((m: ConvMember) => m?._id !== me._id)
                : null;
              const displayName = isDm
                ? (other?.name ?? "…")
                : (conv.name ?? t("MessagesGroupWith"));
              const displayImage = isDm ? other?.imageUrl : undefined;
              const isCurrentlyOpen = openChats.includes(conv._id);

              return (
                <button
                  key={conv._id}
                  onClick={() => handleSelectConversation(conv._id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors text-start",
                    isCurrentlyOpen && "bg-blue-50"
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
                          conv.hasUnread
                            ? "font-bold text-slate-900"
                            : "font-medium text-slate-700"
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
                          conv.hasUnread
                            ? "text-slate-700 font-medium"
                            : "text-slate-400"
                        )}
                      >
                        {conv.lastMessageBody
                          ? conv.lastMessageSenderId === me._id
                            ? `${t("MessagesYou")}: ${conv.lastMessageBody}`
                            : conv.lastMessageBody
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
        </div>
      )}

      {/* ── Desktop floating chat windows ────────────────────────────────────── */}
      <div className="hidden md:block">
        {openChats.map((id, i) => (
          <FloatingChatWindow
            key={id}
            conversationId={id}
            currentUserId={me._id}
            index={i}
          />
        ))}
      </div>

      {/* ── Mobile: full-screen chat sheet ───────────────────────────────────── */}
      <Sheet open={mobileOpenId !== null} onOpenChange={(v) => !v && setMobileOpenId(null)}>
        <SheetContent side="bottom" className="h-[90vh] p-0 flex flex-col rounded-t-2xl">
          {mobileOpenId && (
            <ChatThread
              conversationId={mobileOpenId}
              currentUserId={me._id}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* ── New conversation dialog ───────────────────────────────────────────── */}
      {dialogMode && (
        <NewConversationDialog
          orgId={orgId}
          open={true}
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onConversationCreated={(id) => {
            handleSelectConversation(id);
            setDialogMode(null);
          }}
        />
      )}
    </>
  );
}

export function FloatingMessenger({ orgId }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(<FloatingMessengerInner orgId={orgId} />, document.body);
}
