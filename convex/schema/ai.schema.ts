import { defineTable } from "convex/server";
import { v } from "convex/values";
import { expenseCategoryValidator } from "../utils/expenseCategories";
import { paymentMethodValidator } from "../utils/paymentMethods";

/**
 * SCRUM-980: platform-level AI control and the provider key store.
 *
 * None of these tables is browsable in the admin Data Browser. `aiProviderKeys`
 * holds ciphertext only; the plaintext key is never written to any table.
 */
export const aiProviderValidator = v.union(v.literal("anthropic"), v.literal("openai"));

export const aiDraftPlatformValidator = v.union(v.literal("instagram"), v.literal("facebook"));

export const aiDraftStatusValidator = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("needs_person"),
  v.literal("failed"),
);

/** Fixed list. Never an error message, never provider text. */
export const aiDraftFailureReasonValidator = v.union(
  v.literal("timeout"),
  v.literal("provider_error"),
  v.literal("provider_auth"),
  v.literal("provider_rate_limited"),
  v.literal("refusal"),
  v.literal("truncated"),
  v.literal("invalid_output"),
  v.literal("key_unavailable"),
  v.literal("egress_sunk"),
  v.literal("not_enabled"),
);

/** SCRUM-1039: where an expense assistant request stands. */
export const aiExpenseProposalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("not_expense"),
  v.literal("not_understood"),
  v.literal("failed"),
);

/**
 * The fields the assistant proposes for the normal expense form. `date` is a calendar day,
 * `YYYY-MM-DD`, in the dealership time zone (no instant, no zone). Nothing here is an expense.
 */
export const expenseProposalValidator = v.object({
  amount: v.number(),
  taxAmount: v.optional(v.number()),
  category: expenseCategoryValidator,
  date: v.string(),
  title: v.string(),
  notes: v.optional(v.string()),
  vendorName: v.optional(v.string()),
  paymentMethod: v.optional(paymentMethodValidator),
});

export const aiTables = {
  // One row per draft request. Holds the staff-facing draft text, never the
  // prompt, the provider response or any key material.
  aiDrafts: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    platform: aiDraftPlatformValidator,
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    status: aiDraftStatusValidator,
    failureReason: v.optional(aiDraftFailureReasonValidator),
    draftText: v.optional(v.string()),
    handoverFallback: v.optional(v.boolean()),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    sentAt: v.optional(v.number()),
    sentBy: v.optional(v.id("users")),
    sentText: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer_platform", ["orgId", "customerId", "platform"]),

  // SCRUM-1039: one row per assistant request. The user's own message, and the proposal the
  // validated model answer produced. Never the prompt, the provider response or any key material.
  // Private to `requestedBy`; not an expense and not a ledger row.
  aiAssistantProposals: defineTable({
    orgId: v.id("organizations"),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    status: aiExpenseProposalStatusValidator,
    message: v.string(),
    failureReason: v.optional(aiDraftFailureReasonValidator),
    proposal: v.optional(expenseProposalValidator),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  }).index("by_org", ["orgId"]),

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
