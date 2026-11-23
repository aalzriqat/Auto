import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { writeAuditLog as logAdminAction } from "../../utils/auditLog";
import { isSuperAdminUser } from "../../utils/tenancy";
import type { AiProvider } from "./keyCrypto";

/** Providers an admin can store a key for today. The table also allows "openai" for later. */
export const SUPPORTED_PROVIDERS = ["anthropic"] as const;

const API_KEY_MIN = 20;
const API_KEY_MAX = 300;
// Printable ASCII without space: provider keys never contain anything else.
const API_KEY_SHAPE = /^[\x21-\x7E]+$/;

/**
 * Trims and shape-checks a pasted key. The refusal text is fixed and never
 * echoes any part of the input, so it cannot leak the key into a toast or log.
 */
export function validateApiKeyShape(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < API_KEY_MIN || trimmed.length > API_KEY_MAX || !API_KEY_SHAPE.test(trimmed)) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "The API key format is not valid.");
  }
  return trimmed;
}

export function lastFour(apiKey: string): string {
  return apiKey.slice(-4);
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

/** Upserts the encrypted key and audits with last4 only. */
export async function storeEncryptedProviderKey(
  ctx: MutationCtx,
  input: {
    actorUserId: Doc<"users">["_id"];
    provider: AiProvider;
    ciphertext: string;
    iv: string;
    keyVersion: number;
    last4: string;
  }
): Promise<{ last4: string; setAt: number }> {
  const actor = await requireStillSuperAdmin(ctx, input.actorUserId);
  const existing = await findKey(ctx, input.provider);
  const setAt = Date.now();
  const fields = {
    provider: input.provider,
    ciphertext: input.ciphertext,
    iv: input.iv,
    keyVersion: input.keyVersion,
    last4: input.last4,
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
    before: existing ? { provider: input.provider, isSet: true, last4: existing.last4 } : { provider: input.provider, isSet: false },
    after: { provider: input.provider, isSet: true, last4: input.last4 },
  });
  return { last4: input.last4, setAt };
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
