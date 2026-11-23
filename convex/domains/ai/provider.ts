import { v, type Infer } from "convex/values";
import type { aiDraftFailureReasonValidator } from "../../schema/ai.schema";
import type { DraftModelOutput } from "./draftAnswers";

/** Fixed reasons stored on a failed draft. Never an error message. */
export type DraftFailureReason = Infer<typeof aiDraftFailureReasonValidator>;

/** The reasons a provider call itself can end in. */
export type DraftProviderFailureReason = Extract<
  DraftFailureReason,
  | "timeout"
  | "provider_error"
  | "provider_auth"
  | "provider_rate_limited"
  | "refusal"
  | "truncated"
  | "invalid_output"
>;

export interface DraftProviderRequest {
  /** Plaintext key, held for this call only. Never stored, never logged. */
  apiKey: string;
  system: string;
  user: string;
}

export type DraftProviderResult =
  | { ok: true; output: DraftModelOutput; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; reason: DraftProviderFailureReason };

/** The seam: one function in, one discriminated result out. It never throws. */
export type DraftProvider = (request: DraftProviderRequest) => Promise<DraftProviderResult>;

/** Result of the admin "test connection" action: ok, or one fixed code. */
export const connectionTestResultValidator = v.union(
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
export type ConnectionTestResult = Infer<typeof connectionTestResultValidator>;
