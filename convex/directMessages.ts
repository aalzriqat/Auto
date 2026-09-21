import type { MutationCtx, QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth, requireAuth } from "./utils/tenancy";
import { Doc, Id } from "./_generated/dataModel";
import { notifyUser } from "./utils/notifications";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureMember(
  userId: Id<"users">,
  conversation: Doc<"dmConversations">,
) {
  if (!conversation.memberIds.includes(userId)) {
    throw new Error("Not a member of this conversation.");
  }
}

async function latestMessageCreationTime(
  ctx: MutationCtx,
  conversationId: Id<"dmConversations">,
) {
  const latestMessage = await ctx.db
    .query("dmMessages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .first();

  return latestMessage?._creationTime ?? 0;
}

type ParticipantStateUpdate = {
  lastDeliveredAt?: number;
  lastReadAt?: number;
  typingAt?: number | undefined;
  isMuted?: boolean;
};

function isUnreadForUser(
  conversation: Doc<"dmConversations">,
  userId: Id<"users">,
  lastReadAt: number | undefined,
) {
  return (
    conversation.lastMessageSenderId !== undefined &&
    conversation.lastMessageSenderId !== userId &&
    conversation.lastMessageAt > (lastReadAt ?? 0)
  );
}

async function getParticipantState(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"dmConversations">,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("dmParticipantState")
    .withIndex("by_conversation_user", (q) =>
      q.eq("conversationId", conversationId).eq("userId", userId),
    )
    .unique();
}

async function upsertParticipantState(
  ctx: MutationCtx,
  conversation: Doc<"dmConversations">,
  userId: Id<"users">,
  update: ParticipantStateUpdate = {},
) {
  const existing = await getParticipantState(ctx, conversation._id, userId);
  const effectiveLastReadAt = update.lastReadAt ?? existing?.lastReadAt;
  const projection = {
    orgId: conversation.orgId,
    conversationLastMessageAt: conversation.lastMessageAt,
    hasUnread: isUnreadForUser(conversation, userId, effectiveLastReadAt),
    ...update,
  };

  if (existing) {
    await ctx.db.patch(existing._id, projection);
    return { isMuted: update.isMuted ?? existing.isMuted ?? false };
  }

  await ctx.db.insert("dmParticipantState", {
    conversationId: conversation._id,
    userId,
    ...projection,
  });
  return { isMuted: update.isMuted ?? false };
}

async function getLegacyParticipantStates(
  ctx: QueryCtx,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("dmParticipantState")
    .withIndex("by_user_org", (q) => q.eq("userId", userId).eq("orgId", undefined))
    .collect();
}

async function hydrateConversationStates(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  states: Doc<"dmParticipantState">[],
) {
  const pairs = (
    await Promise.all(
      states.map(async (state) => ({
        state,
        conversation: await ctx.db.get(state.conversationId),
      })),
    )
  ).filter(
    (
      pair,
    ): pair is {
      state: Doc<"dmParticipantState">;
      conversation: Doc<"dmConversations">;
    } =>
      pair.conversation !== null &&
      pair.conversation.orgId === orgId &&
      pair.conversation.memberIds.includes(userId),
  );

  const memberIds = Array.from(
    new Set(pairs.flatMap(({ conversation }) => conversation.memberIds)),
  );
  const memberDocs = await Promise.all(memberIds.map((id) => ctx.db.get(id)));
  const memberById = new Map(
    memberDocs
      .filter((member): member is Doc<"users"> => member !== null)
      .map((member) => [member._id, member]),
  );

  return pairs.map(({ state, conversation }) => ({
    ...conversation,
    members: conversation.memberIds
      .map((id) => memberById.get(id))
      .filter((member): member is Doc<"users"> => member !== undefined)
      .map((member) => ({
        _id: member._id,
        name: member.name ?? member.email,
        imageUrl: member.imageUrl,
      })),
    hasUnread:
      state.hasUnread ??
      isUnreadForUser(conversation, userId, state.lastReadAt),
    isMuted: state.isMuted ?? false,
    lastDeliveredAt: state.lastDeliveredAt ?? 0,
  }));
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** List all conversations the current user is a member of, sorted by latest activity. */
export const listConversations = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const [projectedStates, legacyStates] = await Promise.all([
      ctx.db
        .query("dmParticipantState")
        .withIndex("by_org_user_lastMessageAt", (q) =>
          q.eq("orgId", args.orgId).eq("userId", user._id),
        )
        .order("desc")
        .take(100),
      getLegacyParticipantStates(ctx, user._id),
    ]);

    const stateByConversation = new Map<string, Doc<"dmParticipantState">>();
    for (const state of projectedStates) {
      stateByConversation.set(state.conversationId, state);
    }
    for (const state of legacyStates) {
      if (!stateByConversation.has(state.conversationId)) {
        stateByConversation.set(state.conversationId, state);
      }
    }

    const conversations = await hydrateConversationStates(
      ctx,
      args.orgId,
      user._id,
      Array.from(stateByConversation.values()),
    );

    return conversations
      .sort(
        (a, b) =>
          b.lastMessageAt - a.lastMessageAt ||
          b._id.toString().localeCompare(a._id.toString()),
      )
      .slice(0, 100);
  },
});

