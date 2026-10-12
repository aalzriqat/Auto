import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, action, internalQuery, internalAction } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { logAdminAction } from "./adminAudit";
import { rateLimiter } from "./rateLimit";
import type { MutationCtx } from "./_generated/server";
import { buildPreview, isNoReplyAddress } from "../lib/supportMail";

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
  const lastMessagePreview = buildPreview(args.bodyText, args.bodyHtml);

  if (!thread) {
    const threadId = await ctx.db.insert("supportThreads", {
      participantEmail: email,
      participantName: args.fromName,
      subject: args.subject,
      status: "OPEN",
      inbox,
      lastMessageAt: now,
      lastMessagePreview,
      awaitingReply: true,
    });
    thread = await ctx.db.get(threadId);
  } else {
    await ctx.db.patch(thread._id, {
      lastMessageAt: now,
      status: "OPEN",
      participantName: args.fromName ?? thread.participantName,
      lastMessagePreview,
      awaitingReply: true,
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

  // Notify configured admin emails on every new inbound message.
  const configRow = await ctx.db
    .query("siteConfig")
    .withIndex("by_key", (q) => q.eq("key", "supportNotifyEmails"))
    .unique();
  const notifyEmails = configRow?.value as string[] | null | undefined;
  if (notifyEmails && Array.isArray(notifyEmails) && notifyEmails.length > 0) {
    await ctx.scheduler.runAfter(0, internal.email.sendSupportInboxNotification, {
      toEmails: notifyEmails,
      inbox,
      fromEmail: email,
      fromName: args.fromName,
      subject: args.subject,
      bodyPreview: args.bodyText?.slice(0, 200),
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
      // Newest-first: the status index alone (`by_inbox_and_status`) is not
      // time-ordered, so `.order("desc")` on it sorted by creation time instead.
      return await ctx.db
        .query("supportThreads")
        .withIndex("by_inbox_status_and_lastMessageAt", (q) =>
          q.eq("inbox", args.inbox).eq("status", args.status!)
        )
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
    const admin = await requireSuperAdmin(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    await ctx.db.patch(args.threadId, { status: args.status });

    await logAdminAction(ctx, admin, {
      action: "supportSetThreadStatus",
      targetTable: "supportThreads",
      targetId: args.threadId,
      before: { status: thread.status },
      after: { status: args.status },
    });
  },
});

export const setThreadCategory = mutation({
  args: {
    threadId: v.id("supportThreads"),
    // null clears the override and falls back to the heuristic.
    category: v.union(v.literal("people"), v.literal("automated"), v.null()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Thread not found.");
    await ctx.db.patch(args.threadId, { categoryOverride: args.category ?? undefined });

    await logAdminAction(ctx, admin, {
      action: "supportSetThreadCategory",
      targetTable: "supportThreads",
      targetId: args.threadId,
      before: { categoryOverride: thread.categoryOverride ?? null },
      after: { categoryOverride: args.category },
    });
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
    // Set only for a human super-admin reply. `sendAutoReply` leaves both unset,
    // which is what distinguishes an automated acknowledgment (not an admin
    // action, so not auditable) from a reply a person sent.
    sentByUserId: v.optional(v.id("users")),
    sentByEmail: v.optional(v.string()),
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
    if (args.sentByUserId) {
      // A human reply answers the thread. The automated acknowledgement (no
      // sentByUserId) must not: it would hide a thread that still needs a person.
      await ctx.db.patch(args.threadId, {
        lastMessageAt: Date.now(),
        awaitingReply: false,
        lastMessagePreview: buildPreview(args.bodyText),
      });
    } else {
      await ctx.db.patch(args.threadId, { lastMessageAt: Date.now() });
    }

    // `sendReply` is an action, so it cannot write the audit row itself. It
    // passes the actor down and the row is inserted here, in the same
    // transaction as the message it describes — the same shape
    // `adminUsers.deleteUser` uses for its own action-to-mutation hop. Missing
    // actor email with an actor id present is a wiring bug, not a live case:
    // fail rather than record an admin reply with no attribution.
    if (args.sentByUserId) {
      if (!args.sentByEmail) {
        throw new Error("recordOutboundMessage: sentByEmail is required whenever sentByUserId is set.");
      }
      await ctx.db.insert("adminAuditLog", {
        actorUserId: args.sentByUserId,
        actorEmail: args.sentByEmail,
        action: "supportSendReply",
        targetTable: "supportThreads",
        targetId: args.threadId,
        after: { toEmail: args.toEmail, resendEmailId: args.resendEmailId },
        createdAt: Date.now(),
      });
    }
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

    // Replies to no-reply senders bounce. Refuse before any email is attempted.
    if (isNoReplyAddress(threadData.participantEmail)) {
      throw new ConvexError("This sender does not accept replies.");
    }

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
      fromEmail: FROM_EMAIL[threadData.inbox as Inbox],
      toEmail: threadData.participantEmail,
      bodyText: args.bodyText,
      resendEmailId: result.resendEmailId,
      sentByUserId: admin._id,
      sentByEmail: admin.email,
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
