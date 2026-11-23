import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { writeAuditLog as logAdminAction } from "../../utils/auditLog";
import { getValidatedEnv } from "../../utils/env";
import { isSuperAdminUser } from "../../utils/tenancy";
import { aiProviderValidator } from "../../schema/ai.schema";
import { encryptProviderKey, isEncryptionConfigured, type AiProvider } from "./keyCrypto";

/** Providers an admin can store a key for today. The table also allows "openai" for later. */
export const SUPPORTED_PROVIDERS = ["anthropic"] as const;

/** Opaque to callers: produced by sealProviderKey, consumed by storeSealedProviderKey. */
export const sealedProviderKeyValidator = v.object({
  provider: aiProviderValidator,
  ciphertext: v.string(),
  iv: v.string(),
  keyVersion: v.number(),
  last4: v.string(),
});
export type SealedProviderKey = Infer<typeof sealedProviderKeyValidator>;

const API_KEY_MIN = 20;
const API_KEY_MAX = 300;
// Printable ASCII without space: provider keys never contain anything else.
const API_KEY_SHAPE = /^[\x21-\x7E]+$/;

/**
 * Trims and shape-checks a pasted key. The refusal text is fixed and never
 * echoes any part of the input, so it cannot leak the key into a toast or log.
 */
function validateApiKeyShape(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < API_KEY_MIN || trimmed.length > API_KEY_MAX || !API_KEY_SHAPE.test(trimmed)) {
    throwAppError(AppErrorCode.AI_KEY_FORMAT_INVALID, "The API key format is not valid.");
  }
  return trimmed;
}

function lastFour(apiKey: string): string {
  return apiKey.slice(-4);
}

function isSupportedProvider(value: unknown): value is (typeof SUPPORTED_PROVIDERS)[number] {
  return SUPPORTED_PROVIDERS.some((provider) => provider === value);
}

/**
 * Parses the untrusted request by hand: a plain object with exactly the keys
 * `provider` and `apiKey`. The platform's own argument validation prints the
 * whole argument object, key included, so the action takes `v.any()` and the
 * refusal here is fixed text that carries no part of the request.
 */
function parseSealRequest(request: unknown): { provider: AiProvider; apiKey: string } {
  const refuse = (): never => throwAppError(AppErrorCode.AI_KEY_FORMAT_INVALID, "The API key format is not valid.");
  if (typeof request !== "object" || request === null || Array.isArray(request)) return refuse();
  const prototype: unknown = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return refuse();
  const keys = Object.keys(request);
  if (keys.length !== 2 || !keys.includes("provider") || !keys.includes("apiKey")) return refuse();
  const { provider, apiKey } = request as { provider?: unknown; apiKey?: unknown };
  if (!isSupportedProvider(provider) || typeof apiKey !== "string") return refuse();
  return { provider, apiKey };
}

/**
 * Action-side only: needs real randomness, and the plaintext must never be a
 * persisted function argument. Order: parse the request, trim and shape check, encryption
 * configured check, AES-256-GCM encryption, last four. Refusal texts are fixed
 * and never echo the input.
 */
export async function sealProviderKey(request: unknown): Promise<SealedProviderKey> {
  const args = parseSealRequest(request);
  const apiKey = validateApiKeyShape(args.apiKey);
  const masterKey = getValidatedEnv().AI_KEY_ENCRYPTION_KEY;
  if (!isEncryptionConfigured(masterKey)) {
    throwAppError(AppErrorCode.AI_KEY_ENCRYPTION_NOT_CONFIGURED, "AI key encryption is not configured on this deployment.");
  }
  let encrypted: Awaited<ReturnType<typeof encryptProviderKey>>;
  try {
    encrypted = await encryptProviderKey({ provider: args.provider, plaintext: apiKey, masterKey });
  } catch (error) {
    // Log the error class only: never the message, the key or its length.
    console.error("AI provider key encryption failed", error instanceof Error ? error.name : "unknown");
    throwAppError(AppErrorCode.AI_KEY_SAVE_FAILED, "The API key could not be saved. Please try again later.");
  }
  return {
    provider: args.provider,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    keyVersion: encrypted.keyVersion,
    last4: lastFour(apiKey),
  };
}

async function findKey(ctx: QueryCtx, provider: AiProvider): Promise<Doc<"aiProviderKeys"> | null> {
  return await ctx.db
    .query("aiProviderKeys")
    .withIndex("by_provider", (q) => q.eq("provider", provider))
    .unique();
}

export async function isProviderKeySet(ctx: QueryCtx, provider: AiProvider): Promise<boolean> {
  return (await findKey(ctx, provider)) !== null;
}

/** Client-safe projection: never ciphertext or IV. */
export async function readProviderStatuses(ctx: QueryCtx) {
  const statuses: { provider: AiProvider; isSet: boolean; last4?: string; setAt?: number }[] = [];
  for (const provider of SUPPORTED_PROVIDERS) {
    const row = await findKey(ctx, provider);
    statuses.push(row ? { provider, isSet: true, last4: row.last4, setAt: row.setAt } : { provider, isSet: false });
  }
  return statuses;
}

async function requireStillSuperAdmin(ctx: MutationCtx, actorUserId: Doc<"users">["_id"]): Promise<Doc<"users">> {
  const actor = await ctx.db.get(actorUserId);
  if (!actor || !isSuperAdminUser(actor)) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Super-admin access only.");
  }
  return actor;
}

/** Re-checks the actor is still a super admin, upserts by provider, audits with last4 only. */
export async function storeSealedProviderKey(
  ctx: MutationCtx,
  input: { actorUserId: Id<"users">; sealed: SealedProviderKey }
): Promise<{ last4: string; setAt: number }> {
  const actor = await requireStillSuperAdmin(ctx, input.actorUserId);
  const { sealed } = input;
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(sealed.provider)) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "This AI provider is not supported yet.");
  }
  const existing = await findKey(ctx, sealed.provider);
  const setAt = Date.now();
  const fields = {
    provider: sealed.provider,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    last4: sealed.last4,
    setAt,
    setBy: actor._id,
  };
  let rowId: Doc<"aiProviderKeys">["_id"];
  if (existing) {
    await ctx.db.replace(existing._id, fields);
    rowId = existing._id;
  } else {
    rowId = await ctx.db.insert("aiProviderKeys", fields);
  }
  await logAdminAction(ctx, actor, {
    action: existing ? "ai_provider_key.replace" : "ai_provider_key.set",
    targetTable: "aiProviderKeys",
    targetId: rowId,
    before: existing ? { provider: sealed.provider, isSet: true, last4: existing.last4 } : { provider: sealed.provider, isSet: false },
    after: { provider: sealed.provider, isSet: true, last4: sealed.last4 },
  });
  return { last4: sealed.last4, setAt };
}

export async function removeProviderKey(ctx: MutationCtx, actor: Doc<"users">, provider: AiProvider): Promise<void> {
  const existing = await findKey(ctx, provider);
  if (!existing) return;
  await ctx.db.delete(existing._id);
  await logAdminAction(ctx, actor, {
    action: "ai_provider_key.remove",
    targetTable: "aiProviderKeys",
    targetId: existing._id,
    before: { provider, isSet: true, last4: existing.last4 },
    after: { provider, isSet: false },
  });
}
