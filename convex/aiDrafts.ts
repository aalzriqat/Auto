import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { aiDraftPlatformValidator } from "./schema/ai.schema";
import { PERMISSIONS } from "./utils/permissions";
import { requireSocialInboxFeature } from "./utils/socialDmAccess";
import { requireTenantAuth } from "./utils/tenancy";
import {
  completePendingDraft,
  DRAFT_EXPIRY_MS,
  draftJobValidator,
  draftOutcomeValidator,
  draftViewValidator,
  expirePendingDraft,
  runGenerateDraft,
  isAiDraftEnabledForOrg,
  loadDraftJobData,
  readDraftForStaff,
  requestDraftForStaff,
} from "./domains/ai";

/**
 * SCRUM-980 doors for the AI reply draft writer. Logic lives in
 * `convex/domains/ai`. A draft is only ever read by staff, who edit and send it
 * themselves: no function here sends a message.
 */

export const getAvailability = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);
    await requireSocialInboxFeature(ctx, args.orgId);
    return { enabled: await isAiDraftEnabledForOrg(ctx, args.orgId) };
  },
});

export const requestDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    platform: aiDraftPlatformValidator,
  },
  returns: v.object({ draftId: v.id("aiDrafts") }),
  handler: async (ctx, args) => {
    const { draftId, created } = await requestDraftForStaff(ctx, args);
    if (created) {
      await ctx.scheduler.runAfter(0, internal.aiDrafts.generateDraft, { draftId });
      await ctx.scheduler.runAfter(DRAFT_EXPIRY_MS, internal.aiDrafts.expireDraft, { draftId });
    }
    return { draftId };
  },
});

export const getDraft = query({
  args: { orgId: v.id("organizations"), draftId: v.id("aiDrafts") },
  returns: draftViewValidator,
  handler: async (ctx, args) => await readDraftForStaff(ctx, args),
});

export const loadDraftJob = internalQuery({
  args: { draftId: v.id("aiDrafts") },
  returns: draftJobValidator,
  handler: async (ctx, args) => await loadDraftJobData(ctx, args.draftId),
});

export const completeDraft = internalMutation({
  args: { draftId: v.id("aiDrafts"), outcome: draftOutcomeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await completePendingDraft(ctx, args.draftId, args.outcome);
    return null;
  },
});

export const expireDraft = internalMutation({
  args: { draftId: v.id("aiDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await expirePendingDraft(ctx, args.draftId);
    return null;
  },
});

/**
 * The provider call. The plaintext key exists only inside `runDraftJob`: this
 * door passes the sealed key through and never opens it.
 */
export const generateDraft = internalAction({
  args: { draftId: v.id("aiDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { draftId } = args;
    await runGenerateDraft({
      load: () => ctx.runQuery(internal.aiDrafts.loadDraftJob, { draftId }),
      complete: (outcome) => ctx.runMutation(internal.aiDrafts.completeDraft, { draftId, outcome }),
    });
    return null;
  },
});