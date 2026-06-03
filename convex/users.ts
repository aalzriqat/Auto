import { internalMutation, query } from "./_generated/server";
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
