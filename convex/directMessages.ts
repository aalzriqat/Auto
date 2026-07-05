import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth, requireAuth } from "./utils/tenancy";
import { Doc, Id } from "./_generated/dataModel";
import { notifyUser } from "./utils/notifications";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureMember(
  userId: Id<"users">,
  conversation: Doc<"dmConversations">
) {
  if (!conversation.memberIds.includes(userId)) {
    throw new Error("Not a member of this conversation.");
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** List all conversations the current user is a member of, sorted by latest activity. */
export const listConversations = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const all = await ctx.db
      .query("dmConversations")
      .withIndex("by_org_lastMessageAt", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(100);

    const mine = all.filter((c) => c.memberIds.includes(user._id));

    // Attach participant state (unread indicator) for each conversation
    const results = await Promise.all(
      mine.map(async (conv) => {
        const state = await ctx.db
          .query("dmParticipantState")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversationId", conv._id).eq("userId", user._id)
          )
          .unique();

        const hasUnread =
          conv.lastMessageAt > (state?.lastReadAt ?? 0) &&
          conv.lastMessageSenderId !== user._id;

        // Fetch member info for display
        const members = await Promise.all(
          conv.memberIds.map(async (uid) => {
            const u = await ctx.db.get(uid);
            return u
              ? { _id: u._id, name: u.name ?? u.email, imageUrl: u.imageUrl }
              : null;
          })
        );

        return {
          ...conv,
          members: members.filter(Boolean),
          hasUnread,
          isMuted: state?.isMuted ?? false,
          lastDeliveredAt: state?.lastDeliveredAt ?? 0,
        };
      })
    );

    return results;
  },
});

/** Count conversations with unread messages (for the sidebar badge). */
export const getUnreadCount = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const all = await ctx.db
      .query("dmConversations")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(100);

    const mine = all.filter((c) => c.memberIds.includes(user._id));

    let count = 0;
    for (const conv of mine) {
      const state = await ctx.db
        .query("dmParticipantState")
        .withIndex("by_conversation_user", (q) =>
          q.eq("conversationId", conv._id).eq("userId", user._id)
        )
        .unique();

      if (
        conv.lastMessageAt > (state?.lastReadAt ?? 0) &&
        conv.lastMessageSenderId !== user._id
      ) {
        count++;
      }
    }
    return count;
  },
});

/** List messages in a conversation (paginated, newest first). */
export const listMessages = query({
  args: {
    conversationId: v.id("dmConversations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) throw new Error("Conversation not found.");
    ensureMember(user._id, conv);

    const page = await ctx.db
      .query("dmMessages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .paginate(args.paginationOpts);

    // Attach sender info to each message
    const messagesWithSenders = await Promise.all(
      page.page.map(async (msg) => {
        const sender = await ctx.db.get(msg.senderId);
        return {
          ...msg,
          senderName: sender?.name ?? sender?.email ?? "Unknown",
          senderImageUrl: sender?.imageUrl,
        };
      })
    );

    // Get all participant states + member info for read-receipt display
    const memberInfoAndStates = await Promise.all(
      conv.memberIds.map(async (uid) => {
        const state = await ctx.db
          .query("dmParticipantState")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversationId", args.conversationId).eq("userId", uid)
          )
          .unique();
        const u = await ctx.db.get(uid);
        return {
          userId: uid,
          lastDeliveredAt: Math.max(state?.lastDeliveredAt ?? 0, state?.lastReadAt ?? 0),
          lastReadAt: state?.lastReadAt ?? 0,
          name: u?.name ?? u?.email ?? "?",
          imageUrl: u?.imageUrl,
        };
      })
    );

    const otherStates = memberInfoAndStates.filter((s) => s.userId !== user._id);

    // Compute per-message status + seenBy list (for group read-receipt avatars)
    const messagesWithStatus = messagesWithSenders.map((msg) => {
      if (msg.senderId !== user._id) return {
        ...msg,
        status: "received" as const,
        seenBy: [] as { userId: Id<"users">; name: string; imageUrl?: string }[],
      };

      const msgTime = msg._creationTime;
      const seenBy = otherStates
        .filter((s) => s.lastReadAt >= msgTime)
        .map((s) => ({ userId: s.userId, name: s.name, imageUrl: s.imageUrl }));
      const deliveredBy = otherStates.filter((s) => s.lastDeliveredAt >= msgTime);

      const allSeen = otherStates.length > 0 && seenBy.length === otherStates.length;
      const someDelivered = deliveredBy.length > 0;

      const status = allSeen
        ? ("seen" as const)
        : someDelivered
          ? ("delivered" as const)
          : ("sent" as const);

      return { ...msg, status, seenBy };
    });

    return { ...page, page: messagesWithStatus };
  },
});

/** Get conversation details + member info. */
export const getConversation = query({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return null;
    if (!conv.memberIds.includes(user._id)) return null;

    const members = await Promise.all(
      conv.memberIds.map(async (uid) => {
        const u = await ctx.db.get(uid);
        return u
          ? { _id: u._id, name: u.name ?? u.email, imageUrl: u.imageUrl }
          : null;
      })
    );

    const myState = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();
    const hasUnread =
      conv.lastMessageAt > (myState?.lastReadAt ?? 0) &&
      conv.lastMessageSenderId !== user._id;

    // Typing indicators from other members
    const now = Date.now();
    const typingStates = await Promise.all(
      conv.memberIds
        .filter((uid) => uid !== user._id)
        .map(async (uid) => {
          const state = await ctx.db
            .query("dmParticipantState")
            .withIndex("by_conversation_user", (q) =>
              q.eq("conversationId", args.conversationId).eq("userId", uid)
            )
            .unique();
          const u = await ctx.db.get(uid);
          const isTyping =
            state?.typingAt !== undefined && now - state.typingAt < 4000;
          return isTyping
            ? { userId: uid, name: u?.name ?? u?.email ?? "Someone" }
            : null;
        })
    );

    return {
      ...conv,
      members: members.filter(Boolean),
      isMuted: myState?.isMuted ?? false,
      hasUnread,
      lastDeliveredAt: myState?.lastDeliveredAt ?? 0,
      typingUsers: typingStates.filter(Boolean),
    };
  },
});

