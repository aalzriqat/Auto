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

// After the external reply send succeeds, persisting that fact via `markFn`
// is a single-document patch that should essentially never fail — but if a
// transient Convex error hits it, we must retry the mark itself rather than
// falling back to recordAutoReplyFailure, which would re-arm the event for
// pickup and risk posting the same reply to the customer a second time.
async function markRepliedWithRetry(markFn: () => Promise<unknown>, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await markFn();
      return true;
    } catch {
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  return false;
}

type PendingReplyEvent = {
  _id: unknown;
  orgId: unknown;
  pendingAutoReplyText?: string;
  pendingAutoReplySource?: "smart" | "canned";
};

type RetryBatchStats = { retried: number; succeeded: number; failed: number; unconfirmed: number };

// Shared per-platform retry flow: token lookup, send, success marking, and
// failure recording. Facebook and Instagram wire in their own token/send/mark
// functions below — this only owns the outcome bookkeeping and the
// send-succeeded-but-not-yet-durably-recorded handling.
async function retryBatch<TEvent extends PendingReplyEvent, TToken>(
  events: TEvent[],
  config: {
    getToken: (orgId: TEvent["orgId"]) => Promise<TToken | null>;
    send: (ev: TEvent, token: TToken) => Promise<{ ok: boolean }>;
    markReplied: (ev: TEvent, replyText: string, replySource: "smart" | "canned") => Promise<unknown>;
    recordFailure: (ev: TEvent) => Promise<unknown>;
  }
): Promise<RetryBatchStats> {
  const stats: RetryBatchStats = { retried: 0, succeeded: 0, failed: 0, unconfirmed: 0 };

  for (const ev of events) {
    const replyText = ev.pendingAutoReplyText!;
    const replySource = ev.pendingAutoReplySource ?? "canned";

    // Token fetch is isolated: a transient DB/network error for one org must
    // not abort the rest of the batch. Skip without counting as a retry attempt.
    let token: TToken | null;
    try {
      token = await config.getToken(ev.orgId);
    } catch {
      continue;
    }
    if (!token) continue;

    stats.retried++;
    try {
      const result = await config.send(ev, token);
      if (result.ok) {
        const marked = await markRepliedWithRetry(() => config.markReplied(ev, replyText, replySource));
        if (marked) {
          stats.succeeded++;
        } else {
          // Reply was sent but we could not durably record it after retries.
          // Do NOT call recordFailure: that would re-arm the event for pickup
          // and risk sending this exact reply again.
          stats.unconfirmed++;
        }
      } else {
        await config.recordFailure(ev);
        stats.failed++;
      }
    } catch {
      await config.recordFailure(ev);
      stats.failed++;
    }
  }

  return stats;
}

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

    const fb = await retryBatch(fbEvents, {
      getToken: (orgId) => ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId }),
      send: (ev, token) => {
        const channel = ev.pendingAutoReplyChannel ?? ev.kind;
        return channel === "comment"
          ? facebookPostCommentReply(ev.externalId, ev.pendingAutoReplyText!, token.facebookPageAccessToken)
          : facebookPostDm(
              ev.senderFacebookId,
              ev.pendingAutoReplyText!,
              token.facebookPageId,
              token.facebookPageAccessToken
            );
      },
      markReplied: (ev, replyText, replySource) =>
        ctx.runMutation(internal.facebookEngagement.markEventAutoReplied, { eventId: ev._id, replyText, replySource }),
      recordFailure: (ev) =>
        ctx.runMutation(internal.facebookEngagement.recordAutoReplyFailure, { eventId: ev._id }),
    });

    const ig = await retryBatch(igEvents, {
      getToken: (orgId) => ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId }),
      send: (ev, token) => {
        const channel = ev.pendingAutoReplyChannel ?? ev.kind;
        return channel === "comment"
          ? instagramPostCommentReply(ev.externalId, ev.pendingAutoReplyText!, token.instagramAccessToken)
          : instagramPostDm(
              ev.senderInstagramId,
              ev.pendingAutoReplyText!,
              token.instagramBusinessAccountId,
              token.instagramAccessToken
            );
      },
      markReplied: (ev, replyText, replySource) =>
        ctx.runMutation(internal.instagramEngagement.markEventAutoReplied, { eventId: ev._id, replyText, replySource }),
      recordFailure: (ev) =>
        ctx.runMutation(internal.instagramEngagement.recordAutoReplyFailure, { eventId: ev._id }),
    });

    const retried = fb.retried + ig.retried;
    const succeeded = fb.succeeded + ig.succeeded;
    const failed = fb.failed + ig.failed;
    const unconfirmed = fb.unconfirmed + ig.unconfirmed;

    return `Retried ${retried} pending auto-replies: ${succeeded} succeeded, ${failed} failed${unconfirmed > 0 ? `, ${unconfirmed} sent but unconfirmed (check audit log)` : ""}.`;
  },
});
