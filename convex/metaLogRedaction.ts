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
// Re-running is a no-op because a redacted row no longer contains the id.
//
// The next page is NOT scheduled. Convex keeps a finished scheduled function and
// its arguments readable in `_scheduled_functions` for 7 days
// (https://docs.convex.dev/scheduling/scheduled-functions), so a continuation
// scheduled with the Meta user id (or the receipt code that links the request to
// it) would keep the identifier this redaction exists to erase. Instead each page
// returns its cursor and the HTTP callback, which already holds the id for the
// request, runs the next page with `ctx.runMutation`. Arguments of a direct call
// are not stored by the scheduler, so the id lives in no table at all.
import { v } from "convex/values";
import type { Infer } from "convex/values";
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

/** What one page reports back: whether it was the last, and where the next starts. */
export const metaLogRedactionPageResult = v.object({
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});
export type MetaLogRedactionPageResult = Infer<typeof metaLogRedactionPageResult>;

/**
 * Redacts one page. When the last page is done, marks the receipt complete: the
 * status page must not say "processed" while rows still carry the id. Otherwise
 * returns the cursor of the next page; the caller runs it. Runs inside the
 * caller's transaction.
 */
export async function redactMetaUserFromWebhookLogs(
  ctx: MutationCtx,
  args: RedactionPageArgs,
): Promise<MetaLogRedactionPageResult> {
  const page = await ctx.db
    .query("webhookLogs")
    .withIndex("by_source_and_eventId", (q) => q.eq("source", metaOauthLogSource(args.platform)))
    .paginate({ numItems: META_LOG_REDACTION_PAGE_SIZE, cursor: args.cursor });

  for (const row of page.page) {
    const redacted = redactMetaUserIdInText(row.summary, args.metaUserId);
    if (redacted !== row.summary) await ctx.db.patch(row._id, { summary: redacted });
  }

  if (!page.isDone) return { isDone: false, continueCursor: page.continueCursor };

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
  return { isDone: true, continueCursor: null };
}

/**
 * One page of the redaction, called by the Meta callback in `convex/http.ts` for
 * every page after the first of a deauthorize run, and every page after the
 * first of a data-deletion run (whose first page runs inside
 * `socialIntegrations.recordMetaDataDeletion` so the receipt and that page
 * commit together). It is only ever called directly, never scheduled.
 */
export const redactMetaUserFromLogsPage = internalMutation({
  args: {
    platform: v.union(v.literal("facebook"), v.literal("instagram")),
    metaUserId: v.string(),
    receiptCode: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: metaLogRedactionPageResult,
  handler: async (ctx, args): Promise<MetaLogRedactionPageResult> => redactMetaUserFromWebhookLogs(ctx, args),
});