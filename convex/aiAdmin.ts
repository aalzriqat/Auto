import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { aiProviderValidator } from "./schema/ai.schema";
import {
  readAiControlState,
  readOrgAiSettings,
  removeProviderKey as removeStoredProviderKey,
  sealProviderKey,
  sealedProviderKeyValidator,
  setMasterSwitch,
  setOrgSwitch,
  storeSealedProviderKey,
} from "./domains/ai";

/**
 * SCRUM-980 doors: super-admin control of AI drafts and the provider key store.
 * Logic lives in `convex/domains/ai`. Nothing here returns an API key, its
 * ciphertext or its IV.
 */

const anthropicOnly = v.literal("anthropic");

export const getAiControlState = query({
  args: {},
  returns: v.object({
    encryptionConfigured: v.boolean(),
    draftsEnabled: v.boolean(),
    providers: v.array(
      v.object({
        provider: aiProviderValidator,
        isSet: v.boolean(),
        last4: v.optional(v.string()),
        setAt: v.optional(v.number()),
      })
    ),
    enabledOrgs: v.array(v.object({ orgId: v.id("organizations"), name: v.string() })),
  }),
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    return await readAiControlState(ctx);
  },
});

export const setAiDraftsEnabled = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    await setMasterSwitch(ctx, actor, args.enabled);
    return null;
  },
});

export const getOrgAiSettings = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({ draftsEnabled: v.boolean() }),
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await readOrgAiSettings(ctx, args.orgId);
  },
});

export const setOrgAiDraftsEnabled = mutation({
  args: { orgId: v.id("organizations"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    await setOrgSwitch(ctx, actor, args.orgId, args.enabled);
    return null;
  },
});

export const removeProviderKey = mutation({
  args: { provider: anthropicOnly },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    await removeStoredProviderKey(ctx, actor, args.provider);
    return null;
  },
});

/**
 * An ACTION, not a mutation: the IV needs real randomness, and the plaintext
 * key must never be persisted as a function argument. It exists only in this
 * handler's memory; only ciphertext crosses into `storeProviderKey`.
 */
export const saveProviderKey = action({
  args: { provider: anthropicOnly, apiKey: v.string() },
  returns: v.object({ last4: v.string(), setAt: v.number() }),
  handler: async (ctx, args): Promise<{ last4: string; setAt: number }> => {
    const actorUserId = await ctx.runQuery(internal.aiAdmin.assertSuperAdminForAiAction, {});
    const sealed = await sealProviderKey({ provider: args.provider, apiKey: args.apiKey });
    return await ctx.runMutation(internal.aiAdmin.storeProviderKey, { actorUserId, sealed });
  },
});

export const assertSuperAdminForAiAction = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => {
    const admin = await requireSuperAdmin(ctx);
    return admin._id;
  },
});

export const storeProviderKey = internalMutation({
  args: { actorUserId: v.id("users"), sealed: sealedProviderKeyValidator },
  returns: v.object({ last4: v.string(), setAt: v.number() }),
  handler: async (ctx, args) => {
    return await storeSealedProviderKey(ctx, args);
  },
});
