import { v } from "convex/values";
import { aiDraftFailureReasonValidator, aiDraftStatusValidator } from "../../schema/ai.schema";
import { sealedProviderKeyValidator } from "./keyStore";

/** The projected context the draft job hands from the query to the action. */
export const draftContextValidator = v.object({
  org: v.object({
    name: v.optional(v.string()),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    currency: v.string(),
  }),
  vehicle: v.union(
    v.null(),
    v.object({
      year: v.number(),
      make: v.string(),
      model: v.string(),
      trim: v.optional(v.string()),
      mileage: v.number(),
      color: v.string(),
      fuelType: v.string(),
      transmission: v.string(),
      status: v.string(),
      listedPrice: v.optional(v.number()),
    })
  ),
  financing: v.union(
    v.null(),
    v.object({ monthlyAmount: v.number(), termMonths: v.number(), downPaymentPercent: v.number() })
  ),
  conversation: v.array(
    v.object({ direction: v.union(v.literal("customer"), v.literal("dealership")), text: v.string() })
  ),
});

/** What `completeDraft` accepts. No prompt, no provider text, no error message. */
export const draftOutcomeValidator = v.union(
  v.object({
    status: v.literal("ready"),
    text: v.string(),
    handoverFallback: v.boolean(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }),
  v.object({
    status: v.literal("needs_person"),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }),
  v.object({ status: v.literal("failed"), failureReason: aiDraftFailureReasonValidator })
);

export const draftJobRefusalValidator = v.union(
  v.literal("not_pending"),
  v.literal("org_unavailable"),
  v.literal("not_enabled"),
  v.literal("no_conversation"),
  v.literal("key_missing")
);

/** The job is handed the sealed key; the plaintext only exists inside the action. */
export const draftJobValidator = v.union(
  v.object({ ok: v.literal(true), context: draftContextValidator, sealedKey: sealedProviderKeyValidator }),
  v.object({ ok: v.literal(false), reason: draftJobRefusalValidator })
);

/** What staff may read of a draft. No tokens, no model, no failure reason. */
export const draftViewValidator = v.union(
  v.null(),
  v.object({
    status: aiDraftStatusValidator,
    text: v.optional(v.string()),
    handoverFallback: v.optional(v.boolean()),
  })
);
