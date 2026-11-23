import type { Infer } from "convex/values";
import type { aiDraftFailureReasonValidator } from "../../schema/ai.schema";
import type { DraftModelOutput } from "./draftOutput";

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

/** Codes of the admin "test connection" action. */
export type ConnectionTestCode =
  | "AUTH_FAILED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_UNREACHABLE"
  | "KEY_NOT_SET"
  | "ENCRYPTION_NOT_CONFIGURED"
  | "EGRESS_SUNK";

export type ConnectionTestResult = { ok: true } | { ok: false; code: ConnectionTestCode };
