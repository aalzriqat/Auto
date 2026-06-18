import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { logAdminAction } from "./adminAudit";

/** Lists every support agent row joined with the underlying user's name/email. */
export const listSupportAgents = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);

    const agents = await ctx.db.query("supportAgents").collect();
    const now = Date.now();
    return await Promise.all(
      agents.map(async (agent) => {
        const user = await ctx.db.get(agent.userId);
        const isOnlineNow = Boolean(
          agent.isOnline && agent.lastHeartbeatAt && now - agent.lastHeartbeatAt < 45_000
        );
        // A stale heartbeat (closed tab, crashed browser) always wins over
        // whatever status was last recorded — they're not really online.
        const presence = !isOnlineNow ? "OFFLINE" : agent.status ?? "ONLINE";

        const activeThreads = await ctx.db
          .query("liveChatThreads")
          .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", agent.userId))
          .filter((q) => q.eq(q.field("status"), "ACTIVE"))
          .collect();
        const activeChatSince = activeThreads.length
          ? Math.min(...activeThreads.map((t) => t.claimedAt ?? t.createdAt))
          : undefined;

        return {
          ...agent,
          name: user?.name,
          isOnlineNow,
          presence,
          activeChatCount: activeThreads.length,
          activeChatSince,
        };
      })
    );
  },
});

/**
 * Grants support-agent access to an existing user by email. The user must
 * already have a `users` row — which only exists after they've signed in at
 * least once and Clerk's webhook has synced them.
 */
export const addSupportAgent = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const email = args.email.toLowerCase().trim();

    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (!user) {
      throw new ConvexError(
        "No AutoFlow account found for this email yet. Ask them to sign in once first, then try again."
      );
    }

    const existing = await ctx.db
      .query("supportAgents")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();

    if (existing) {
      throw new ConvexError("This person is already a support agent.");
    }

    const agentId = await ctx.db.insert("supportAgents", {
      userId: user._id,
      email,
      isActive: true,
    });

    await logAdminAction(ctx, actor, {
      action: "support_agent.add",
      targetTable: "supportAgents",
      targetId: agentId,
      after: { email, userId: user._id },
    });

    return agentId;
  },
});

export const setSupportAgentActive = mutation({
  args: { agentId: v.id("supportAgents"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new ConvexError("Support agent not found.");

    await ctx.db.patch(args.agentId, { isActive: args.isActive });

    await logAdminAction(ctx, actor, {
      action: args.isActive ? "support_agent.activate" : "support_agent.deactivate",
      targetTable: "supportAgents",
      targetId: args.agentId,
      before: { isActive: agent.isActive },
      after: { isActive: args.isActive },
    });
  },
});

export const removeSupportAgent = mutation({
  args: { agentId: v.id("supportAgents") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new ConvexError("Support agent not found.");

    await ctx.db.delete(args.agentId);

    await logAdminAction(ctx, actor, {
      action: "support_agent.remove",
      targetTable: "supportAgents",
      targetId: args.agentId,
      before: { email: agent.email, userId: agent.userId },
    });
  },
});
