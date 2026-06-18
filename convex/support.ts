import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";

// ─── Inbound (called from the Resend webhook in convex/http.ts) ───────────────

export const recordInboundMessage = internalMutation({
  args: {
    fromEmail: v.string(),
    fromName: v.optional(v.string()),
    toEmail: v.string(),
    subject: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    resendEmailId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.fromEmail.toLowerCase().trim();

    let thread = await ctx.db
      .query("supportThreads")
      .withIndex("by_participantEmail", (q) => q.eq("participantEmail", email))
      .first();

    const now = Date.now();

    if (!thread) {
      const threadId = await ctx.db.insert("supportThreads", {
        participantEmail: email,
        participantName: args.fromName,
        subject: args.subject,
        status: "OPEN",
        lastMessageAt: now,
      });
      thread = await ctx.db.get(threadId);
    } else {
      await ctx.db.patch(thread._id, {
        lastMessageAt: now,
        status: "OPEN",
        participantName: args.fromName ?? thread.participantName,
      });
    }

    await ctx.db.insert("supportMessages", {
      threadId: thread!._id,
      direction: "INBOUND",
      fromEmail: email,
      toEmail: args.toEmail,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      resendEmailId: args.resendEmailId,
      createdAt: now,
    });
  },
});

// ─── Admin-facing reads/writes (gated by requireSuperAdmin) ────────────────────

export const listThreads = query({
  args: {
    status: v.optional(v.union(v.literal("OPEN"), v.literal("CLOSED"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    if (args.status) {
      return await ctx.db
        .query("supportThreads")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return await ctx.db
      .query("supportThreads")
      .withIndex("by_lastMessageAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getThreadMessages = query({
  args: { threadId: v.id("supportThreads") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");

    const messages = await ctx.db
      .query("supportMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();

    return { thread, messages };
  },
});

export const setThreadStatus = mutation({
  args: {
    threadId: v.id("supportThreads"),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    await ctx.db.patch(args.threadId, { status: args.status });
  },
});

// ─── Sending a reply (action — needs to call the Resend API) ──────────────────

export const requireSuperAdminForAction = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireSuperAdmin(ctx);
  },
});

export const recordOutboundMessage = internalMutation({
  args: {
    threadId: v.id("supportThreads"),
    toEmail: v.string(),
    bodyText: v.string(),
    resendEmailId: v.optional(v.string()),
    sentByUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("supportMessages", {
      threadId: args.threadId,
      direction: "OUTBOUND",
      fromEmail: "support@autoflowdealer.com",
      toEmail: args.toEmail,
      bodyText: args.bodyText,
      resendEmailId: args.resendEmailId,
      sentByUserId: args.sentByUserId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.threadId, { lastMessageAt: Date.now() });
  },
});

export const sendReply = action({
  args: {
    threadId: v.id("supportThreads"),
    bodyText: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: true }> => {
    const admin = await ctx.runQuery(internal.support.requireSuperAdminForAction, {});

    const threadData = await ctx.runQuery(internal.support.getThreadForReply, {
      threadId: args.threadId,
    });
    if (!threadData) throw new ConvexError("Thread not found.");

    const result = await ctx.runAction(internal.email.sendSupportReply, {
      toEmail: threadData.participantEmail,
      subject: threadData.subject.startsWith("Re:") ? threadData.subject : `Re: ${threadData.subject}`,
      bodyText: args.bodyText,
    });

    if (!result.success) {
      throw new ConvexError(result.error || "Failed to send reply email.");
    }

    await ctx.runMutation(internal.support.recordOutboundMessage, {
      threadId: args.threadId,
      toEmail: threadData.participantEmail,
      bodyText: args.bodyText,
      resendEmailId: result.resendEmailId,
      sentByUserId: admin._id,
    });

    return { success: true };
  },
});

export const getThreadForReply = internalQuery({
  args: { threadId: v.id("supportThreads") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.threadId);
  },
});
