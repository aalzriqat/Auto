/**
 * The one writer of `webhookLogs`, extracted so a durable webhook observation
 * can be recorded from a MUTATION as well as through
 * `internal.adminSystem.logWebhookEvent`.
 *
 * SCRUM-302 needs this: the payment webhook's lifecycle refusal happens inside
 * `paymentIntents.settleByExternalId`, which is a mutation and therefore cannot
 * `runMutation` the logging function. Writing the evidence in the SAME
 * transaction as the refusal is also strictly better than asking the HTTP
 * caller to remember: the row cannot be lost by a caller that forgets, and it
 * cannot survive a rollback that discarded the thing it describes.
 *
 * It lives in `utils/` rather than in `adminSystem.ts` so that a domain module
 * can record an observation without importing the admin surface.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type WebhookLogSource = Doc<"webhookLogs">["source"];
export type WebhookLogStatus = Doc<"webhookLogs">["status"];

export interface WebhookLogInput {
  source: WebhookLogSource;
  status: WebhookLogStatus;
  summary: string;
  eventId?: string;
  payloadSha256?: string;
  rawPayload?: string;
  payloadPreview?: string;
  payloadTruncated?: boolean;
  error?: string;
}

export async function recordWebhookLog(
  ctx: MutationCtx,
  args: WebhookLogInput
): Promise<Id<"webhookLogs">> {
  return await ctx.db.insert("webhookLogs", { ...args, createdAt: Date.now() });
}