/** List org members available to start a conversation with. */
export const getOrgMembers = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(100);

    const members = await Promise.all(
      memberships
        .filter((m) => m.userId !== user._id)
        .map(async (m) => {
          const u = await ctx.db.get(m.userId);
          if (!u) return null;
          const role = await ctx.db.get(m.roleId);
          return {
            _id: u._id,
            name: u.name ?? u.email,
            email: u.email,
            imageUrl: u.imageUrl,
            roleName: role?.name ?? "",
          };
        })
    );

    return members.filter(Boolean);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Get or create a 1:1 DM conversation between the current user and another member. */
export const getOrCreateDm = mutation({
  args: { orgId: v.id("organizations"), otherUserId: v.id("users") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    if (user._id === args.otherUserId) {
      throw new Error("Cannot create a DM with yourself.");
    }

    // Verify other user is also a member
    const otherMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.otherUserId)
      )
      .unique();
    if (!otherMembership) throw new Error("User is not a member of this org.");

    // Find existing DM between these two users in this org
    const existing = await ctx.db
      .query("dmConversations")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("type"), "DM"))
      .take(200);

    const found = existing.find(
      (c) =>
        c.memberIds.length === 2 &&
        c.memberIds.includes(user._id) &&
        c.memberIds.includes(args.otherUserId)
    );

    if (found) return found._id;

    const now = Date.now();
    const id = await ctx.db.insert("dmConversations", {
      orgId: args.orgId,
      type: "DM",
      memberIds: [user._id, args.otherUserId],
      createdBy: user._id,
      lastMessageAt: now,
    });

    // Seed participant state rows for both members
    await ctx.db.insert("dmParticipantState", {
      conversationId: id,
      userId: user._id,
      lastDeliveredAt: now,
      lastReadAt: now,
    });
    await ctx.db.insert("dmParticipantState", {
      conversationId: id,
      userId: args.otherUserId,
    });

    return id;
  },
});

