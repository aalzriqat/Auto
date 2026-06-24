"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { ConversationList } from "./ConversationList";
import { ChatThread } from "./ChatThread";
import { MessagesSquare } from "lucide-react";

interface Props {
  orgId: Id<"organizations">;
}

export function MessagesPageClient({ orgId }: Props) {
  const { t } = useLanguage();
  const [activeId, setActiveId] = useState<Id<"dmConversations"> | null>(null);

  // Get the current user's ID
  const me = useQuery(api.users.getMe);

  if (!me) return null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: conversation list */}
      <ConversationList
        orgId={orgId}
        currentUserId={me._id}
        activeId={activeId}
        onSelect={setActiveId}
      />

      {/* Right: chat thread or empty state */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white">
        {activeId ? (
          <ChatThread conversationId={activeId} currentUserId={me._id} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
            <MessagesSquare className="h-12 w-12 text-slate-200" />
            <div className="text-center">
              <p className="text-sm font-medium">{t("Messages")}</p>
              <p className="text-xs mt-1 text-slate-300">{t("MessagesNoConversationsHint")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
