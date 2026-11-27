import { v, type Infer } from "convex/values";
import { aiDraftFailureReasonValidator, aiDraftStatusValidator } from "../../schema/ai.schema";
import { draftMessageValidator } from "./draftContext";
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

/** One approved answer's sentence in one language, or null when it cannot be answered now. */
const sentenceValidator = v.union(v.null(), v.string());

const localeSentencesValidator = v.object({
  greeting: sentenceValidator,
  availability: sentenceValidator,
  vehicleInfo: sentenceValidator,
  price: sentenceValidator,
  financing: sentenceValidator,
  location: sentenceValidator,
});

/** The built-in Smart Reply sentence of every approved answer, in both languages. */
export const sentenceTableValidator = v.object({
  en: localeSentencesValidator,
  ar: localeSentencesValidator,
});
export type SentenceTable = Infer<typeof sentenceTableValidator>;

/**
 * The job is handed the sealed key, the sentence table and the conversation;
 * the plaintext key only exists inside the action. Nothing else of the
 * dealership is part of it.
 */
export const draftJobValidator = v.union(
  v.object({
    ok: v.literal(true),
    sentences: sentenceTableValidator,
    conversation: v.array(draftMessageValidator),
    sealedKey: sealedProviderKeyValidator,
  }),
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
