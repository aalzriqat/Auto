import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireSupportAgent } from "./utils/tenancy";
import { rateLimiter } from "./rateLimit";
import { logAdminAction } from "./adminAudit";

const OFFER_TIMEOUT_MS = 30_000;
const GRANT_DURATION_MS = 60 * 60_000;
const ONLINE_THRESHOLD_MS = 45_000;
const DEALER_PRESENCE_STALE_MS = 25_000;

// ─── Dealer-facing ──────────────────────────────────────────────────────────

/** Finds the dealer's most recent non-closed thread, or starts a new (WAITING) one. */
export const startOrGetMyThread = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const existing = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_dealerUserId", (q) => q.eq("dealerUserId", user._id))
      .order("desc")
      .filter((q) => q.neq(q.field("status"), "CLOSED"))
      .first();

    if (existing) return existing._id;

    const now = Date.now();
    const threadId = await ctx.db.insert("liveChatThreads", {
      orgId: args.orgId,
      dealerUserId: user._id,
      dealerName: user.name,
      status: "WAITING",
      createdAt: now,
      lastMessageAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.liveChat.offerToNextAgent, { threadId });
    return threadId;
  },
});

export const getMyThread = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const thread = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_dealerUserId", (q) => q.eq("dealerUserId", user._id))
      .order("desc")
      .filter((q) => q.neq(q.field("status"), "CLOSED"))
      .first();

    const agents = await ctx.db.query("supportAgents").collect();
    const now = Date.now();
    const anyAgentOnline = agents.some(
      (a) => a.isActive && a.isOnline && a.lastHeartbeatAt && now - a.lastHeartbeatAt < ONLINE_THRESHOLD_MS
    );

    if (!thread) return { thread: null, queuePosition: null, anyAgentOnline };

    let queuePosition: number | null = null;
    if (thread.status === "WAITING" || thread.status === "OFFERED") {
      const ahead = await ctx.db
        .query("liveChatThreads")
        .withIndex("by_status", (q) => q.eq("status", "WAITING").lt("createdAt", thread.createdAt))
        .collect();
      const aheadOffered = await ctx.db
        .query("liveChatThreads")
        .withIndex("by_status", (q) => q.eq("status", "OFFERED").lt("createdAt", thread.createdAt))
        .collect();
      queuePosition = ahead.length + aheadOffered.length + 1;
    }

    let claimedByName: string | undefined;
    if (thread.claimedByUserId) {
      const agentUser = await ctx.db.get(thread.claimedByUserId);
      claimedByName = agentUser?.name;
    }

    return { thread, queuePosition, anyAgentOnline, claimedByName };
  },
});

export const sendDealerMessage = mutation({
  args: { threadId: v.id("liveChatThreads"), bodyText: v.string() },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    const { user } = await requireTenantAuth(ctx, thread.orgId);
    if (thread.dealerUserId !== user._id) {
      throw new ConvexError("Thread not found.");
    }
    if (!args.bodyText.trim()) return;

    const limit = await rateLimiter.limit(ctx, "chatMessage", { key: user._id });
    if (!limit.ok) {
      throw new ConvexError(`Sending too fast — try again in ${Math.ceil(limit.retryAfter / 1000)}s`);
    }

    const now = Date.now();
    await ctx.db.insert("liveChatMessages", {
      threadId: args.threadId,
      senderType: "DEALER",
      senderUserId: user._id,
      senderName: user.name,
      bodyText: args.bodyText.trim(),
      createdAt: now,
    });

    const wasClosed = thread.status === "CLOSED";
    await ctx.db.patch(args.threadId, {
      lastMessageAt: now,
      dealerTypingAt: undefined,
      // Re-queue a closed conversation if the dealer writes again instead of
      // silently dropping the message into a dead thread.
      ...(wasClosed
        ? {
            status: "WAITING" as const,
            claimedByUserId: undefined,
            claimedAt: undefined,
            offeredToUserId: undefined,
            offeredAt: undefined,
            offerExpiresAt: undefined,
            rejectedByUserIds: undefined,
          }
        : {}),
    });

    if (wasClosed) {
      await ctx.scheduler.runAfter(0, internal.liveChat.offerToNextAgent, { threadId: args.threadId });
    }
  },
});

