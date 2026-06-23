import { internalMutation, mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAuth } from "./utils/tenancy";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns the current authenticated user's record.
 */
export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuth(ctx);
    return user;
  },
});

/**
 * Returns a specific user's basic info by their ID (for audit logs).
 * Requires authentication to prevent user enumeration.
 */
export const getUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return { name: user.name || "Unknown User" };
  },
});

/**
 * Lets the caller set their own server-known locale (so scheduled emails/
 * WhatsApp messages can be localized — the client toggle in LanguageProvider
 * otherwise lives only in localStorage) and WhatsApp number for notifications.
 */
export const updateMyNotificationProfile = mutation({
  args: {
    locale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    whatsappPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    const patch: Record<string, unknown> = {};
    if (args.locale !== undefined) patch.locale = args.locale;
    if (args.whatsappPhone !== undefined) patch.whatsappPhone = args.whatsappPhone.trim() || undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(user._id, patch);
    }
  },
});

// ─── Internal Mutations (called from webhooks, not client-facing) ────────────

/**
 * Upserts a user record when Clerk sends user.created or user.updated webhooks.
 */
export const updateOrCreateUser = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    let userId;
    if (existingUser) {
      await ctx.db.patch(existingUser._id, {
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
      });
      userId = existingUser._id;
    } else {
      userId = await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
      });
    }

    // Process any pending invitations for this email
    const pendingInvites = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", args.email.toLowerCase().trim()))
      .collect();

    for (const invite of pendingInvites) {
      // Check if membership already exists to prevent duplicates
      const existingMembership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", invite.orgId).eq("userId", userId)
        )
        .unique();

      if (!existingMembership) {
        await ctx.db.insert("memberships", {
          orgId: invite.orgId,
          userId: userId,
          roleId: invite.roleId,
        });
      }
      
      // Delete the invitation once processed
      await ctx.db.delete(invite._id);
    }
  },
});

/**
 * Deletes a user record and all their memberships when Clerk sends user.deleted.
 */
export const deleteUser = internalMutation({
  args: {
    clerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (existingUser) {
      // Clean up all memberships for this user
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", existingUser._id))
        .collect();

      for (const m of memberships) {
        await ctx.db.delete(m._id);
      }

      await ctx.db.delete(existingUser._id);
    }
  },
});
