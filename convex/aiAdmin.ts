import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { requireSuperAdmin } from "./utils/tenancy";
import { getValidatedEnv } from "./utils/env";
import { aiProviderValidator } from "./schema/ai.schema";
import {
  encryptProviderKey,
  isEncryptionConfigured,
  lastFour,
  readAiControlState,
  readEncryptedProviderKey,
  readOrgAiSettings,
  removeProviderKey as removeStoredProviderKey,
  setMasterSwitch,
  setOrgSwitch,
  storeEncryptedProviderKey,
  validateApiKeyShape,
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
    const apiKey = validateApiKeyShape(args.apiKey);
    const masterKey = getValidatedEnv().AI_KEY_ENCRYPTION_KEY;
    if (!isEncryptionConfigured(masterKey)) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "AI key encryption is not configured on this deployment.");
    }
    let encrypted: Awaited<ReturnType<typeof encryptProviderKey>>;
    try {
      encrypted = await encryptProviderKey({ provider: args.provider, plaintext: apiKey, masterKey });
    } catch (error) {
      // Log the error class only: never the message, the key or its length.
      console.error("AI provider key encryption failed", error instanceof Error ? error.name : "unknown");
      throwAppError(AppErrorCode.VALIDATION_FAILED, "The API key could not be saved. Please try again later.");
    }
    return await ctx.runMutation(internal.aiAdmin.storeProviderKey, {
      actorUserId,
      provider: args.provider,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.keyVersion,
      last4: lastFour(apiKey),
    });
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
  args: {
    actorUserId: v.id("users"),
    provider: anthropicOnly,
    ciphertext: v.string(),
    iv: v.string(),
    keyVersion: v.number(),
    last4: v.string(),
  },
  returns: v.object({ last4: v.string(), setAt: v.number() }),
  handler: async (ctx, args) => {
    return await storeEncryptedProviderKey(ctx, args);
  },
});

/** For the future draft writer (PR B). Internal only: returns ciphertext, never to a client. */
export const readEncryptedKey = internalQuery({
  args: { provider: aiProviderValidator },
  returns: v.union(
    v.null(),
    v.object({ ciphertext: v.string(), iv: v.string(), keyVersion: v.number() })
  ),
  handler: async (ctx, args) => {
    return await readEncryptedProviderKey(ctx, args.provider);
  },
});