/** Create a group conversation. */
export const createGroup = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    if (args.memberIds.length < 2) {
      throw new Error("A group needs at least 2 other members.");
    }

    // Verify all members belong to the org
    for (const uid of args.memberIds) {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", uid)
        )
        .unique();
      if (!m) throw new Error("One or more users are not members of this org.");
    }

    const allMembers = [
      user._id,
      ...args.memberIds.filter((id) => id !== user._id),
    ];
    const now = Date.now();

    const id = await ctx.db.insert("dmConversations", {
      orgId: args.orgId,
      type: "GROUP",
      name: args.name,
      memberIds: allMembers,
      createdBy: user._id,
      lastMessageAt: now,
    });

    for (const uid of allMembers) {
      await ctx.db.insert("dmParticipantState", {
        conversationId: id,
        userId: uid,
        lastDeliveredAt: uid === user._id ? now : undefined,
        lastReadAt: uid === user._id ? now : undefined,
      });
    }

    return id;
  },
});

/** Send a message to a conversation. */
export const sendMessage = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) throw new Error("Conversation not found.");
    ensureMember(user._id, conv);

    const trimmed = args.body.trim();
    if (!trimmed) throw new Error("Message body cannot be empty.");

    const msgId = await ctx.db.insert("dmMessages", {
      conversationId: args.conversationId,
      senderId: user._id,
      body: trimmed,
    });

    const now = Date.now();

    // Update conversation preview
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      lastMessageBody: trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed,
      lastMessageSenderId: user._id,
    });

    // Mark sender as "read" immediately; clear typing
    const myState = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();

    if (myState) {
      await ctx.db.patch(myState._id, { lastDeliveredAt: now, lastReadAt: now, typingAt: undefined });
    }

    // Notify every other member (in-app always; email/WhatsApp/push per their
    // own preferences, via dispatch()) unless they've muted this conversation
    // — the same signal that already suppresses the in-browser sound.
    const senderName = user.name ?? user.email ?? "Someone";
    const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
    const recipients = conv.memberIds.filter((id) => id !== user._id);
    for (const recipientId of recipients) {
      const recipientState = await ctx.db
        .query("dmParticipantState")
        .withIndex("by_conversation_user", (q) =>
          q.eq("conversationId", args.conversationId).eq("userId", recipientId)
        )
        .unique();
      if (recipientState?.isMuted) continue;

      await notifyUser(
        ctx,
        conv.orgId,
        recipientId,
        "message.received",
        { senderName, preview },
        { link: `/${conv.orgId}/messages` }
      );
    }

    return msgId;
  },
});

/** Mark the latest incoming conversation activity as delivered to this user's active client. */
export const markDelivered = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return;
    if (!conv.memberIds.includes(user._id)) return;
    if (conv.lastMessageSenderId === user._id) return;

    const state = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();

    const deliveredAt = conv.lastMessageAt;
    if (state) {
      if ((state.lastDeliveredAt ?? 0) >= deliveredAt) return;
      await ctx.db.patch(state._id, { lastDeliveredAt: deliveredAt });
      return;
    }

    await ctx.db.insert("dmParticipantState", {
      conversationId: args.conversationId,
      userId: user._id,
      lastDeliveredAt: deliveredAt,
    });
  },
});

/** Mark the current user as having read the conversation (triggers "seen" receipts). */
export const markRead = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return;
    if (!conv.memberIds.includes(user._id)) return;

    const state = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();

    const now = Date.now();
    const deliveredAt = Math.max(now, conv.lastMessageAt);
    if (state) {
      await ctx.db.patch(state._id, { lastDeliveredAt: deliveredAt, lastReadAt: now });
    } else {
      await ctx.db.insert("dmParticipantState", {
        conversationId: args.conversationId,
        userId: user._id,
        lastDeliveredAt: deliveredAt,
        lastReadAt: now,
      });
    }
  },
});

/** Update typing indicator — call while user is typing, clear when they stop or send. */
export const setTyping = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    isTyping: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !conv.memberIds.includes(user._id)) return;

    const state = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();

    const update = { typingAt: args.isTyping ? Date.now() : undefined };
    if (state) {
      await ctx.db.patch(state._id, update);
    } else {
      await ctx.db.insert("dmParticipantState", {
        conversationId: args.conversationId,
        userId: user._id,
        ...update,
      });
    }
  },
});

/** Toggle mute for this conversation (suppresses notification sounds). */
export const setMuted = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    isMuted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !conv.memberIds.includes(user._id)) return;

    const state = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id)
      )
      .unique();

    if (state) {
      await ctx.db.patch(state._id, { isMuted: args.isMuted });
    } else {
      await ctx.db.insert("dmParticipantState", {
        conversationId: args.conversationId,
        userId: user._id,
        isMuted: args.isMuted,
      });
    }
  },
});
