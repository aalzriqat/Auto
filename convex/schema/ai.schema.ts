import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * SCRUM-980: platform-level AI control and the provider key store.
 *
 * None of these tables is browsable in the admin Data Browser. `aiProviderKeys`
 * holds ciphertext only; the plaintext key is never written to any table.
 */
export const aiProviderValidator = v.union(v.literal("anthropic"), v.literal("openai"));

export const aiTables = {
  // Platform singleton: the master switch for AI drafts. No row reads as off.
  aiSettings: defineTable({
    draftsEnabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }),

  // Per-dealership switch. No row reads as off.
  aiOrgSettings: defineTable({
    orgId: v.id("organizations"),
    draftsEnabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  })
    .index("by_org", ["orgId"])
    .index("by_draftsEnabled", ["draftsEnabled"]),

  // One row per provider. `ciphertext` and `iv` are base64 (AES-256-GCM, fresh
  // 96-bit IV per save, provider name as additional authenticated data).
  aiProviderKeys: defineTable({
    provider: aiProviderValidator,
    ciphertext: v.string(),
    iv: v.string(),
    keyVersion: v.number(),
    last4: v.string(),
    setAt: v.number(),
    setBy: v.id("users"),
  }).index("by_provider", ["provider"]),
};
