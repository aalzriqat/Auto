import { v, type Infer } from "convex/values";
import {
  aiDraftFailureReasonValidator,
  aiExpenseProposalStatusValidator,
  expenseProposalValidator,
} from "../../schema/ai.schema";
import { sealedProviderKeyValidator } from "./keyStore";

/** What `completeExpenseProposal` accepts. No prompt, no provider text, no error message. */
export const expenseOutcomeValidator = v.union(
  v.object({
    status: v.literal("ready"),
    proposal: expenseProposalValidator,
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }),
  v.object({ status: v.literal("not_expense"), model: v.string(), inputTokens: v.number(), outputTokens: v.number() }),
  v.object({ status: v.literal("not_understood"), model: v.string(), inputTokens: v.number(), outputTokens: v.number() }),
  v.object({ status: v.literal("failed"), failureReason: aiDraftFailureReasonValidator })
);
export type StoredExpenseOutcome = Infer<typeof expenseOutcomeValidator>;

export const expenseJobRefusalValidator = v.union(
  v.literal("not_pending"),
  v.literal("org_unavailable"),
  v.literal("not_enabled"),
  v.literal("key_missing")
);

/** The job is handed the message, the dealership's day and the sealed key. Nothing else. */
export const expenseJobValidator = v.union(
  v.object({ ok: v.literal(true), message: v.string(), today: v.string(), sealedKey: sealedProviderKeyValidator }),
  v.object({ ok: v.literal(false), reason: expenseJobRefusalValidator })
);

/** What the requester may read. No tokens, no model, no failure reason, no message. */
export const expenseProposalViewValidator = v.union(
  v.null(),
  v.object({ status: aiExpenseProposalStatusValidator, proposal: v.optional(expenseProposalValidator) })
);
