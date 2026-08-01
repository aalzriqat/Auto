import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";

/** Capped recent feed for the bell dropdown. */
export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // userId is derived from the authenticated identity, never trusted from the client.
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .order("desc") // newest first
      .take(75);

    return notifications.filter((n) => !n.isArchived).slice(0, 50);
  },
});

/**
 * Ceiling on the rows the bell badge will read.
 *
 * The badge saturates — mobile renders `> 9 ? "9+" : count` — so an exact
 * figure above single digits is never displayed. This used to `.collect()` the
 * whole unread index to produce that one number: on the shared dev deployment
 * one account had **4,201** unread notifications, every one of them read on
 * every page load, as a live subscription that re-runs on each new
 * notification. Production's worst account is 76 today, which is only a
 * statement about how young the data is — nothing prunes notifications and
 * nothing caps this, so it grows forever.
 *
 * 100 is far above the display threshold and far below anything expensive.
 */
const UNREAD_BADGE_CAP = 100;

/**
 * Unread count for the bell badge, via the indexed (orgId, userId, isRead)
 * lookup, bounded to `UNREAD_BADGE_CAP` rows.
 *
 * Still returns a bare number. Returning `{ count, atLeast }` would say more,
 * but `unreadCount` is a published contract the mobile app consumes as a
 * number and mobile ships on its own OTA cadence — a breaking change here to
 * express "100+" in a badge that already saturates at "9+" buys nothing and
 * risks a version skew where the badge renders `[object Object]`.
 *
 * The `isArchived` filter has to stay outside the index — `archive` sets
 * `isArchived` without setting `isRead`, so an archived row can still be
 * unread, and no index covers that combination. With the cap in place that
 * means an account whose 100 *newest* unread notifications are all archived
 * would report 0 while an older unarchived one exists. Reading newest-first
 * makes that about as unlikely as it can be without a new index, since
 * archiving is something people do to old notifications. The badge saturates
 * at 9+, so the visible cost of the remaining gap is a badge reading 0 instead
 * of 9+ for someone who archived their last hundred without reading them —
 * against reading thousands of documents on every page for everyone else.
 */
export const unreadCount = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org_user_read", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id).eq("isRead", false)
      )
      // Newest first. Without this the cap keeps the *oldest* hundred, which is
      // the wrong hundred twice over: the badge is about what just arrived, and
      // archiving happens to old notifications — so an ascending cap loads the
      // rows most likely to be filtered out as archived.
      .order("desc")
      .take(UNREAD_BADGE_CAP);

    return unread.filter((n) => !n.isArchived).length;
  },
});

/** Paginated history for the dedicated /notifications page, with optional category/archived filters. */
export const listPage = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    category: v.optional(v.string()),
    showArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const wantArchived = Boolean(args.showArchived);

    const baseQuery = args.category
      ? ctx.db
          .query("notifications")
          .withIndex("by_org_user_category", (q) =>
            q.eq("orgId", args.orgId).eq("userId", user._id).eq("category", args.category)
          )
          // Filter archived state in the query chain (before paginate) to avoid
          // sparse pages from post-cursor JS filtering.
          .filter((q) =>
            wantArchived
              ? q.eq(q.field("isArchived"), true)
              : q.neq(q.field("isArchived"), true)
          )
      : ctx.db
          .query("notifications")
          // by_org_user_archived index covers the common case; isArchived is
          // stored as true or undefined (never false) so archived=false means
          // the field is absent, which Convex treats as undefined in eq checks.
          .withIndex("by_org_user_archived", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("userId", user._id)
              .eq("isArchived", wantArchived ? (true as const) : undefined)
          );

    return await baseQuery.order("desc").paginate(args.paginationOpts);
  },
});

export const markAsRead = mutation({
  args: {
    orgId: v.id("organizations"),
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.orgId !== args.orgId || notification.userId !== user._id) {
      throw new ConvexError("Notification not found.");
    }

    await ctx.db.patch(args.notificationId, { isRead: true });
  },
});

/**
 * Rows `markAllAsRead` will clear per invocation.
 *
 * This used to read *and patch* every unread row in one transaction. That is
 * fine at 76 rows and not fine at the 4,201 one dev account reached: a Convex
 * mutation has a bounded write budget, so past some backlog "mark all as read"
 * stops working entirely — and it fails for exactly the users who need it most,
 * with no partial progress, because a throw rolls the whole transaction back.
 *
 * 500 keeps a call well inside the budget while clearing any realistic backlog
 * in a couple of rounds.
 */
const MARK_ALL_BATCH = 500;

/**
 * Marks the caller's unread notifications read, up to `MARK_ALL_BATCH` per
 * call.
 *
 * Returns `{ markedRead, hasMore }`, and **drains the rest itself** when a
 * backlog exceeds one batch.
 *
 * The continuation is server-side rather than a loop in the callers. Three
 * places call this — the web bell, the web notifications page, and the mobile
 * bell — and mobile ships on its own OTA cadence, so a client-side loop would
 * have to be written three times and would leave any client that had not
 * shipped it silently clearing only the first 500. The badge is a live
 * subscription, so the user watches the count fall to zero either way; nothing
 * about this is hidden from them.
 *
 * `hasMore` is a boolean rather than a remaining count: reading one row past
 * the batch is enough to know more exists, whereas a number there would mean
 * rescanning the backlog — the thing this change removes — or returning a
 * figure only ever 0 or 1 while pretending to be a total.
 */
export const markAllAsRead = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args): Promise<{ markedRead: number; hasMore: boolean }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    return await markUnreadBatch(ctx, args.orgId, user._id);
  },
});

/**
 * Continuation for `markAllAsRead`.
 *
 * Internal, and takes `userId` explicitly, because a scheduled call carries no
 * identity — `requireTenantAuth` cannot run here. That makes the caller
 * responsible for the tenancy decision, which is why the only caller is
 * `markUnreadBatch` passing the id it just authenticated.
 */
export const continueMarkAllAsRead = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ markedRead: number; hasMore: boolean }> => {
    return await markUnreadBatch(ctx, args.orgId, args.userId);
  },
});

/**
 * Clears one bounded batch of a user's unread notifications and schedules
 * itself again if more remain.
 *
 * A throw rolls back both the patches and the scheduled continuation, so a
 * failure stops the chain cleanly instead of leaving an orphaned drain.
 */
async function markUnreadBatch(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
): Promise<{ markedRead: number; hasMore: boolean }> {
  // One row beyond the batch, purely to answer "is there more?" without a
  // second query.
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_org_user_read", (q) =>
      q.eq("orgId", orgId).eq("userId", userId).eq("isRead", false)
    )
    .take(MARK_ALL_BATCH + 1);

  const batch = unread.slice(0, MARK_ALL_BATCH);
  for (const notif of batch) {
    await ctx.db.patch(notif._id, { isRead: true });
  }

  const hasMore = unread.length > MARK_ALL_BATCH;
  if (hasMore) {
    await ctx.scheduler.runAfter(0, internal.notifications.continueMarkAllAsRead, {
      orgId,
      userId,
    });
  }

  return { markedRead: batch.length, hasMore };
}

export const archive = mutation({
  args: {
    orgId: v.id("organizations"),
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.orgId !== args.orgId || notification.userId !== user._id) {
      throw new ConvexError("Notification not found.");
    }

    await ctx.db.patch(args.notificationId, { isArchived: true, archivedAt: Date.now() });
  },
});
