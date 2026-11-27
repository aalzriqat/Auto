import Anthropic from "@anthropic-ai/sdk";
import { parseModelOutput } from "./draftAnswers";
import { DRAFT_OUTPUT_SCHEMA } from "./draftPrompt";
import type {
  ConnectionTestResult,
  DraftProvider,
  DraftProviderFailureReason,
  DraftProviderResult,
} from "./provider";

export const ANTHROPIC_DRAFT_MODEL = "claude-opus-5-5";

const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 40_000;

/**
 * A fresh client per call. The endpoint, both credential options, the log
 * level and OpenTelemetry tracing are set explicitly, so the SDK reads no
 * environment variable for them: not ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_LOG nor ANTHROPIC_OPEN_TELEMETRY*. What stays
 * environment-controlled (SDK 1.12.0, client.js): ANTHROPIC_CUSTOM_HEADERS,
 * extra request headers a deployment administrator can set; there is no client
 * option that turns it off, and it cannot change the endpoint or the key.
 * The key lives only in this scope.
 */
function createClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: "https://api.anthropic.com",
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
    logLevel: "off",
    openTelemetry: false,
  });
}

interface FailureClass {
  reason: DraftProviderFailureReason;
  /** Fixed label, so a minifier cannot change what is logged. */
  label: string;
  status: number | null;
}

function classifyError(error: unknown): FailureClass {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { reason: "provider_auth", label: error instanceof Anthropic.AuthenticationError ? "AuthenticationError" : "PermissionDeniedError", status: error.status };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { reason: "provider_rate_limited", label: "RateLimitError", status: error.status };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { reason: "timeout", label: "APIConnectionTimeoutError", status: null };
  }
  if (error instanceof Anthropic.APIError) {
    return { reason: "provider_error", label: "APIError", status: error.status ?? null };
  }
  return { reason: "provider_error", label: "UnknownError", status: null };
}

/** Class label and HTTP status only. Never the error object, headers, request or key. */
function logFailure(failure: FailureClass): void {
  console.error("[aiDraft] provider failure", failure.label, failure.status ?? "none");
}

function firstText(message: Anthropic.Message): string | null {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

export const anthropicDraftProvider: DraftProvider = async ({ apiKey, system, user }) => {
  let message: Anthropic.Message;
  try {
    message = await createClient(apiKey).messages.create({
      model: ANTHROPIC_DRAFT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: DRAFT_OUTPUT_SCHEMA },
      },
    });
  } catch (error) {
    const failure = classifyError(error);
    logFailure(failure);
    return { ok: false, reason: failure.reason };
  }

  if (message.stop_reason === "refusal") return { ok: false, reason: "refusal" };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "truncated" };

  const text = firstText(message);
  const output = text === null ? null : parseModelOutput(text);
  if (!output) return { ok: false, reason: "invalid_output" };

  const result: DraftProviderResult = {
    ok: true,
    output,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
  return result;
};

/** Admin "test connection": can this key read the draft model? */
export async function testAnthropicConnection(args: { apiKey: string }): Promise<ConnectionTestResult> {
  try {
    await createClient(args.apiKey).models.retrieve(ANTHROPIC_DRAFT_MODEL);
    return { ok: true };
  } catch (error) {
    const failure = classifyError(error);
    logFailure(failure);
    if (failure.reason === "provider_auth") return { ok: false, code: "AUTH_FAILED" };
    if (failure.status === 404) return { ok: false, code: "MODEL_UNAVAILABLE" };
    return { ok: false, code: "PROVIDER_UNREACHABLE" };
  }
}
