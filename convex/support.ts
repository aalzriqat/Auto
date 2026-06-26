import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, action, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { rateLimiter } from "./rateLimit";
import type { MutationCtx } from "./_generated/server";

const CONTACT_FORM_TO_EMAIL = "info@autoflowdealer.com";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Inbox = "support" | "info" | "subscriptions";

const FROM_EMAIL: Record<Inbox, string> = {
  support: "support@autoflowdealer.com",
  info: "info@autoflowdealer.com",
  subscriptions: "subscriptions@autoflowdealer.com",
};

function inboxForAddress(toEmail: string): Inbox {
  const lower = toEmail.toLowerCase();
  if (lower.includes("subscriptions@")) return "subscriptions";
  if (lower.includes("info@")) return "info";
  return "support";
}

// Shared by the Resend inbound webhook and the public contact form below —
// both just need to land a message in a thread keyed by participant email
// + inbox, and fire the one-time auto-reply.
async function recordSupportMessage(
  ctx: MutationCtx,
  args: {
    fromEmail: string;
    fromName?: string;
    toEmail: string;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    resendEmailId?: string;
  }
) {
  const email = args.fromEmail.toLowerCase().trim();
  const inbox = inboxForAddress(args.toEmail);

  let thread = await ctx.db
    .query("supportThreads")
    .withIndex("by_participantEmail_and_inbox", (q) =>
      q.eq("participantEmail", email).eq("inbox", inbox)
    )
    .first();

  const now = Date.now();

  if (!thread) {
    const threadId = await ctx.db.insert("supportThreads", {
      participantEmail: email,
      participantName: args.fromName,
      subject: args.subject,
      status: "OPEN",
      inbox,
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

  // Acknowledge first contact only — once per thread, regardless of how many
  // messages arrive before a human admin (or this auto-reply) responds.
  if (!thread!.autoRepliedAt) {
    await ctx.db.patch(thread!._id, { autoRepliedAt: now });
    await ctx.scheduler.runAfter(0, internal.support.sendAutoReply, {
      threadId: thread!._id,
      toEmail: email,
      participantName: args.fromName,
      subject: args.subject,
      inbox,
    });
  }
}

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
    await recordSupportMessage(ctx, args);
  },
});

// ─── Inbound (called from the public "Contact us" form on the landing page) ───

export const submitContactMessage = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    subject: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const email = args.email.trim().toLowerCase();
    const subject = args.subject.trim();
    const message = args.message.trim();

    if (!name || name.length > 200) {
      throw new ConvexError("Please enter a valid name.");
    }
    if (!EMAIL_REGEX.test(email) || email.length > 320) {
      throw new ConvexError("Please enter a valid email address.");
    }
    if (!subject || subject.length > 200) {
      throw new ConvexError("Please enter a subject (max 200 characters).");
    }
    if (!message || message.length > 5000) {
      throw new ConvexError("Please enter a message (max 5000 characters).");
    }

    const status = await rateLimiter.limit(ctx, "contactForm", { key: email });
    if (!status.ok) {
      throw new ConvexError(`Too many messages sent. Try again in ${Math.ceil(status.retryAfter / 60000)} minute(s).`);
    }

    await recordSupportMessage(ctx, {
      fromEmail: email,
      fromName: name,
      toEmail: CONTACT_FORM_TO_EMAIL,
      subject,
      bodyText: message,
    });

    return { success: true };
  },
});

// ─── Admin-facing reads/writes (gated by requireSuperAdmin) ────────────────────

export const listThreads = query({
  args: {
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
    status: v.optional(v.union(v.literal("OPEN"), v.literal("CLOSED"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    if (args.status) {
      return await ctx.db
        .query("supportThreads")
        .withIndex("by_inbox_and_status", (q) => q.eq("inbox", args.inbox).eq("status", args.status!))
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return await ctx.db
      .query("supportThreads")
      .withIndex("by_inbox_and_lastMessageAt", (q) => q.eq("inbox", args.inbox))
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
    fromEmail: v.string(),
    toEmail: v.string(),
    bodyText: v.string(),
    resendEmailId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("supportMessages", {
      threadId: args.threadId,
      direction: "OUTBOUND",
      fromEmail: args.fromEmail,
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
      inbox: threadData.inbox,
    });

    if (!result.success) {
      throw new ConvexError(result.error || "Failed to send reply email.");
    }

    await ctx.runMutation(internal.support.recordOutboundMessage, {
      threadId: args.threadId,
      fromEmail: FROM_EMAIL[threadData.inbox],
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

// ─── Auto-reply (scheduled from recordInboundMessage on first contact) ────────

export const sendAutoReply = internalAction({
  args: {
    threadId: v.id("supportThreads"),
    toEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
  },
  handler: async (ctx, args) => {
    const result = await ctx.runAction(internal.email.sendAutoReplyEmail, {
      toEmail: args.toEmail,
      participantName: args.participantName,
      subject: args.subject,
      inbox: args.inbox,
    });

    if (result.success) {
      await ctx.runMutation(internal.support.recordOutboundMessage, {
        threadId: args.threadId,
        fromEmail: FROM_EMAIL[args.inbox],
        toEmail: args.toEmail,
        bodyText: "(Automated acknowledgment — your message was received and a team member will follow up shortly.)",
        resendEmailId: result.resendEmailId,
      });
    }
  },
});
