"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageBubble } from "./MessageBubble";
import { playSound } from "@/lib/messageSounds";
import { cn } from "@/lib/utils";
import { Send, BellOff, Bell, ChevronDown } from "lucide-react";

interface Props {
  conversationId: Id<"dmConversations">;
  currentUserId: Id<"users">;
}

export function ChatThread({ conversationId, currentUserId }: Props) {
  const { t, isRtl } = useLanguage();
  const [body, setBody] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLastMessageAtRef = useRef<number>(0);

  const conversation = useQuery(api.directMessages.getConversation, { conversationId });
  const { results: messages, loadMore, status } = usePaginatedQuery(
    api.directMessages.listMessages,
    { conversationId },
    { initialNumItems: 40 }
  );

  const sendMessage = useMutation(api.directMessages.sendMessage);
  const markRead = useMutation(api.directMessages.markRead);
  const setTypingMutation = useMutation(api.directMessages.setTyping);
  const setMuted = useMutation(api.directMessages.setMuted);

  // Mark as read when the thread opens / new messages arrive
  useEffect(() => {
    markRead({ conversationId }).catch(() => null);
  }, [conversationId, messages?.length]);

  // Play sound when new messages arrive from others
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const latest = messages[0]; // newest first
    if (
      latest &&
      latest.senderId !== currentUserId &&
      latest._creationTime > prevLastMessageAtRef.current &&
      prevLastMessageAtRef.current !== 0 &&
      !conversation?.isMuted
    ) {
      playSound("received");
    }
    if (messages[0]) {
      prevLastMessageAtRef.current = messages[0]._creationTime;
    }
  }, [messages]);

  // Scroll to bottom when messages first load or new message arrives
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  const handleTyping = useCallback(() => {
    if (!isTyping) {
      setIsTyping(true);
      setTypingMutation({ conversationId, isTyping: true }).catch(() => null);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      setIsTyping(false);
      setTypingMutation({ conversationId, isTyping: false }).catch(() => null);
    }, 3000);
  }, [conversationId, isTyping, setTypingMutation]);

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setBody("");
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    setIsTyping(false);
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

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  const isDm = conversation.type === "DM";
  const otherMember = isDm
    ? conversation.members?.find((m) => m?._id !== currentUserId)
    : null;

  const displayName = isDm
    ? (otherMember?.name ?? "…")
    : (conversation.name ?? t("MessagesGroupWith"));

  const displayImage = isDm ? otherMember?.imageUrl : undefined;

  const typingText = (() => {
    const typers = conversation.typingUsers ?? [];
    if (typers.length === 0) return null;
    if (typers.length === 1) return `${typers[0]?.name} ${t("MessagesTyping")}`;
    return t("MessagesMultipleTyping");
  })();

  // Reverse to show oldest at top
  const chronological = [...(messages ?? [])].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200/50 bg-white shrink-0">
        <Avatar className="h-9 w-9 shrink-0">
          {displayImage && <AvatarImage src={displayImage} />}
          <AvatarFallback className="text-xs bg-slate-200">
            {displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{displayName}</p>
          {!isDm && (
            <p className="text-xs text-slate-400">
              {conversation.members?.length ?? 0} {t("MessagesSelectMembers").toLowerCase()}
            </p>
          )}
        </div>

        {/* Mute toggle */}
        <button
          onClick={() =>
            setMuted({ conversationId, isMuted: !conversation.isMuted })
          }
          className={cn(
            "p-2 rounded-lg transition-colors",
            conversation.isMuted
              ? "text-amber-500 hover:bg-amber-50"
              : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
          )}
          title={conversation.isMuted ? t("MessagesUnmute") : t("MessagesMute")}
        >
          {conversation.isMuted ? (
            <BellOff className="h-4 w-4" />
          ) : (
            <Bell className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 flex flex-col">
        {status === "CanLoadMore" && (
          <div className="flex justify-center pb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => loadMore(40)}
              className="text-xs text-slate-400 gap-1"
            >
              <ChevronDown className="h-3 w-3" />
              Load older messages
            </Button>
          </div>
        )}

        {chronological.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
            {t("MessagesEmptyThread")}
          </div>
        )}

        {chronological.map((msg, i) => {
          const isMine = msg.senderId === currentUserId;
          const nextMsg = chronological[i + 1];
          // Show avatar when next message is from different sender (last in a run)
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

        {/* Typing indicator */}
        {typingText && (
          <div className="flex items-center gap-2 text-xs text-slate-400 italic px-2">
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
      <div className="px-4 py-3 border-t border-slate-200/50 bg-white shrink-0">
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              handleTyping();
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("MessagesTypeHere")}
            className="flex-1 rounded-full bg-slate-50 border-slate-200 focus-visible:ring-primary/30"
            dir={isRtl ? "rtl" : "ltr"}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!body.trim()}
            className="rounded-full h-9 w-9 shrink-0"
          >
            <Send className={cn("h-4 w-4", isRtl && "rotate-180")} />
          </Button>
        </div>
      </div>
    </div>
  );
}
