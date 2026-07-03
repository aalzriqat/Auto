import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  postCommentReply as facebookPostCommentReply,
  postDirectMessage as facebookPostDm,
} from "./utils/facebookApi";
import {
  postCommentReply as instagramPostCommentReply,
  postDirectMessage as instagramPostDm,
} from "./utils/instagramApi";

// Only retry events created within the last 48 hours. Older failures are
// surfaced as "needs reply" in the inbox for manual follow-up.
const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;

// Give the initial webhook send action at least 5 minutes to complete before
// the cron considers an event "failed" and queues a retry. Webhook actions
// resolve in < 10 seconds; 5 minutes is a conservative safety margin.
const MIN_AGE_BEFORE_RETRY_MS = 5 * 60 * 1000;

export const getPendingFacebookAutoReplies = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - RETRY_WINDOW_MS;
    const minAge = now - MIN_AGE_BEFORE_RETRY_MS;

    // Use the index so only genuinely-pending events are scanned.
    // recordAutoReplyFailure clears pendingAutoReply when retries are exhausted,
    // so exhausted events fall out of this index naturally.
    return ctx.db
      .query("facebookEvents")
      .withIndex("by_pending_reply", (q) =>
        q.eq("pendingAutoReply", true).gt("_creationTime", cutoff)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("autoRepliedAt"), undefined),
          q.lt(q.field("_creationTime"), minAge)
        )
      )
      .take(50);
  },
});

export const getPendingInstagramAutoReplies = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - RETRY_WINDOW_MS;
    const minAge = now - MIN_AGE_BEFORE_RETRY_MS;

    return ctx.db
      .query("instagramEvents")
      .withIndex("by_pending_reply", (q) =>
        q.eq("pendingAutoReply", true).gt("_creationTime", cutoff)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("autoRepliedAt"), undefined),
          q.lt(q.field("_creationTime"), minAge)
        )
      )
      .take(50);
  },
});

/**
 * Retries pending auto-replies for both Facebook and Instagram.
 * Scheduled every 15 minutes by the crons module.
 *
 * Per event:
 *  - Success → markEventAutoReplied clears all pending/retry fields
 *  - Failure → recordAutoReplyFailure increments autoReplyRetryCount
 *  - After MAX_RETRIES failures the event stays as "needs reply" in the
 *    Social Inbox for manual follow-up
 */
export const retryPendingSocialAutoReplies = internalAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    const [fbEvents, igEvents] = await Promise.all([
      ctx.runQuery(internal.socialAutoReplyRetry.getPendingFacebookAutoReplies),
      ctx.runQuery(internal.socialAutoReplyRetry.getPendingInstagramAutoReplies),
    ]);

    let retried = 0;
    let succeeded = 0;
    let failed = 0;

    // ─── Facebook ────────────────────────────────────────────────────────────
    for (const ev of fbEvents) {
      const replyText = ev.pendingAutoReplyText!;
      const replySource = ev.pendingAutoReplySource ?? "canned";

      // Token fetch is isolated: a transient DB/network error for one org must
      // not abort the rest of the batch. Skip without counting as a retry attempt.
      let token;
      try {
        token = await ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: ev.orgId });
      } catch {
        continue;
      }
      if (!token) continue;

      retried++;
      try {
        const result =
          ev.kind === "comment"
            ? await facebookPostCommentReply(
                ev.externalId,
                replyText,
                token.facebookPageAccessToken
              )
            : await facebookPostDm(
                ev.senderFacebookId,
                replyText,
                token.facebookPageId,
                token.facebookPageAccessToken
              );

        if (result.ok) {
          await ctx.runMutation(internal.facebookEngagement.markEventAutoReplied, {
            eventId: ev._id,
            replyText,
            replySource,
          });
          succeeded++;
        } else {
          await ctx.runMutation(internal.facebookEngagement.recordAutoReplyFailure, {
            eventId: ev._id,
          });
          failed++;
        }
      } catch {
        await ctx.runMutation(internal.facebookEngagement.recordAutoReplyFailure, {
          eventId: ev._id,
        });
        failed++;
      }
    }

    // ─── Instagram ───────────────────────────────────────────────────────────
    for (const ev of igEvents) {
      const replyText = ev.pendingAutoReplyText!;
      const replySource = ev.pendingAutoReplySource ?? "canned";

      let token;
      try {
        token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: ev.orgId });
      } catch {
        continue;
      }
      if (!token) continue;

      retried++;
      try {
        const result =
          ev.kind === "comment"
            ? await instagramPostCommentReply(
                ev.externalId,
                replyText,
                token.instagramAccessToken
              )
            : await instagramPostDm(
                ev.senderInstagramId,
                replyText,
                token.instagramBusinessAccountId,
                token.instagramAccessToken
              );

        if (result.ok) {
          await ctx.runMutation(internal.instagramEngagement.markEventAutoReplied, {
            eventId: ev._id,
            replyText,
            replySource,
          });
          succeeded++;
        } else {
          await ctx.runMutation(internal.instagramEngagement.recordAutoReplyFailure, {
            eventId: ev._id,
          });
          failed++;
        }
      } catch {
        await ctx.runMutation(internal.instagramEngagement.recordAutoReplyFailure, {
          eventId: ev._id,
        });
        failed++;
      }
    }

    return `Retried ${retried} pending auto-replies: ${succeeded} succeeded, ${failed} failed.`;
  },
});
