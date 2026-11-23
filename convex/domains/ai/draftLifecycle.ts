/**
 * AI reply drafts: the one module the doors call.
 *
 * Invariants
 * - Tenancy: every read and write is scoped by organization; a draft of another
 *   dealership reads as not found and cannot be linked to a send.
 * - Gate: platform switch, dealership switch and a stored key are checked at the
 *   request and again at the job; a refusal at the job makes no provider call.
 * - Private messages only: a draft needs a direct-message event of the customer
 *   on that platform; comments are never part of the context.
 * - Allowlist: the provider sees only fields copied one by one into the context.
 * - No code path sends a draft. A staff member edits and sends every reply.
 * - One provider call per pending row; a late job of a replaced or expired row
 *   calls nothing and writes nothing.
 * - The key plaintext exists only inside `runDraftJob` / `testProviderConnection`.
 *
 * Error modes
 * - Typed refusals (AppErrorCode): AI_DRAFT_NOT_ENABLED, AI_DRAFT_NO_CONVERSATION,
 *   AI_DRAFT_RATE_LIMITED, AI_DRAFT_NOT_FOUND, CUSTOMER_NOT_FOUND, plus the tenant
 *   and plan refusals of the access rule.
 * - Fixed failure reasons stored on a failed row: timeout, provider_error,
 *   provider_auth, provider_rate_limited, refusal, truncated, invalid_output,
 *   key_unavailable, egress_sunk, not_enabled. Never an error message.
 *
 * Ordering
 * - request, then job; complete only while the row is pending; link only after
 *   the message was posted successfully.
 *
 * Configuration
 * - AI_KEY_ENCRYPTION_KEY, the platform switch, the dealership switch and a
 *   stored Anthropic key.
 *
 * Performance
 * - Every read is indexed and bounded: the newest 5 drafts of a customer for the
 *   pending check; at most 300 events scanned (40 direct messages kept) newest
 *   first; at most 12 Messenger rows; one vehicle, one settings row, one finance
 *   company, one key row.
 * - At most 12 conversation messages of 1,500 characters each.
 * - One provider call, 40 s timeout, one retry; max_tokens 8192 because thinking
 *   tokens count toward it. A pending row expires after 120 s.
 */
import { getValidatedEnv } from "../../utils/env";
import { sinkEgress } from "../../utils/egressSink";
import { ANTHROPIC_DRAFT_MODEL, testAnthropicConnection } from "./anthropicAdapter";
import type { DraftJob } from "./draftJob";
import type { StoredDraftOutcome } from "./draftRequest";
import { generateDraftOutcome } from "./draftRun";
import { decryptProviderKey, isEncryptionConfigured } from "./keyCrypto";
import type { SealedProviderKey } from "./keyStore";
import type { ConnectionTestResult, DraftProvider } from "./provider";

export { DRAFT_EXPIRY_MS, completePendingDraft, expirePendingDraft, readDraftForStaff, requestDraftForStaff } from "./draftRequest";
export type { DraftView, StoredDraftOutcome } from "./draftRequest";
export { loadDraftJobData } from "./draftJob";
export type { DraftJob } from "./draftJob";
export { dmSendArgs, linkReplyDraft, requireSendAccess } from "./draftSendLink";
export { ANTHROPIC_DRAFT_MODEL };

/** The single place a stored key is opened. */
async function openSealedKey(sealed: SealedProviderKey, masterKey: string | undefined): Promise<string> {
  return await decryptProviderKey({
    provider: sealed.provider,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    masterKey,
  });
}

/**
 * Opens the sealed key, makes the one provider call and returns the outcome to
 * store. Never throws. `provider` is for tests that are not about the wire.
 */
export async function runDraftJob(args: {
  job: Extract<DraftJob, { ok: true }>;
  masterKey?: string;
  provider?: DraftProvider;
}): Promise<StoredDraftOutcome> {
  let apiKey: string;
  try {
    apiKey = await openSealedKey(args.job.sealedKey, args.masterKey ?? getValidatedEnv().AI_KEY_ENCRYPTION_KEY);
  } catch (error) {
    console.error("AI draft key decryption failed", error instanceof Error ? error.name : "unknown");
    return { status: "failed", failureReason: "key_unavailable" };
  }
  if (sinkEgress("ai", "aiDrafts.generateDraft")) return { status: "failed", failureReason: "egress_sunk" };
  try {
    return await generateDraftOutcome({ apiKey, context: args.job.context, provider: args.provider });
  } catch (error) {
    console.error("AI draft run failed", error instanceof Error ? error.name : "unknown");
    return { status: "failed", failureReason: "provider_error" };
  }
}

/** The super-admin connection test. Never throws; reports a fixed code. */
export async function testProviderConnection(args: {
  sealedKey: SealedProviderKey | null;
  masterKey?: string;
}): Promise<ConnectionTestResult> {
  if (!args.sealedKey) return { ok: false, code: "KEY_NOT_SET" };
  const masterKey = args.masterKey ?? getValidatedEnv().AI_KEY_ENCRYPTION_KEY;
  if (!isEncryptionConfigured(masterKey)) return { ok: false, code: "ENCRYPTION_NOT_CONFIGURED" };
  let apiKey: string;
  try {
    apiKey = await openSealedKey(args.sealedKey, masterKey);
  } catch (error) {
    console.error("AI key test decryption failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "ENCRYPTION_NOT_CONFIGURED" };
  }
  if (sinkEgress("ai", "aiAdmin.testProviderConnection")) return { ok: false, code: "EGRESS_SUNK" };
  return await testAnthropicConnection({ apiKey });
}
