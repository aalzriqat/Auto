"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMessenger } from "./MessengerContext";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBubble } from "./MessageBubble";
import { playSound } from "@/lib/messageSounds";
import { cn } from "@/lib/utils";
import { X, Minus, Send, BellOff, Bell, ChevronDown } from "lucide-react";

interface Props {
  conversationId: Id<"dmConversations">;
  currentUserId: Id<"users">;
  index: number; // horizontal stacking index (0 = rightmost)
}

export function FloatingChatWindow({ conversationId, currentUserId, index }: Props) {
  const { t, isRtl } = useLanguage();
  const { closeChat, toggleMinimize, minimizedChats } = useMessenger();
  const isMinimized = minimizedChats.includes(conversationId);

  const [body, setBody] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMsgCountRef = useRef(0);

  const conversation = useQuery(api.directMessages.getConversation, { conversationId });
  const { results: messages, loadMore, status } = usePaginatedQuery(
    api.directMessages.listMessages,
    { conversationId },
    { initialNumItems: 30 }
  );

  const sendMessage = useMutation(api.directMessages.sendMessage);
  const markRead = useMutation(api.directMessages.markRead);
  const setTypingMutation = useMutation(api.directMessages.setTyping);
  const setMuted = useMutation(api.directMessages.setMuted);

  // Mark read when window is visible (not minimized)
  useEffect(() => {
    if (!isMinimized) {
      markRead({ conversationId }).catch(() => null);
    }
  }, [conversationId, isMinimized, messages?.length]);

  // Play sound when new messages arrive from others
  useEffect(() => {
    if (!messages) return;
    const count = messages.length;
    if (count > prevMsgCountRef.current && prevMsgCountRef.current > 0) {
      const newest = messages[0];
      if (newest && newest.senderId !== currentUserId && !conversation?.isMuted) {
        playSound("received");
      }
    }
    prevMsgCountRef.current = count;
  }, [messages?.length]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (!isMinimized) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages?.length, isMinimized]);

  const handleTyping = useCallback(() => {
    setTypingMutation({ conversationId, isTyping: true }).catch(() => null);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      setTypingMutation({ conversationId, isTyping: false }).catch(() => null);
    }, 3000);
  }, [conversationId, setTypingMutation]);

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setBody("");
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    setTypingMutation({ conversationId, isTyping: false }).catch(() => null);
    await sendMessage({ conversationId, body: trimmed });
    playSound("sent");
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!conversation) return null;

  const isDm = conversation.type === "DM";
  const otherMember = isDm
    ? conversation.members?.find((m: { _id: string; name?: string; imageUrl?: string } | null) => m?._id !== currentUserId)
    : null;
  const displayName = isDm ? (otherMember?.name ?? "…") : (conversation.name ?? t("MessagesGroupWith"));
  const displayImage = isDm ? otherMember?.imageUrl : undefined;

  const typingText = (() => {
    const typers = conversation.typingUsers ?? [];
    if (typers.length === 0) return null;
    if (typers.length === 1) return `${typers[0]?.name} ${t("MessagesTyping")}`;
    return t("MessagesMultipleTyping");
  })();

  // Unread count for minimized badge
  const hasUnread =
    conversation.lastMessageAt > 0 &&
    conversation.lastMessageSenderId !== currentUserId &&
    isMinimized;

  const chronological = [...(messages ?? [])].reverse();

  // Horizontal position: each window is 336px wide + 8px gap
  // For RTL: stack from left; for LTR: stack from right
  // The list panel is 320px, button area ~72px — start after those
  const windowWidth = 336;
  const gap = 8;
  const baseOffset = 72 + 8; // floating button width + gap
  const listOffset = 328; // conversation list width + gap
  const offsetX = baseOffset + listOffset + index * (windowWidth + gap);

  const positionStyle: React.CSSProperties = isRtl
    ? { left: offsetX }
    : { right: offsetX };

  return (
    <div
      className={cn(
        "fixed bottom-0 z-50 flex flex-col shadow-2xl rounded-t-2xl overflow-hidden transition-all duration-200",
        "w-[336px]"
      )}
      style={positionStyle}
    >
      {/* Header — always visible */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2.5 select-none",
          "bg-gradient-to-r from-blue-600 to-blue-500 text-white"
        )}
      >
        <button
          type="button"
          onClick={() => toggleMinimize(conversationId)}
          className="min-w-0 flex flex-1 items-center gap-2 text-start"
          aria-label={isMinimized ? t("MessagesExpand") : t("MessagesMinimize")}
        >
          <span className="relative shrink-0">
            <Avatar className="h-8 w-8 border-2 border-white/30">
              {displayImage && <AvatarImage src={displayImage} />}
              <AvatarFallback className="text-xs bg-blue-400 text-white">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {hasUnread && (
              <span className="absolute -top-0.5 -end-0.5 w-3 h-3 rounded-full bg-red-500 border-2 border-blue-600" />
            )}
          </span>

          <span className="flex-1 min-w-0">
            <span className="text-sm font-semibold truncate leading-tight block">{displayName}</span>
            {typingText && !isMinimized && (
              <span className="text-[10px] text-blue-100 truncate block">{typingText}</span>
            )}
          </span>
        </button>

        <div className="flex items-center gap-0.5">
          {!isMinimized && (
            <button
              type="button"
              onClick={() => {
                setMuted({ conversationId, isMuted: !conversation.isMuted });
              }}
              className="p-1.5 rounded-full hover:bg-white/20 transition-colors"
              title={conversation.isMuted ? t("MessagesUnmute") : t("MessagesMute")}
            >
              {conversation.isMuted
                ? <BellOff className="h-3.5 w-3.5" />
                : <Bell className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={() => { toggleMinimize(conversationId); }}
            className="p-1.5 rounded-full hover:bg-white/20 transition-colors"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { closeChat(conversationId); }}
            className="p-1.5 rounded-full hover:bg-white/20 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — hidden when minimized */}
      {!isMinimized && (
        <>
          {/* Messages */}
          <div className="flex-1 h-[380px] overflow-y-auto px-3 py-3 space-y-1 bg-white flex flex-col">
            {status === "CanLoadMore" && (
              <button
                onClick={() => loadMore(30)}
                className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 mx-auto pb-1"
              >
                <ChevronDown className="h-3 w-3" />
                Load older
              </button>
            )}

            {chronological.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                {t("MessagesEmptyThread")}
              </div>
            )}

            {chronological.map((msg, i) => {
              const isMine = msg.senderId === currentUserId;
              const nextMsg = chronological[i + 1];
              const showAvatar = !nextMsg || nextMsg.senderId !== msg.senderId;
              return (
                <MessageBubble
                  key={msg._id}
                  _id={msg._id}
                  body={msg.body}
                  senderName={msg.senderName}
                  senderImageUrl={msg.senderImageUrl}
                  senderId={msg.senderId}
                  _creationTime={msg._creationTime}
                  status={msg.status}
                  seenBy={msg.seenBy ?? []}
                  isMine={isMine}
                  showAvatar={showAvatar}
                  isGroup={!isDm}
                />
              );
            })}

            {typingText && (
              <div className="flex items-center gap-1.5 text-xs text-slate-400 italic px-1">
                <span className="inline-flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </span>
                {typingText}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2 border-t border-slate-100 bg-white flex items-center gap-2">
            <Input
              ref={inputRef}
              value={body}
              onChange={(e) => { setBody(e.target.value); handleTyping(); }}
              onKeyDown={handleKeyDown}
              placeholder={t("MessagesTypeHere")}
              className="flex-1 h-8 text-sm rounded-full bg-slate-50 border-slate-200"
              dir={isRtl ? "rtl" : "ltr"}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!body.trim()}
              className="rounded-full h-8 w-8 shrink-0 bg-blue-600 hover:bg-blue-700"
            >
              <Send className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
