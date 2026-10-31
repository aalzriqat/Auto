// SCRUM-842: redaction of a Meta user id out of retained `webhookLogs` rows.
//
// A signed deauthorize or data-deletion callback names one Meta user. Rows
// written before SCRUM-842 carry that id in their summary, and SCRUM-807
// forbids deleting operational history, so the id is replaced with fixed text
// and the row stays. The disposition is a coordinator decision (authority
// delegated by the owner), not an owner ruling.
//
// Bounded and resumable: one transaction examines at most
// META_LOG_REDACTION_PAGE_SIZE rows of ONE source (`<platform>-oauth`) through
// the existing `by_source_and_eventId` index, so no table scan and no new index.
// If more rows remain it schedules itself with the pagination cursor. Re-running
// is a no-op because a redacted row no longer contains the id.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import {
  META_LOG_REDACTION_PAGE_SIZE,
  metaOauthLogSource,
  redactMetaUserIdInText,
  type MetaPlatform,
} from "./utils/metaUserIdRedaction";

interface RedactionPageArgs {
  platform: MetaPlatform;
  metaUserId: string;
  /** The deletion receipt to mark complete once the last page is redacted. */
  receiptCode?: string;
  cursor: string | null;
}

/**
 * Redacts one page. When the last page is done, marks the receipt complete: the
 * status page must not say "processed" while rows still carry the id. Otherwise
 * schedules the next page. Runs inside the caller's transaction.
 */
export async function redactMetaUserFromWebhookLogs(ctx: MutationCtx, args: RedactionPageArgs): Promise<void> {
  const page = await ctx.db
    .query("webhookLogs")
    .withIndex("by_source_and_eventId", (q) => q.eq("source", metaOauthLogSource(args.platform)))
    .paginate({ numItems: META_LOG_REDACTION_PAGE_SIZE, cursor: args.cursor });

  for (const row of page.page) {
    const redacted = redactMetaUserIdInText(row.summary, args.metaUserId);
    if (redacted !== row.summary) await ctx.db.patch(row._id, { summary: redacted });
  }

  if (!page.isDone) {
    // The scheduler keeps the arguments of a finished job for 7 days
    // (https://docs.convex.dev/scheduling/scheduled-functions), so on the rare
    // multi-page run the id is held there, not in any application table.
    await ctx.scheduler.runAfter(0, internal.metaLogRedaction.redactMetaUserFromLogsPage, {
      platform: args.platform,
      metaUserId: args.metaUserId,
      receiptCode: args.receiptCode,
      cursor: page.continueCursor,
    });
    return;
  }

  if (args.receiptCode !== undefined) {
    const code = args.receiptCode;
    const receipt = await ctx.db
      .query("metaDataDeletionRequests")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (receipt && receipt.completedAt === undefined) {
      await ctx.db.patch(receipt._id, { completedAt: Date.now() });
    }
  }
}

/**
 * Entry point for the deauthorize callback (no receipt) and the follow-up page
 * of a longer run. The data-deletion callback runs its first page inside
 * `socialIntegrations.recordMetaDataDeletion` so the receipt and that page
 * commit together.
 */
export const redactMetaUserFromLogsPage = internalMutation({
  args: {
    platform: v.union(v.literal("facebook"), v.literal("instagram")),
    metaUserId: v.string(),
    receiptCode: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await redactMetaUserFromWebhookLogs(ctx, args);
    return null;
  },
});