export const markThreadReadByDealer = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    const { user } = await requireTenantAuth(ctx, thread.orgId);
    if (thread.dealerUserId !== user._id) {
      throw new ConvexError("Thread not found.");
    }
    await ctx.db.patch(args.threadId, { dealerLastReadAt: Date.now() });
  },
});

export const setDealerTyping = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    const { user } = await requireTenantAuth(ctx, thread.orgId);
    if (thread.dealerUserId !== user._id) {
      throw new ConvexError("Thread not found.");
    }
    await ctx.db.patch(args.threadId, { dealerTypingAt: Date.now() });
  },
});

export const updateDealerPresence = mutation({
  args: { threadId: v.id("liveChatThreads"), state: v.union(v.literal("active"), v.literal("idle")) },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    const { user } = await requireTenantAuth(ctx, thread.orgId);
    if (thread.dealerUserId !== user._id) {
      throw new ConvexError("Thread not found.");
    }
    const now = Date.now();
    const stateChanged = thread.dealerPresence !== args.state;
    await ctx.db.patch(args.threadId, {
      dealerPresence: args.state,
      dealerPresenceAt: now,
      ...(stateChanged ? { dealerPresenceSince: now } : {}),
    });
  },
});

/** Dealer-initiated end — mirrors the agent's closeThread, including revoking any live org-access grant. */
export const endThreadByDealer = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    const { user } = await requireTenantAuth(ctx, thread.orgId);
    if (thread.dealerUserId !== user._id) {
      throw new ConvexError("Thread not found.");
    }
    if (thread.status === "CLOSED") return;

    const now = Date.now();
    await ctx.db.patch(args.threadId, { status: "CLOSED", closedAt: now, lastMessageAt: now });

    await ctx.db.insert("liveChatMessages", {
      threadId: args.threadId,
      senderType: "DEALER",
      senderUserId: user._id,
      senderName: user.name,
      bodyText: `${user.name ?? "The dealer"} ended the conversation.`,
      createdAt: now,
      isSystem: true,
    });

    await revokeGrantsForThread(ctx, args.threadId);
  },
});

export const getActiveOrgAccessGrant = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);

    const grants = await ctx.db
      .query("supportOrgAccessGrants")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
    const now = Date.now();
    const active = grants
      .filter((g) => !g.revokedAt && g.expiresAt > now)
      .sort((a, b) => b.grantedAt - a.grantedAt)[0];

    if (!active) return null;
    const agentUser = await ctx.db.get(active.agentUserId);
    return { expiresAt: active.expiresAt, agentName: agentUser?.name };
  },
});

// ─── Shared (dealer + agent, ownership/role-checked separately) ────────────

export const getThreadMessages = query({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");

    // Either the owning dealer (tenant-auth'd) or any support agent may read.
    try {
      await requireSupportAgent(ctx);
    } catch {
      const { user } = await requireTenantAuth(ctx, thread.orgId);
      if (thread.dealerUserId !== user._id) {
        throw new ConvexError("Thread not found.");
      }
    }

    return await ctx.db
      .query("liveChatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();
  },
});

// ─── Agent-facing: queue + routing ─────────────────────────────────────────

/** Single-thread fetch for the agent console's header (presence/typing/unread state). */
export const getThreadForAgent = query({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    await requireSupportAgent(ctx);
    return await ctx.db.get(args.threadId);
  },
});

export const setAgentTyping = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.claimedByUserId !== user._id) return;
    await ctx.db.patch(args.threadId, { agentTypingAt: Date.now() });
  },
});

