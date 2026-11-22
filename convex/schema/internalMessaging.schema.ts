import { defineTable } from "convex/server";
import { v } from "convex/values";

export const internalMessagingTables = {
  // ─── Internal team messaging (DMs + group chats, org-scoped) ─────────────────

  dmConversations: defineTable({
    orgId: v.id("organizations"),
    type: v.union(v.literal("DM"), v.literal("GROUP")),
    name: v.optional(v.string()), // group display name
    memberIds: v.array(v.id("users")), // bounded — org team is small
    createdBy: v.id("users"),
    lastMessageAt: v.number(),
    lastMessageBody: v.optional(v.string()), // preview text
    lastMessageSenderId: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_lastMessageAt", ["orgId", "lastMessageAt"]),

  dmMessages: defineTable({
    conversationId: v.id("dmConversations"),
    senderId: v.id("users"),
    body: v.string(),
  }).index("by_conversation", ["conversationId"]),

  // Per-participant state: read receipts + typing + mute preference.
  // Kept separate from dmConversations to avoid write-contention on every
  // keystroke / read-receipt update invalidating the conversation list query.
  dmParticipantState: defineTable({
    conversationId: v.id("dmConversations"),
    userId: v.id("users"),
    lastDeliveredAt: v.optional(v.number()), // marks messages up to here as delivered to this user's active client
    lastReadAt: v.optional(v.number()), // marks messages up to here as "seen"
    typingAt: v.optional(v.number()),   // last keystroke timestamp
    isMuted: v.optional(v.boolean()),   // suppress sounds for this conversation
  })
    .index("by_conversation_user", ["conversationId", "userId"])
    .index("by_user", ["userId"]),
};
