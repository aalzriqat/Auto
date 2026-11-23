import type { DraftContext } from "./draftContext";
import { decideDraft } from "./draftOutput";
import { buildDraftUserMessage, DRAFT_SYSTEM_PROMPT } from "./draftPrompt";
import { anthropicDraftProvider } from "./anthropicAdapter";
import type { DraftProvider, DraftProviderFailureReason } from "./provider";

/** What `completeDraft` stores. No prompt, no provider text, no error message. */
export type DraftOutcome =
  | {
      status: "ready";
      text: string;
      handoverFallback: boolean;
      model: string;
      inputTokens: number;
      outputTokens: number;
    }
  | { status: "needs_person"; model: string; inputTokens: number; outputTokens: number }
  | { status: "failed"; failureReason: DraftProviderFailureReason };

/**
 * One provider call for one draft: build the prompt from the projected
 * context, call the provider, and turn the answer into the stored outcome.
 * The plaintext key is an argument and goes no further than the provider.
 */
export async function generateDraftOutcome(args: {
  apiKey: string;
  context: DraftContext;
  provider?: DraftProvider;
}): Promise<DraftOutcome> {
  const provider = args.provider ?? anthropicDraftProvider;
  const result = await provider({
    apiKey: args.apiKey,
    system: DRAFT_SYSTEM_PROMPT,
    user: buildDraftUserMessage(args.context),
  });
  if (!result.ok) return { status: "failed", failureReason: result.reason };

  const usage = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  const decision = decideDraft(result.output, args.context);
  if (decision.status === "needs_person") return { status: "needs_person", ...usage };
  return { status: "ready", text: decision.text, handoverFallback: decision.handoverFallback, ...usage };
}
