import { internalMutation, mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAuth } from "./utils/tenancy";
import { isSystemOwnerRole } from "./utils/permissions";
import { Id } from "./_generated/dataModel";

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

    if (existingUser) {
      await ctx.db.patch(existingUser._id, {
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
      });
    } else {
      await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
      });
    }

    // Invitations are accepted through memberships.acceptInvitation using a
    // hashed token. A Clerk webhook with a matching email is not sufficient to
    // grant organization access.
  },
});

/**
 * Soft-disables a user when Clerk sends user.deleted.
 *
 * Do not delete the user row or memberships here: those IDs are referenced by
 * audit logs, ownership checks, sales, tasks, and other historical records.
 * Instead, anonymize profile data and queue a super-admin offboarding review.
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

    if (!existingUser) return;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", existingUser._id))
      .collect();

    const ownerOrgIds: Id<"organizations">[] = [];
    for (const membership of memberships) {
      const role = await ctx.db.get(membership.roleId);
      if (isSystemOwnerRole(role)) {
        ownerOrgIds.push(membership.orgId);
      }
    }

    const now = Date.now();
    await ctx.db.patch(existingUser._id, {
      email: `deleted-user-${existingUser._id}@deleted.autoflow.local`,
      name: "Deleted user",
      imageUrl: undefined,
      whatsappPhone: undefined,
      disabled: true,
      disabledAt: now,
      disabledReason: "clerk_user_deleted",
      clerkDeletedAt: now,
    });

    const pendingReview = await ctx.db
      .query("userOffboardingReviews")
      .withIndex("by_user_status", (q) => q.eq("userId", existingUser._id).eq("status", "PENDING_REVIEW"))
      .unique();

    if (pendingReview) {
      await ctx.db.patch(pendingReview._id, {
        membershipCount: memberships.length,
        ownerOrgIds,
        createdAt: now,
      });
    } else {
      await ctx.db.insert("userOffboardingReviews", {
        userId: existingUser._id,
        clerkId: args.clerkId,
        source: "clerk_user_deleted",
        status: "PENDING_REVIEW",
        membershipCount: memberships.length,
        ownerOrgIds,
        createdAt: now,
      });
    }
  },
});
