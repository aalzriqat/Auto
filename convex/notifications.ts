import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
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
 * means an account whose most recent 100 unread notifications are *all*
 * archived would report 0 while an older unarchived one exists. The badge
 * saturates at 9+, so the only visible consequence is a badge that reads 0
 * instead of 9+ in a case that requires 100 consecutive archived-but-unread
 * rows. Reading thousands of documents on every page to close that gap is the
 * worse trade.
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
 * Returns `{ markedRead, hasMore }` so a caller with a large backlog can call
 * again. `hasMore` is a boolean rather than a remaining *count* on purpose:
 * reading one row past the batch is enough to know more exists, and reporting
 * a number there would mean either scanning the whole backlog again — the
 * thing this change exists to stop — or returning a figure that is only ever
 * 0 or 1 while pretending to be a total.
 *
 * It deliberately does not self-schedule. Unlike the aggregate backfills this
 * is a foreground action someone is watching, so finishing what fits and
 * saying so beats appearing complete while work continues invisibly.
 *
 * Existing callers ignore the return value and keep working — the badge they
 * watch just drops by a batch at a time on a very large backlog.
 */
export const markAllAsRead = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args): Promise<{ markedRead: number; hasMore: boolean }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    // One row beyond the batch, purely to answer "is there more?" without a
    // second query.
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org_user_read", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id).eq("isRead", false)
      )
      .take(MARK_ALL_BATCH + 1);

    const batch = unread.slice(0, MARK_ALL_BATCH);
    for (const notif of batch) {
      await ctx.db.patch(notif._id, { isRead: true });
    }

    return { markedRead: batch.length, hasMore: unread.length > MARK_ALL_BATCH };
  },
});

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