export const markThreadReadByAgent = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.claimedByUserId !== user._id) return;
    await ctx.db.patch(args.threadId, { agentLastReadAt: Date.now() });
  },
});

/** Per-thread presence for the claiming agent — are they currently looking at *this* conversation. */
export const updateAgentPresence = mutation({
  args: { threadId: v.id("liveChatThreads"), state: v.union(v.literal("active"), v.literal("idle")) },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.claimedByUserId !== user._id) return;
    const now = Date.now();
    const stateChanged = thread.agentPresence !== args.state;
    await ctx.db.patch(args.threadId, {
      agentPresence: args.state,
      agentPresenceAt: now,
      ...(stateChanged ? { agentPresenceSince: now } : {}),
    });
  },
});

export const listQueue = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireSupportAgent(ctx);

    const offered = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_status", (q) => q.eq("status", "OFFERED"))
      .collect();
    const offeredToMe = offered.filter((t) => t.offeredToUserId === user._id);

    const unassigned = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_status", (q) => q.eq("status", "WAITING"))
      .order("asc")
      .collect();

    return { offeredToMe, unassigned };
  },
});

export const listMyActiveThreads = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireSupportAgent(ctx);
    return await ctx.db
      .query("liveChatThreads")
      .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", user._id))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .order("desc")
      .collect();
  },
});

/** Manual fallback claim — only valid for unassigned (WAITING) threads. */
export const claimThread = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    if (thread.status !== "WAITING") {
      throw new ConvexError("This conversation is no longer unassigned.");
    }

    await ctx.db.patch(args.threadId, {
      status: "ACTIVE",
      claimedByUserId: user._id,
      claimedAt: Date.now(),
    });

    await logAdminAction(ctx, user, {
      action: "live_chat.claim",
      targetTable: "liveChatThreads",
      targetId: args.threadId,
      orgId: thread.orgId,
    });
  },
});

export const acceptOffer = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    if (thread.status !== "OFFERED" || thread.offeredToUserId !== user._id) {
      throw new ConvexError("This conversation is no longer offered to you.");
    }

    await ctx.db.patch(args.threadId, {
      status: "ACTIVE",
      claimedByUserId: user._id,
      claimedAt: Date.now(),
      offeredToUserId: undefined,
      offeredAt: undefined,
      offerExpiresAt: undefined,
    });

    await logAdminAction(ctx, user, {
      action: "live_chat.accept",
      targetTable: "liveChatThreads",
      targetId: args.threadId,
      orgId: thread.orgId,
    });
  },
});

export const rejectOffer = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    if (thread.status !== "OFFERED" || thread.offeredToUserId !== user._id) {
      throw new ConvexError("This conversation is no longer offered to you.");
    }

    await ctx.db.patch(args.threadId, {
      status: "WAITING",
      offeredToUserId: undefined,
      offeredAt: undefined,
      offerExpiresAt: undefined,
      rejectedByUserIds: [...(thread.rejectedByUserIds ?? []), user._id],
    });

    await logAdminAction(ctx, user, {
      action: "live_chat.reject",
      targetTable: "liveChatThreads",
      targetId: args.threadId,
      orgId: thread.orgId,
    });

    await ctx.scheduler.runAfter(0, internal.liveChat.offerToNextAgent, { threadId: args.threadId });
  },
});

