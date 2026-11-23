import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { requireSocialDmAccess } from "../../utils/socialDmAccess";
import { isAiDraftEnabledForOrg } from "./settings";

interface DraftLinkTarget {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
  platform: Doc<"aiDrafts">["platform"];
  aiDraftId: Id<"aiDrafts">;
}

function belongsToTarget(draft: Doc<"aiDrafts"> | null, target: DraftLinkTarget): draft is Doc<"aiDrafts"> {
  return (
    draft !== null &&
    draft.orgId === target.orgId &&
    draft.customerId === target.customerId &&
    draft.platform === target.platform
  );
}

function isLinkable(draft: Doc<"aiDrafts">): boolean {
  return draft.status === "ready" && draft.sentAt === undefined;
}

/**
 * Runs before the message is posted to Meta. A draft that is missing or belongs
 * to another dealership, customer or platform refuses the send outright. A
 * draft in any other state (not ready, already sent, feature switched off
 * since) lets the message go out unlinked: null.
 */
export async function resolveLinkableDraft(ctx: QueryCtx, target: DraftLinkTarget): Promise<Id<"aiDrafts"> | null> {
  const draft = await ctx.db.get(target.aiDraftId);
  if (!belongsToTarget(draft, target)) {
    throwAppError(AppErrorCode.AI_DRAFT_NOT_FOUND, "This draft was not found.");
  }
  if (!isLinkable(draft)) return null;
  if (!(await isAiDraftEnabledForOrg(ctx, target.orgId))) return null;
  return draft._id;
}

/**
 * Runs when a manual reply is recorded: returns the draft id to store on the
 * event, or null (which clears any earlier link, so an event never keeps a
 * draft its text did not come from).
 */
export async function linkReplyDraft(
  ctx: MutationCtx,
  args: {
    eventId: Id<"instagramEvents"> | Id<"facebookEvents">;
    platform: Doc<"aiDrafts">["platform"];
    aiDraftId?: Id<"aiDrafts">;
    sentBy: Id<"users">;
    sentText: string;
  }
): Promise<Id<"aiDrafts"> | null> {
  const { aiDraftId } = args;
  if (!aiDraftId) return null;
  const event = await ctx.db.get(args.eventId);
  if (!event?.customerId) return null;
  return await linkSentDraft(ctx, { ...args, orgId: event.orgId, customerId: event.customerId, aiDraftId });
}

export const dmSendArgs = {
  orgId: v.id("organizations"),
  customerId: v.id("customers"),
  aiDraftId: v.optional(v.id("aiDrafts")),
};

interface SendAccess<Event> {
  dmEvent: Event | null;
  orgSettings: Doc<"orgSettings"> | null;
  userId: Id<"users">;
  /** The draft to link once the message is delivered; null sends the message unlinked. */
  linkedDraftId: Id<"aiDrafts"> | null;
}

type SendAccessArgs = {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
  aiDraftId?: Id<"aiDrafts">;
};

/**
 * Access check for a manual direct message that may carry an AI draft: the
 * shared DM access rule, then the draft's tenancy check (a mismatched draft
 * refuses before anything is posted to Meta).
 */
export async function requireSendAccess(
  ctx: QueryCtx,
  args: SendAccessArgs & { platform: "instagram" }
): Promise<SendAccess<Doc<"instagramEvents">>>;
export async function requireSendAccess(
  ctx: QueryCtx,
  args: SendAccessArgs & { platform: "facebook" }
): Promise<SendAccess<Doc<"facebookEvents">>>;
export async function requireSendAccess(
  ctx: QueryCtx,
  args: SendAccessArgs & { platform: Doc<"aiDrafts">["platform"] }
): Promise<SendAccess<Doc<"instagramEvents"> | Doc<"facebookEvents">>> {
  const { aiDraftId, ...target } = args;
  const { user, dmEvent, orgSettings } = await requireSocialDmAccess(ctx, target);
  const linkedDraftId = aiDraftId ? await resolveLinkableDraft(ctx, { ...target, aiDraftId }) : null;
  return { dmEvent, orgSettings, userId: user._id, linkedDraftId };
}

/**
 * Runs after the message was delivered. Records who sent which text; the first
 * writer wins. It never throws: a failure here must not turn a delivered
 * message into an error the staff member would answer by sending it again.
 */
export async function linkSentDraft(
  ctx: MutationCtx,
  target: DraftLinkTarget & { sentBy: Id<"users">; sentText: string }
): Promise<Id<"aiDrafts"> | null> {
  try {
    const draft = await ctx.db.get(target.aiDraftId);
    if (!belongsToTarget(draft, target) || !isLinkable(draft)) return null;
    await ctx.db.patch(draft._id, { sentAt: Date.now(), sentBy: target.sentBy, sentText: target.sentText });
    return draft._id;
  } catch (error) {
    console.error("AI draft link failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
