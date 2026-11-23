import type { Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { rateLimiter } from "../../rateLimit";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { PERMISSIONS } from "../../utils/permissions";
import { requireSocialDmAccess, requireSocialInboxFeature } from "../../utils/socialDmAccess";
import { requireTenantAuth } from "../../utils/tenancy";
import { ANTHROPIC_DRAFT_MODEL } from "./anthropicAdapter";
import type { draftOutcomeValidator, draftViewValidator } from "./draftValidators";
import { isAiDraftEnabledForOrg } from "./settings";

/** A pending draft older than this is dead: the action never reported back. */
export const DRAFT_EXPIRY_MS = 120_000;

// How many of a customer's newest drafts are scanned for a pending one.
const PENDING_SCAN = 5;

type DraftPlatform = Doc<"aiDrafts">["platform"];
export type StoredDraftOutcome = Infer<typeof draftOutcomeValidator>;
export type DraftView = Infer<typeof draftViewValidator>;

/**
 * One staff request for one draft. A second press while a fresh draft is still
 * pending returns that draft and schedules nothing; a stale pending draft is
 * failed in this same transaction and replaced. `created` tells the door
 * whether to schedule the job and its expiry.
 */
export async function requestDraftForStaff(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; customerId: Id<"customers">; platform: DraftPlatform }
): Promise<{ draftId: Id<"aiDrafts">; created: boolean }> {
  const { user, dmEvent } = await requireSocialDmAccess(ctx, args);
  if (!(await isAiDraftEnabledForOrg(ctx, args.orgId))) {
    throwAppError(AppErrorCode.AI_DRAFT_NOT_ENABLED, "AI drafts are not turned on for this dealership.");
  }
  const userLimit = await rateLimiter.limit(ctx, "aiDraftRequestUser", { key: `${args.orgId}:${user._id}` });
  const orgLimit = await rateLimiter.limit(ctx, "aiDraftRequest", { key: args.orgId });
  if (!userLimit.ok || !orgLimit.ok) {
    throwAppError(AppErrorCode.AI_DRAFT_RATE_LIMITED, "Too many draft requests. Please wait and try again.");
  }
  if (!dmEvent) {
    throwAppError(AppErrorCode.AI_DRAFT_NO_CONVERSATION, "This customer has no private message conversation.");
  }
  const customer = await ctx.db.get(args.customerId);
  if (!customer || customer.orgId !== args.orgId) {
    throwAppError(AppErrorCode.CUSTOMER_NOT_FOUND, "Customer not found.");
  }

  const now = Date.now();
  const recent = await ctx.db
    .query("aiDrafts")
    .withIndex("by_org_customer_platform", (q) =>
      q.eq("orgId", args.orgId).eq("customerId", args.customerId).eq("platform", args.platform)
    )
    .order("desc")
    .take(PENDING_SCAN);
  const pending = recent.find((row) => row.status === "pending");
  if (pending) {
    if (now - pending.requestedAt < DRAFT_EXPIRY_MS) return { draftId: pending._id, created: false };
    await ctx.db.patch(pending._id, { status: "failed", failureReason: "timeout", completedAt: now });
  }

  const draftId = await ctx.db.insert("aiDrafts", {
    orgId: args.orgId,
    customerId: args.customerId,
    platform: args.platform,
    requestedBy: user._id,
    requestedAt: now,
    status: "pending",
    model: ANTHROPIC_DRAFT_MODEL,
  });
  return { draftId, created: true };
}

/** What staff may read. A draft of another dealership reads as not found. */
export async function readDraftForStaff(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; draftId: Id<"aiDrafts"> }
): Promise<DraftView> {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);
  await requireSocialInboxFeature(ctx, args.orgId);
  const row = await ctx.db.get(args.draftId);
  if (!row || row.orgId !== args.orgId) return null;
  const view: NonNullable<DraftView> = { status: row.status };
  if (row.draftText !== undefined) view.text = row.draftText;
  if (row.handoverFallback !== undefined) view.handoverFallback = row.handoverFallback;
  return view;
}

/** The scheduled expiry: a draft whose action never reported back fails. */
export async function expirePendingDraft(ctx: MutationCtx, draftId: Id<"aiDrafts">): Promise<void> {
  const row = await ctx.db.get(draftId);
  if (!row || row.status !== "pending") return;
  await ctx.db.patch(draftId, { status: "failed", failureReason: "timeout", completedAt: Date.now() });
}

/** Stores the outcome only while the row is still pending: a late job writes nothing. */
export async function completePendingDraft(
  ctx: MutationCtx,
  draftId: Id<"aiDrafts">,
  outcome: StoredDraftOutcome
): Promise<void> {
  const row = await ctx.db.get(draftId);
  if (!row || row.status !== "pending") return;
  const completedAt = Date.now();
  if (outcome.status === "failed") {
    await ctx.db.patch(draftId, { status: "failed", failureReason: outcome.failureReason, completedAt });
    return;
  }
  const usage = { model: outcome.model, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, completedAt };
  if (outcome.status === "needs_person") {
    await ctx.db.patch(draftId, { status: "needs_person", ...usage });
    return;
  }
  await ctx.db.patch(draftId, {
    status: "ready",
    draftText: outcome.text,
    handoverFallback: outcome.handoverFallback,
    ...usage,
  });
}