/** Finds the least-busy eligible online agent and offers them the thread; falls back to WAITING (unassigned) if none are available. */
export const offerToNextAgent = internalMutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || (thread.status !== "WAITING" && thread.status !== "OFFERED")) return;

    const now = Date.now();
    const allAgents = await ctx.db.query("supportAgents").collect();
    const rejected = new Set(thread.rejectedByUserIds ?? []);
    const eligible = allAgents.filter(
      (a) =>
        a.isActive &&
        a.isOnline &&
        !a.pendingBreak &&
        a.lastHeartbeatAt &&
        now - a.lastHeartbeatAt < ONLINE_THRESHOLD_MS &&
        !rejected.has(a.userId)
    );

    if (eligible.length === 0) {
      await ctx.db.patch(args.threadId, {
        status: "WAITING",
        offeredToUserId: undefined,
        offeredAt: undefined,
        offerExpiresAt: undefined,
      });
      return;
    }

    const activeCounts = await Promise.all(
      eligible.map(async (a) => {
        const active = await ctx.db
          .query("liveChatThreads")
          .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", a.userId))
          .filter((q) => q.eq(q.field("status"), "ACTIVE"))
          .collect();
        return { agent: a, activeCount: active.length };
      })
    );

    activeCounts.sort((a, b) => {
      if (a.activeCount !== b.activeCount) return a.activeCount - b.activeCount;
      return (a.agent.lastOfferedAt ?? 0) - (b.agent.lastOfferedAt ?? 0);
    });

    const chosen = activeCounts[0]!.agent;
    const offerExpiresAt = now + OFFER_TIMEOUT_MS;

    await ctx.db.patch(args.threadId, {
      status: "OFFERED",
      offeredToUserId: chosen.userId,
      offeredAt: now,
      offerExpiresAt,
    });
    await ctx.db.patch(chosen._id, { lastOfferedAt: now });

    await ctx.scheduler.runAfter(OFFER_TIMEOUT_MS, internal.liveChat.expireOffer, {
      threadId: args.threadId,
      offeredToUserId: chosen.userId,
    });
  },
});

export const expireOffer = internalMutation({
  args: { threadId: v.id("liveChatThreads"), offeredToUserId: v.id("users") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.status !== "OFFERED" || thread.offeredToUserId !== args.offeredToUserId) {
      return; // already accepted/rejected/closed in the meantime
    }

    await ctx.db.patch(args.threadId, {
      status: "WAITING",
      offeredToUserId: undefined,
      offeredAt: undefined,
      offerExpiresAt: undefined,
      rejectedByUserIds: [...(thread.rejectedByUserIds ?? []), args.offeredToUserId],
    });

    await ctx.scheduler.runAfter(0, internal.liveChat.offerToNextAgent, { threadId: args.threadId });
  },
});

export const sendAgentMessage = mutation({
  args: { threadId: v.id("liveChatThreads"), bodyText: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    if (!args.bodyText.trim()) return;

    const now = Date.now();
    await ctx.db.insert("liveChatMessages", {
      threadId: args.threadId,
      senderType: "AGENT",
      senderUserId: user._id,
      senderName: user.name,
      bodyText: args.bodyText.trim(),
      createdAt: now,
    });

    await ctx.db.patch(args.threadId, { lastMessageAt: now, agentLastReadAt: now, agentTypingAt: undefined });
  },
});

export const closeThread = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");

    const now = Date.now();
    await ctx.db.patch(args.threadId, { status: "CLOSED", closedAt: now, lastMessageAt: now });

    // Let the dealer know the agent ended things, via the same channel as a
    // normal agent message — so it surfaces through the existing
    // unread badge / sound / tab-title notification path automatically.
    await ctx.db.insert("liveChatMessages", {
      threadId: args.threadId,
      senderType: "AGENT",
      senderUserId: user._id,
      senderName: user.name,
      bodyText: `${user.name ?? "Support"} ended the conversation.`,
      createdAt: now,
      isSystem: true,
    });

    await logAdminAction(ctx, user, {
      action: "live_chat.close",
      targetTable: "liveChatThreads",
      targetId: args.threadId,
      orgId: thread.orgId,
    });

    // Closing the conversation always ends any org-access grant tied to it,
    // even if the agent forgot to revoke manually.
    await revokeGrantsForThread(ctx, args.threadId);

    // If the agent had asked for a break/offline while this was their last
    // active chat, apply that deferred status change now.
    const agentRow = await ctx.db
      .query("supportAgents")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (agentRow?.pendingBreak) {
      const stillActive = await ctx.db
        .query("liveChatThreads")
        .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", user._id))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      if (stillActive.length === 0) {
        await ctx.db.patch(agentRow._id, { status: "BREAK", isOnline: false, pendingBreak: false });
      }
    }
  },
});

