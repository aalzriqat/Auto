"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Check, CheckCheck } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";

type MessageStatus = "sent" | "delivered" | "seen" | "received";

interface SeenByUser {
  userId: string;
  name: string;
  imageUrl?: string;
}

interface Props {
  _id: string;
  body: string;
  senderName: string;
  senderImageUrl?: string;
  senderId: string;
  _creationTime: number;
  status: MessageStatus;
  seenBy?: SeenByUser[];
  isMine: boolean;
  showAvatar: boolean;
  isGroup: boolean;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusIcon({ status }: { status: MessageStatus }) {
  if (status === "sent") {
    return <Check className="h-3 w-3 text-slate-400" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="h-3 w-3 text-slate-400" />;
  }
  if (status === "seen") {
    return <CheckCheck className="h-3 w-3 text-blue-500" />;
  }
  return null;
}

export function MessageBubble({
  body,
  senderName,
  senderImageUrl,
  senderId,
  _creationTime,
  status,
  seenBy = [],
  isMine,
  showAvatar,
  isGroup,
}: Props) {
  const { isRtl } = useLanguage();

  return (
    <div
      className={cn(
        "flex items-end gap-2 group",
        isMine ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar for others in the thread */}
      {!isMine && (
        <div className="w-7 shrink-0">
          {showAvatar && (
            <Avatar className="h-7 w-7">
              {senderImageUrl && <AvatarImage src={senderImageUrl} />}
              <AvatarFallback className="text-[10px] bg-slate-200">
                {senderName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
      )}

      <div className={cn("flex flex-col max-w-[70%]", isMine ? "items-end" : "items-start")}>
        {/* Sender label in group chats */}
        {!isMine && isGroup && showAvatar && (
          <span className="text-[10px] text-slate-400 px-1 mb-0.5">{senderName}</span>
        )}

        <div
          className={cn(
            "px-3 py-2 rounded-2xl text-sm leading-relaxed break-words",
            isMine
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : "bg-slate-100 text-slate-900 rounded-bl-sm"
          )}
        >
          {body}
        </div>

        {/* Timestamp + status (DM) */}
        {!isGroup && (
          <div
            className={cn(
              "flex items-center gap-1 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
              isMine ? "flex-row-reverse" : "flex-row"
            )}
          >
            <span className="text-[10px] text-slate-400">{formatTime(_creationTime)}</span>
            {isMine && <StatusIcon status={status} />}
          </div>
        )}

        {/* Group read receipts — mini avatars of who's seen the message */}
        {isGroup && isMine && (
          <div className={cn("flex items-center gap-1 mt-1", "flex-row-reverse")}>
            {/* Timestamp shown on hover */}
            <span className="text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity me-1">
              {formatTime(_creationTime)}
            </span>

            {seenBy.length > 0 ? (
              <div className="flex -space-x-1 flex-row-reverse">
                {seenBy.slice(0, 6).map((u) => (
                  <Avatar
                    key={u.userId}
                    className="h-4 w-4 border border-white"
                    title={`Seen by ${u.name}`}
                  >
                    {u.imageUrl && <AvatarImage src={u.imageUrl} />}
                    <AvatarFallback className="text-[8px] bg-blue-100 text-blue-600">
                      {u.name.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {seenBy.length > 6 && (
                  <span className="text-[9px] text-slate-400 ps-1">
                    +{seenBy.length - 6}
                  </span>
                )}
              </div>
            ) : (
              /* show tick status when nobody has seen yet */
              <StatusIcon status={status} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