/** Member-scoped deterministic pagination for the full messages experience. */
export const listConversationsPage = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const page = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_org_user_lastMessageAt", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const conversations = await hydrateConversationStates(
      ctx,
      args.orgId,
      user._id,
      page.page,
    );

    return { ...page, page: conversations };
  },
});

/** Count conversations with unread messages (for the sidebar badge). */
export const getUnreadCount = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const [projectedUnread, legacyStates] = await Promise.all([
      ctx.db
        .query("dmParticipantState")
        .withIndex("by_org_user_unread", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("userId", user._id)
            .eq("hasUnread", true),
        )
        .collect(),
      getLegacyParticipantStates(ctx, user._id),
    ]);

    const legacyPairs = await Promise.all(
      legacyStates.map(async (state) => ({
        state,
        conversation: await ctx.db.get(state.conversationId),
      })),
    );
    const legacyUnread = legacyPairs.filter(
      ({ state, conversation }) =>
        conversation !== null &&
        conversation.orgId === args.orgId &&
        conversation.memberIds.includes(user._id) &&
        isUnreadForUser(conversation, user._id, state.lastReadAt),
    ).length;

    return projectedUnread.length + legacyUnread;
  },
});

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
        q.eq("conversationId", args.conversationId),
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
      }),
    );

    // Get all participant states + member info for read-receipt display
    const memberInfoAndStates = await Promise.all(
      conv.memberIds.map(async (uid) => {
        const state = await ctx.db
          .query("dmParticipantState")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversationId", args.conversationId).eq("userId", uid),
          )
          .unique();
        const u = await ctx.db.get(uid);
        return {
          userId: uid,
          lastDeliveredAt: Math.max(
            state?.lastDeliveredAt ?? 0,
            state?.lastReadAt ?? 0,
          ),
          lastReadAt: state?.lastReadAt ?? 0,
          name: u?.name ?? u?.email ?? "?",
          imageUrl: u?.imageUrl,
        };
      }),
    );

    const otherStates = memberInfoAndStates.filter(
      (s) => s.userId !== user._id,
    );

    // Compute per-message status + seenBy list (for group read-receipt avatars)
    const messagesWithStatus = messagesWithSenders.map((msg) => {
      if (msg.senderId !== user._id)
        return {
          ...msg,
          status: "received" as const,
          seenBy: [] as {
            userId: Id<"users">;
            name: string;
            imageUrl?: string;
          }[],
        };

      const msgTime = msg._creationTime;
      const seenBy = otherStates
        .filter((s) => s.lastReadAt >= msgTime)
        .map((s) => ({ userId: s.userId, name: s.name, imageUrl: s.imageUrl }));
      const deliveredBy = otherStates.filter(
        (s) => s.lastDeliveredAt >= msgTime,
      );

      const allSeen =
        otherStates.length > 0 && seenBy.length === otherStates.length;
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
      }),
    );

    const myState = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", user._id),
      )
      .unique();
    const hasUnread =
      conv.lastMessageSenderId !== undefined &&
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
              q.eq("conversationId", args.conversationId).eq("userId", uid),
            )
            .unique();
          const u = await ctx.db.get(uid);
          const isTyping =
            state?.typingAt !== undefined && now - state.typingAt < 4000;
          return isTyping
            ? { userId: uid, name: u?.name ?? u?.email ?? "Someone" }
            : null;
        }),
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
        }),
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

    const otherMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.otherUserId),
      )
      .unique();
    if (!otherMembership) throw new Error("User is not a member of this org.");

    const [projectedStates, legacyStates] = await Promise.all([
      ctx.db
        .query("dmParticipantState")
        .withIndex("by_user_org", (q) =>
          q.eq("userId", user._id).eq("orgId", args.orgId),
        )
        .collect(),
      getLegacyParticipantStates(ctx, user._id),
    ]);
    const myStates = [...projectedStates, ...legacyStates];
    const candidates = await Promise.all(
      myStates.map((state) => ctx.db.get(state.conversationId)),
    );
    const found = candidates.find(
      (conversation) =>
        conversation !== null &&
        conversation.orgId === args.orgId &&
        conversation.type === "DM" &&
        conversation.memberIds.length === 2 &&
        conversation.memberIds.includes(user._id) &&
        conversation.memberIds.includes(args.otherUserId),
    );

    if (found) {
      await upsertParticipantState(ctx, found, user._id);
      await upsertParticipantState(ctx, found, args.otherUserId);
      return found._id;
    }

    const now = Date.now();
    const id = await ctx.db.insert("dmConversations", {
      orgId: args.orgId,
      type: "DM",
      memberIds: [user._id, args.otherUserId],
      createdBy: user._id,
      lastMessageAt: now,
    });

    await ctx.db.insert("dmParticipantState", {
      conversationId: id,
      userId: user._id,
      orgId: args.orgId,
      conversationLastMessageAt: now,
      hasUnread: false,
      lastDeliveredAt: now,
      lastReadAt: now,
    });
    await ctx.db.insert("dmParticipantState", {
      conversationId: id,
      userId: args.otherUserId,
      orgId: args.orgId,
      conversationLastMessageAt: now,
      hasUnread: false,
    });

    return id;
  },
});

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

    for (const uid of args.memberIds) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", uid),
        )
        .unique();
      if (!membership) throw new Error("One or more users are not members of this org.");
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
        orgId: args.orgId,
        conversationLastMessageAt: now,
        hasUnread: false,
        lastDeliveredAt: uid === user._id ? now : undefined,
        lastReadAt: uid === user._id ? now : undefined,
      });
    }

    return id;
  },
});

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
    const lastMessageBody =
      trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;

    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      lastMessageBody,
      lastMessageSenderId: user._id,
    });

    const projectedConversation: Doc<"dmConversations"> = {
      ...conv,
      lastMessageAt: now,
      lastMessageBody,
      lastMessageSenderId: user._id,
    };

    const participantState = new Map<string, { isMuted: boolean }>();
    for (const uid of conv.memberIds) {
      const state = await upsertParticipantState(
        ctx,
        projectedConversation,
        uid,
        uid === user._id
          ? { lastDeliveredAt: now, lastReadAt: now, typingAt: undefined }
          : {},
      );
      participantState.set(uid, state);
    }

    const senderName = user.name ?? user.email ?? "Someone";
    const recipients = conv.memberIds.filter((id) => id !== user._id);
    for (const recipientId of recipients) {
      if (participantState.get(recipientId)?.isMuted) continue;

      await notifyUser(
        ctx,
        conv.orgId,
        recipientId,
        "message.received",
        { senderName, preview: lastMessageBody },
        { link: `/${conv.orgId}/messages` },
      );
    }

    return msgId;
  },
});

