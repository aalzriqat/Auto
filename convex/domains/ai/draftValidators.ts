import { v, type Infer } from "convex/values";
import { aiDraftFailureReasonValidator, aiDraftStatusValidator } from "../../schema/ai.schema";
import { draftContextValidator } from "./draftContext";
import { sealedProviderKeyValidator } from "./keyStore";

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

export type StoredDraftOutcome = Infer<typeof draftOutcomeValidator>;

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
