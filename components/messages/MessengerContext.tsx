"use client";

import { createContext, useContext, useState, useCallback } from "react";
import { Id } from "@/convex/_generated/dataModel";

interface MessengerState {
  isListOpen: boolean;
  toggleList: () => void;
  closeList: () => void;
  openChats: Id<"dmConversations">[];
  minimizedChats: Id<"dmConversations">[];
  openChat: (id: Id<"dmConversations">) => void;
  closeChat: (id: Id<"dmConversations">) => void;
  toggleMinimize: (id: Id<"dmConversations">) => void;
}

const MessengerContext = createContext<MessengerState | null>(null);

const MAX_OPEN_WINDOWS = 3;

export function MessengerProvider({ children }: { children: React.ReactNode }) {
  const [isListOpen, setIsListOpen] = useState(false);
  const [openChats, setOpenChats] = useState<Id<"dmConversations">[]>([]);
  const [minimizedChats, setMinimizedChats] = useState<Id<"dmConversations">[]>([]);

  const toggleList = useCallback(() => setIsListOpen((v) => !v), []);
  const closeList = useCallback(() => setIsListOpen(false), []);

  const openChat = useCallback((id: Id<"dmConversations">) => {
    setOpenChats((prev) => {
      if (prev.includes(id)) {
        // Already open — un-minimize if minimized
        setMinimizedChats((m) => m.filter((mid) => mid !== id));
        return prev;
      }
      const next = [id, ...prev].slice(0, MAX_OPEN_WINDOWS);
      return next;
    });
    setMinimizedChats((m) => m.filter((mid) => mid !== id));
    setIsListOpen(false);
  }, []);

  const closeChat = useCallback((id: Id<"dmConversations">) => {
    setOpenChats((prev) => prev.filter((cid) => cid !== id));
    setMinimizedChats((prev) => prev.filter((cid) => cid !== id));
  }, []);

  const toggleMinimize = useCallback((id: Id<"dmConversations">) => {
    setMinimizedChats((prev) =>
      prev.includes(id) ? prev.filter((cid) => cid !== id) : [...prev, id]
    );
  }, []);

  return (
    <MessengerContext.Provider
      value={{ isListOpen, toggleList, closeList, openChats, minimizedChats, openChat, closeChat, toggleMinimize }}
    >
      {children}
    </MessengerContext.Provider>
  );
}

export function useMessenger() {
  const ctx = useContext(MessengerContext);
  if (!ctx) throw new Error("useMessenger must be used inside MessengerProvider");
  return ctx;
}