export const getMyAgentStatus = query({
  args: {},
  handler: async (ctx) => {
    const { agent } = await requireSupportAgent(ctx);
    const activeThreads = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", agent.userId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .collect();
    return {
      status: agent.status ?? (agent.isOnline ? "ONLINE" : "OFFLINE"),
      pendingBreak: agent.pendingBreak ?? false,
      activeChatCount: activeThreads.length,
    };
  },
});

export const heartbeat = mutation({
  args: { isOnline: v.boolean() },
  handler: async (ctx, args) => {
    const { agent } = await requireSupportAgent(ctx);
    const wasOnline = Boolean(
      agent.isOnline && agent.lastHeartbeatAt && Date.now() - agent.lastHeartbeatAt < ONLINE_THRESHOLD_MS
    );
    await ctx.db.patch(agent._id, { isOnline: args.isOnline, lastHeartbeatAt: Date.now() });

    // Sweep the backlog when an agent newly comes online, so unassigned
    // threads don't sit idle waiting for the next dealer message.
    if (args.isOnline && !wasOnline) {
      await sweepBacklogFor(ctx);
    }
  },
});

async function revokeGrantsForThread(ctx: MutationCtx, threadId: Id<"liveChatThreads">) {
  const grants = await ctx.db
    .query("supportOrgAccessGrants")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .collect();
  for (const grant of grants) {
    if (!grant.revokedAt) {
      await ctx.db.delete(grant.membershipId);
      await ctx.db.patch(grant._id, { revokedAt: Date.now() });
    }
  }
}

async function sweepBacklogFor(ctx: MutationCtx) {
  const unassigned = await ctx.db
    .query("liveChatThreads")
    .withIndex("by_status", (q) => q.eq("status", "WAITING"))
    .order("asc")
    .first();
  if (unassigned) {
    await ctx.scheduler.runAfter(0, internal.liveChat.offerToNextAgent, { threadId: unassigned._id });
  }
}

/**
 * Explicit status control for the agent console (Online / Break / Offline).
 * Going to BREAK or OFFLINE while the agent still has an active claimed
 * chat is deferred — they keep that one conversation but stop receiving new
 * offers immediately, and the status change applies automatically once
 * their last active chat is closed (see closeThread).
 */
export const setAgentStatus = mutation({
  args: { status: v.union(v.literal("ONLINE"), v.literal("BREAK"), v.literal("OFFLINE")) },
  handler: async (ctx, args) => {
    const { agent } = await requireSupportAgent(ctx);
    const now = Date.now();

    if (args.status === "ONLINE") {
      const wasOnline = Boolean(
        agent.isOnline && agent.lastHeartbeatAt && now - agent.lastHeartbeatAt < ONLINE_THRESHOLD_MS
      );
      await ctx.db.patch(agent._id, {
        status: "ONLINE",
        isOnline: true,
        pendingBreak: false,
        lastHeartbeatAt: now,
      });
      if (!wasOnline) await sweepBacklogFor(ctx);
      return { applied: true };
    }

    const activeThreads = await ctx.db
      .query("liveChatThreads")
      .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", agent.userId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .collect();

    if (activeThreads.length > 0) {
      // Stop receiving new offers right away, but let them finish the
      // conversation they're already in before fully going offline/on break.
      await ctx.db.patch(agent._id, { pendingBreak: true, lastHeartbeatAt: now });
      return { applied: false, deferred: true };
    }

    await ctx.db.patch(agent._id, {
      status: args.status,
      isOnline: false,
      pendingBreak: false,
      lastHeartbeatAt: now,
    });
    return { applied: true };
  },
});

