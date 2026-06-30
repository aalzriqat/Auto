import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function normalizeIdempotencyKey(idempotencyKey: string | undefined) {
  if (idempotencyKey === undefined) return undefined;
  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new ConvexError("Idempotency key cannot be empty.");
  }
  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ConvexError("Idempotency key is too long.");
  }
  return normalized;
}

export async function runWithIdempotency<T>(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    operation: string;
    idempotencyKey?: string;
    actorId?: Id<"users">;
    /**
     * Canonical fingerprint of the request inputs. When supplied, replaying the
     * same idempotency key with a materially different payload is rejected
     * rather than silently returning the prior result — critical for money
     * movement (payments, disbursements, cheques).
     */
    fingerprint?: string;
  },
  run: () => Promise<T>
): Promise<T> {
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  if (!idempotencyKey) {
    return await run();
  }

  if (!args.operation.trim()) {
    throw new ConvexError("Idempotent operation name is required.");
  }

  const existing = await ctx.db
    .query("commandIdempotency")
    .withIndex("by_org_operation_key", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("operation", args.operation)
        .eq("idempotencyKey", idempotencyKey)
    )
    .unique();

  if (existing) {
    // Reject key reuse with different inputs (only when both fingerprints exist).
    if (args.fingerprint && existing.fingerprint && existing.fingerprint !== args.fingerprint) {
      throw new ConvexError(
        "Idempotency key reused with different request content. Use a new key for a different operation."
      );
    }
    if (existing.status !== "COMPLETED") {
      throw new ConvexError("This command is already being processed. Please retry shortly.");
    }
    return existing.result as T;
  }

  const now = Date.now();
  const recordId = await ctx.db.insert("commandIdempotency", {
    orgId: args.orgId,
    operation: args.operation,
    idempotencyKey,
    status: "STARTED",
    fingerprint: args.fingerprint,
    createdBy: args.actorId,
    createdAt: now,
  });

  const result = await run();
  await ctx.db.patch(recordId, {
    status: "COMPLETED",
    result: result === undefined ? null : result,
    completedAt: Date.now(),
  });

  return result;
}