export const markDelivered = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return;
    if (!conv.memberIds.includes(user._id)) return;
    if (conv.lastMessageSenderId === undefined) return;
    if (conv.lastMessageSenderId === user._id) return;

    const deliveredAt = Math.max(
      Date.now(),
      conv.lastMessageAt,
      await latestMessageCreationTime(ctx, args.conversationId),
    );
    const state = await getParticipantState(ctx, args.conversationId, user._id);
    if ((state?.lastDeliveredAt ?? 0) >= deliveredAt && state?.orgId !== undefined) return;

    await upsertParticipantState(ctx, conv, user._id, {
      lastDeliveredAt: deliveredAt,
    });
  },
});

export const markRead = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return;
    if (!conv.memberIds.includes(user._id)) return;

    const now = Math.max(
      Date.now(),
      conv.lastMessageAt,
      await latestMessageCreationTime(ctx, args.conversationId),
    );
    await upsertParticipantState(ctx, conv, user._id, {
      lastDeliveredAt: now,
      lastReadAt: now,
    });
  },
});

export const setTyping = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    isTyping: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !conv.memberIds.includes(user._id)) return;

    await upsertParticipantState(ctx, conv, user._id, {
      typingAt: args.isTyping ? Date.now() : undefined,
    });
  },
});

export const setMuted = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    isMuted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !conv.memberIds.includes(user._id)) return;

    await upsertParticipantState(ctx, conv, user._id, {
      isMuted: args.isMuted,
    });
  },
});