// ─── Org access grant ───────────────────────────────────────────────────────

export const requestOrgAccess = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    if (thread.status !== "ACTIVE" || thread.claimedByUserId !== user._id) {
      throw new ConvexError("You can only request access while actively handling this conversation.");
    }

    const now = Date.now();
    const existingGrants = await ctx.db
      .query("supportOrgAccessGrants")
      .withIndex("by_agentUserId_org", (q) => q.eq("agentUserId", user._id).eq("orgId", thread.orgId))
      .collect();
    const activeGrant = existingGrants.find((g) => !g.revokedAt && g.expiresAt > now);

    if (activeGrant) {
      const expiresAt = now + GRANT_DURATION_MS;
      await ctx.db.patch(activeGrant._id, { expiresAt });
      await ctx.scheduler.runAfter(GRANT_DURATION_MS, internal.liveChat.expireOrgAccessGrant, {
        agentUserId: user._id,
        orgId: thread.orgId,
      });
      return { orgId: thread.orgId, expiresAt };
    }

    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", thread.orgId).eq("userId", user._id))
      .unique();
    if (existingMembership) {
      throw new ConvexError("You're already a member of this organization.");
    }

    const orgRoles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", thread.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();
    const ownerRole = orgRoles.find((r) => r.name === "OWNER");
    if (!ownerRole) throw new ConvexError("This organization has no OWNER role to grant.");

    const membershipId = await ctx.db.insert("memberships", {
      orgId: thread.orgId,
      userId: user._id,
      roleId: ownerRole._id,
    });

    const expiresAt = now + GRANT_DURATION_MS;
    await ctx.db.insert("supportOrgAccessGrants", {
      agentUserId: user._id,
      orgId: thread.orgId,
      threadId: args.threadId,
      membershipId,
      grantedAt: now,
      expiresAt,
    });

    await ctx.scheduler.runAfter(GRANT_DURATION_MS, internal.liveChat.expireOrgAccessGrant, {
      agentUserId: user._id,
      orgId: thread.orgId,
    });

    await logAdminAction(ctx, user, {
      action: "live_chat.org_access_grant",
      targetTable: "organizations",
      targetId: thread.orgId,
      orgId: thread.orgId,
      after: { threadId: args.threadId, expiresAt },
    });

    return { orgId: thread.orgId, expiresAt };
  },
});

export const revokeOrgAccess = mutation({
  args: { threadId: v.id("liveChatThreads") },
  handler: async (ctx, args) => {
    const { user } = await requireSupportAgent(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");

    const grants = await ctx.db
      .query("supportOrgAccessGrants")
      .withIndex("by_agentUserId_org", (q) => q.eq("agentUserId", user._id).eq("orgId", thread.orgId))
      .collect();
    const now = Date.now();
    const active = grants.find((g) => !g.revokedAt && g.expiresAt > now);
    if (!active) return;

    await ctx.db.delete(active.membershipId);
    await ctx.db.patch(active._id, { revokedAt: now });

    await logAdminAction(ctx, user, {
      action: "live_chat.org_access_revoke",
      targetTable: "organizations",
      targetId: thread.orgId,
      orgId: thread.orgId,
    });
  },
});

export const expireOrgAccessGrant = internalMutation({
  args: { agentUserId: v.id("users"), orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const grants = await ctx.db
      .query("supportOrgAccessGrants")
      .withIndex("by_agentUserId_org", (q) => q.eq("agentUserId", args.agentUserId).eq("orgId", args.orgId))
      .collect();
    const now = Date.now();
    for (const grant of grants) {
      if (!grant.revokedAt && grant.expiresAt <= now) {
        const membership = await ctx.db.get(grant.membershipId);
        if (membership) await ctx.db.delete(grant.membershipId);
        await ctx.db.patch(grant._id, { revokedAt: now });
      }
    }
  },
});
