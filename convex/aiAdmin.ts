import { v } from "convex/values";
import type { Infer } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import {
  providerKeyStatusValidator,
  readAiControlState,
  readOrgAiSettings,
  readSealedProviderKey,
  removeProviderKey as removeStoredProviderKey,
  sealProviderKey,
  sealedProviderKeyValidator,
  testProviderConnection as testProviderConnectionWithKey,
  setMasterSwitch,
  setOrgSwitch,
  storeSealedProviderKey,
} from "./domains/ai";
import type { SealedProviderKey } from "./domains/ai";

/**
 * SCRUM-980 doors: super-admin control of AI drafts and the provider key store.
 * Logic lives in `convex/domains/ai`. Nothing here returns an API key, its
 * ciphertext or its IV.
 */

const anthropicOnly = v.literal("anthropic");

const connectionTestValidator = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("AUTH_FAILED"),
      v.literal("MODEL_UNAVAILABLE"),
      v.literal("PROVIDER_UNREACHABLE"),
      v.literal("KEY_NOT_SET"),
      v.literal("ENCRYPTION_NOT_CONFIGURED"),
      v.literal("EGRESS_SUNK")
    ),
  })
);

export const getAiControlState = query({
  args: {},
  returns: v.object({
    encryptionConfigured: v.boolean(),
    draftsEnabled: v.boolean(),
    providers: v.array(providerKeyStatusValidator),
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
  // v.any(), not an object validator: on a failed argument validation Convex
  // prints the whole argument object, API key included, into the deployment
  // logs. `sealProviderKey` parses the request by hand and refuses with fixed
  // text. The client sends `{ provider: "anthropic", apiKey }`.
  args: v.any(),
  returns: v.object({ last4: v.string(), setAt: v.number() }),
  handler: async (ctx, request): Promise<{ last4: string; setAt: number }> => {
    const actorUserId = await ctx.runQuery(internal.aiAdmin.assertSuperAdminForAiAction, {});
    const sealed = await sealProviderKey(request);
    return await ctx.runMutation(internal.aiAdmin.storeProviderKey, { actorUserId, sealed });
  },
});

/**
 * Checks the stored key against the provider. Changes nothing, so it writes no
 * audit row. The key is opened only inside the domain function.
 */
export const testProviderConnection = action({
  args: { provider: anthropicOnly },
  returns: connectionTestValidator,
  handler: async (ctx): Promise<Infer<typeof connectionTestValidator>> => {
    await ctx.runQuery(internal.aiAdmin.assertSuperAdminForAiAction, {});
    let sealedKey: SealedProviderKey | null;
    try {
      sealedKey = await ctx.runQuery(internal.aiAdmin.loadSealedKeyForTest, {});
    } catch (error) {
      // A validator failure message carries the whole object, sealed key included.
      console.error("AI key load for test failed", error instanceof Error ? error.name : "unknown");
      throw new Error("The stored key could not be read.");
    }
    return await testProviderConnectionWithKey({ sealedKey });
  },
});

export const loadSealedKeyForTest = internalQuery({
  args: {},
  returns: v.union(v.null(), sealedProviderKeyValidator),
  handler: async (ctx) => await readSealedProviderKey(ctx, "anthropic"),
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
