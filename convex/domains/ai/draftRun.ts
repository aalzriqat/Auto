import { availableAnswers, chooseLocale, decideDraft } from "./draftAnswers";
import type { DraftMessage } from "./draftContext";
import { buildDraftUserMessage, DRAFT_SYSTEM_PROMPT } from "./draftPrompt";
import { anthropicDraftProvider } from "./anthropicAdapter";
import type { SentenceTable, StoredDraftOutcome } from "./draftValidators";
import type { DraftProvider } from "./provider";

/**
 * One provider call for one draft: send the conversation and the names of the
 * answers that exist, then build the stored outcome from the answers the model
 * chose. The plaintext key is an argument and goes no further than the provider.
 */
export async function generateDraftOutcome(args: {
  apiKey: string;
  sentences: SentenceTable;
  conversation: readonly DraftMessage[];
  provider?: DraftProvider;
}): Promise<StoredDraftOutcome> {
  const provider = args.provider ?? anthropicDraftProvider;
  const available = availableAnswers(args.sentences, chooseLocale(args.conversation));
  const result = await provider({
    apiKey: args.apiKey,
    system: DRAFT_SYSTEM_PROMPT,
    user: buildDraftUserMessage(args.conversation, available),
  });
  if (!result.ok) return { status: "failed", failureReason: result.reason };

  const usage = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  const decision = decideDraft(result.output, args.sentences, args.conversation);
  if (decision.status === "needs_person") return { status: "needs_person", ...usage };
  return { status: "ready", text: decision.text, handoverFallback: decision.handoverFallback, ...usage };
}
