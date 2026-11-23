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
 * - Figures and wording are fixed in code: no digit, link or handle, and none of
 *   the discount, negotiation, promise or amount-in-words terms of
 *   `DRAFT_FORBIDDEN_WORDING`, reaches a stored draft; a match replaces the model
 *   text with the handover sentence. Remaining limit: wording the list does not
 *   name. The staff member reads every draft before sending it.
 * - No code path sends a draft. A staff member edits and sends every reply.
 * - One provider call per pending row; a late job of a replaced or expired row
 *   calls nothing and writes nothing.
 * - The key plaintext exists only inside `runDraftJob` / `testProviderConnection`
 *   (both in this file; `openSealedKey` is the single place a stored key is opened).
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
import { testAnthropicConnection } from "./anthropicAdapter";
import type { DraftJob } from "./draftJob";
import { generateDraftOutcome } from "./draftRun";
import type { StoredDraftOutcome } from "./draftValidators";
import { decryptProviderKey, isEncryptionConfigured } from "./keyCrypto";
import type { SealedProviderKey } from "./keyStore";
import type { ConnectionTestResult, DraftProvider } from "./provider";

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
  // The sink is checked first: a sunk deployment never opens the stored key.
  if (sinkEgress("ai", "aiDrafts.generateDraft")) return { status: "failed", failureReason: "egress_sunk" };
  let apiKey: string;
  try {
    apiKey = await openSealedKey(args.job.sealedKey, args.masterKey ?? getValidatedEnv().AI_KEY_ENCRYPTION_KEY);
  } catch (error) {
    logErrorClass("AI draft key decryption failed", error);
    return { status: "failed", failureReason: "key_unavailable" };
  }
  try {
    return await generateDraftOutcome({ apiKey, context: args.job.context, provider: args.provider });
  } catch (error) {
    logErrorClass("AI draft run failed", error);
    return { status: "failed", failureReason: "provider_error" };
  }
}

/**
 * Orchestrates one scheduled job. `load` and `complete` are the two internal
 * calls. A failure of either is logged as a label and the error class only: a
 * validator failure message carries the whole object (conversation, sealed key,
 * draft text), so it must never be logged, stored or rethrown.
 */
export async function runGenerateDraft(args: {
  load: () => Promise<DraftJob>;
  complete: (outcome: StoredDraftOutcome) => Promise<unknown>;
}): Promise<void> {
  const complete = async (outcome: StoredDraftOutcome): Promise<void> => {
    try {
      await args.complete(outcome);
    } catch (error) {
      // The scheduled expiry ends the row.
      logErrorClass("AI draft completion failed", error);
    }
  };
  let job: DraftJob;
  try {
    job = await args.load();
  } catch (error) {
    logErrorClass("AI draft job load failed", error);
    await complete({ status: "failed", failureReason: "provider_error" });
    return;
  }
  if (!job.ok) {
    // Gone or already settled, or the dealership is unavailable: nothing to
    // write. Any other refusal ends the pending draft now.
    if (job.reason === "not_pending" || job.reason === "org_unavailable") return;
    await complete({ status: "failed", failureReason: "not_enabled" });
    return;
  }
  await complete(await runDraftJob({ job }));
}

function logErrorClass(label: string, error: unknown): void {
  console.error(label, error instanceof Error ? error.name : "unknown");
}

/** The super-admin connection test. Never throws; reports a fixed code. */
export async function testProviderConnection(args: {
  sealedKey: SealedProviderKey | null;
  masterKey?: string;
}): Promise<ConnectionTestResult> {
  if (!args.sealedKey) return { ok: false, code: "KEY_NOT_SET" };
  if (sinkEgress("ai", "aiAdmin.testProviderConnection")) return { ok: false, code: "EGRESS_SUNK" };
  const masterKey = args.masterKey ?? getValidatedEnv().AI_KEY_ENCRYPTION_KEY;
  if (!isEncryptionConfigured(masterKey)) return { ok: false, code: "ENCRYPTION_NOT_CONFIGURED" };
  let apiKey: string;
  try {
    apiKey = await openSealedKey(args.sealedKey, masterKey);
  } catch (error) {
    logErrorClass("AI key test decryption failed", error);
    return { ok: false, code: "ENCRYPTION_NOT_CONFIGURED" };
  }
  return await testAnthropicConnection({ apiKey });
}
