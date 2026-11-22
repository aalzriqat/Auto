import { defineTable } from "convex/server";
import { v } from "convex/values";

export const supportTables = {
  // ─── Company-level support inboxes (support@ / info@ autoflowdealer.com) ───
  // Not org-scoped — this is the AutoFlow operator's own inbox for talking to
  // subscriber dealerships, separate entirely from any tenant's data.

  supportThreads: defineTable({
    participantEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    // Which inbox this thread belongs to — support@ (help), info@ (sales/general),
    // subscriptions@ (billing/plan inquiries).
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
    lastMessageAt: v.number(),
    autoRepliedAt: v.optional(v.number()),
    // SCRUM-825 mail-client inbox. All optional: rows written before this change
    // carry none of them and are NOT backfilled (the UI treats absent as
    // "unknown": no preview text, no needs-reply flag).
    // Whitespace-collapsed, link-dump-free snippet of the latest inbound message
    // or human reply (never the automated acknowledgement).
    lastMessagePreview: v.optional(v.string()),
    // true after an inbound message, false after a HUMAN reply. The automated
    // acknowledgement deliberately leaves it untouched.
    awaitingReply: v.optional(v.boolean()),
    // Per-thread counter of INBOUND messages, +1 on every one. `sendReply`
    // captures it before the provider call so the reply can tell that a newer
    // inbound message arrived while it was in flight. A counter, not a timestamp:
    // two messages in the same millisecond, or a clock that steps back, would
    // defeat a time comparison. Absent on old rows and read as 0, so the first
    // new inbound on such a row (revision 1) reads as newer than a captured 0.
    inboundRevision: v.optional(v.number()),
    // Admin override of the client-side people/automated heuristic.
    categoryOverride: v.optional(v.union(v.literal("people"), v.literal("automated"))),
  })
    .index("by_participantEmail_and_inbox", ["participantEmail", "inbox"])
    .index("by_inbox_and_lastMessageAt", ["inbox", "lastMessageAt"])
    .index("by_inbox_and_status", ["inbox", "status"])
    // Time-ordered per status, so a status-filtered list is newest-first.
    .index("by_inbox_status_and_lastMessageAt", ["inbox", "status", "lastMessageAt"]),

  supportMessages: defineTable({
    threadId: v.id("supportThreads"),
    direction: v.union(v.literal("INBOUND"), v.literal("OUTBOUND")),
    fromEmail: v.string(),
    toEmail: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    resendEmailId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

  // ─── Live chat support (in-app, real-time) ─────────────────────────────────
  // Separate from the email support inbox above. Dealers chat from inside the
  // dashboard; a small team of support agents (gated by requireSupportAgent,
  // narrower than requireSuperAdmin) claim threads from a queue and reply live.

  supportAgents: defineTable({
    userId: v.id("users"),
    email: v.string(),
    isActive: v.boolean(),
    isOnline: v.optional(v.boolean()),
    lastHeartbeatAt: v.optional(v.number()),
    lastOfferedAt: v.optional(v.number()), // round-robin fairness for chat routing
    // Richer presence than isOnline: ONLINE accepts new offers, BREAK and
    // OFFLINE don't (isOnline is kept in sync with status === "ONLINE" so
    // existing isOnline-based routing/eligibility checks stay correct).
    status: v.optional(v.union(v.literal("ONLINE"), v.literal("BREAK"), v.literal("OFFLINE"))),
    // Set when the agent asks to go on break/offline while still handling an
    // active chat — excluded from new offers immediately, but the status
    // change itself is deferred until their last active chat closes.
    pendingBreak: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"]),

  liveChatThreads: defineTable({
    // kind is omitted on every pre-existing row, which are all dealer chats —
    // undefined is treated as "DEALER" everywhere this is read.
    kind: v.optional(v.union(v.literal("DEALER"), v.literal("LEAD"))),
    orgId: v.optional(v.id("organizations")), // unset for anonymous LEAD threads
    dealerUserId: v.optional(v.id("users")), // unset for anonymous LEAD threads
    dealerName: v.optional(v.string()), // doubles as the lead's display name for LEAD threads
    // Capability token (random, client-generated, stored in the visitor's
    // localStorage) identifying an anonymous marketing-site lead — there's no
    // authenticated `users` row to key off for these. Only set for LEAD threads.
    leadId: v.optional(v.string()),
    leadEmail: v.optional(v.string()),
    status: v.union(v.literal("WAITING"), v.literal("OFFERED"), v.literal("ACTIVE"), v.literal("CLOSED")),
    // Offer/accept/reject routing — a thread is offered to one agent at a
    // time; rejecting or timing out re-offers to the next eligible agent.
    offeredToUserId: v.optional(v.id("users")),
    offeredAt: v.optional(v.number()),
    offerExpiresAt: v.optional(v.number()),
    rejectedByUserIds: v.optional(v.array(v.id("users"))),
    claimedByUserId: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    closedAt: v.optional(v.number()),
    dealerLastReadAt: v.optional(v.number()),
    agentLastReadAt: v.optional(v.number()),
    // Typing indicators — last keystroke timestamp from each side; the
    // client treats this as "stopped typing" once it's a few seconds stale.
    dealerTypingAt: v.optional(v.number()),
    agentTypingAt: v.optional(v.number()),
    // Dealer presence within this thread's chat widget — self-reported by
    // the client (active = window open+focused, idle = open but unfocused)
    // and treated as "away" once dealerPresenceAt goes stale.
    dealerPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    dealerPresenceAt: v.optional(v.number()),
    dealerPresenceSince: v.optional(v.number()), // when dealerPresence last changed — drives the idle/away timer
    // Mirror of the above, but for the claiming agent's view of *this*
    // specific conversation (they may have several open elsewhere).
    agentPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    agentPresenceAt: v.optional(v.number()),
    agentPresenceSince: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_dealerUserId", ["dealerUserId"])
    .index("by_leadId", ["leadId"])
    .index("by_status", ["status", "createdAt"])
    .index("by_claimedByUserId", ["claimedByUserId"])
    .index("by_claimedByUserId_status", ["claimedByUserId", "status"]),

  // Typing/active-idle presence pings, split off liveChatThreads (one row per
  // thread+side) so a dealer's or agent's heartbeat never write-conflicts with
  // the other side, and so queries that don't display live presence (message
  // lists, thread lists) aren't invalidated by every ~10s heartbeat tick.
  // dealerLastReadAt/agentLastReadAt stay on liveChatThreads — they're low
  // frequency (only on actual reads, not heartbeats) and listMyActiveThreads
  // needs agentLastReadAt for its unread badges without an extra join.
  liveChatPresence: defineTable({
    threadId: v.id("liveChatThreads"),
    side: v.union(v.literal("DEALER"), v.literal("AGENT")),
    typingAt: v.optional(v.number()),
    presence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    presenceAt: v.optional(v.number()),
    presenceSince: v.optional(v.number()),
  }).index("by_thread_side", ["threadId", "side"]),

  liveChatMessages: defineTable({
    threadId: v.id("liveChatThreads"),
    senderType: v.union(v.literal("DEALER"), v.literal("AGENT")),
    senderUserId: v.optional(v.id("users")), // unset for messages sent by an anonymous LEAD-thread visitor
    senderName: v.optional(v.string()),
    bodyText: v.string(),
    createdAt: v.number(),
    // System notices (e.g. "agent ended the conversation") — rendered
    // centered/muted instead of as a chat bubble, but still an AGENT-typed
    // message so it flows through the existing unread/sound/notification path.
    isSystem: v.optional(v.boolean()),
  }).index("by_thread", ["threadId"]),

  // Temporary, audited "view/act as" access: while actively handling a
  // dealer's live chat, an agent can request a real (time-limited) OWNER-role
  // membership in that dealer's org to fix things directly. See
  // requestOrgAccess/revokeOrgAccess/expireOrgAccessGrant in convex/liveChat.ts.
  supportOrgAccessGrants: defineTable({
    agentUserId: v.id("users"),
    orgId: v.id("organizations"),
    threadId: v.id("liveChatThreads"),
    membershipId: v.id("memberships"),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_agentUserId_org", ["agentUserId", "orgId"])
    .index("by_orgId", ["orgId"])
    .index("by_threadId", ["threadId"]),
};
