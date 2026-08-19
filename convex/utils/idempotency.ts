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
/**
 * ─── Per-unit evidence inside one larger operation ──────────────────────────
 *
 * `runWithIdempotency` above wraps a WHOLE command and replays its stored
 * result. A bulk import needs something narrower: one durable record per
 * spreadsheet ROW, so that re-sending a file proves, row by row, which rows were
 * already executed — rather than inferring it from what the database happens to
 * contain.
 *
 * Why inference is not good enough on this path: two genuinely different cars
 * can be identical in every recorded fact (same model, same price, same day,
 * VIN column filled in with the same filler text). Fact equality therefore
 * cannot distinguish "this operation ran before" from "somebody bought a second
 * identical car", and guessing wrong silently drops a purchased vehicle and its
 * capitalization. Only durable evidence of the OPERATION can answer it.
 *
 * These share `commandIdempotency` and the fingerprint-conflict rule above, so
 * there is one definition of "same key, different content" in the codebase.
 *
 * ⚠️ ATOMICITY IS THE CALLER'S RESPONSIBILITY AND IS NOT OPTIONAL.
 * `recordCommandUnit` must be called in the SAME mutation as the effects it
 * attests to. Convex rolls a mutation back entirely on any throw, so evidence
 * written inline cannot outlive the work it describes. Writing it from a
 * separate mutation, an action or the scheduler would create the inverse defect:
 * evidence survives, the posting does not, and every retry is then suppressed by
 * proof of something that never happened.
 */

/** The stored unit, or null when this unit has never run. Throws on conflict. */
export async function findCommandUnit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    operation: string;
    idempotencyKey: string;
    /** Canonical hash of this unit's inputs. Required for money-moving units. */
    fingerprint: string;
    /** Included verbatim in the conflict message so the operator can find the row. */
    label?: string;
  }
): Promise<{ result: unknown } | null> {
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  if (!idempotencyKey) return null;

  const existing = await ctx.db
    .query("commandIdempotency")
    .withIndex("by_org_operation_key", (q) =>
      q.eq("orgId", args.orgId).eq("operation", args.operation).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (!existing) return null;

  // Same key, different content. NEVER a retry — the caller is re-using an
  // identifier for a materially different request, and returning the earlier
  // outcome would silently discard the new one.
  if (existing.fingerprint !== args.fingerprint) {
    throw new ConvexError(
      `IDEMPOTENCY_CONFLICT: ${args.label ?? idempotencyKey} was already submitted with different details. Nothing was imported. Use a new import for changed rows, or correct them back to what was submitted.`
    );
  }
  // A STARTED row cannot outlive its own transaction (Convex atomicity), so
  // anything found here that is not COMPLETED is inconsistent state, and
  // "cannot tell" must not take the permissive branch on a money path.
  if (existing.status !== "COMPLETED") {
    throw new ConvexError(
      `${args.label ?? idempotencyKey} is recorded as still in progress. Nothing was imported. Retry shortly.`
    );
  }
  return { result: existing.result };
}

/** Durable proof that this unit ran. MUST share the transaction with its effects. */
export async function recordCommandUnit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    operation: string;
    idempotencyKey: string;
    fingerprint: string;
    result?: unknown;
    actorId?: Id<"users">;
  }
): Promise<void> {
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);
  if (!idempotencyKey) return;
  await ctx.db.insert("commandIdempotency", {
    orgId: args.orgId,
    operation: args.operation,
    idempotencyKey,
    // Written COMPLETED in one insert rather than STARTED-then-patched: the
    // effects it attests to are committed by the same transaction, so there is
    // no window in which a half-state could be observed.
    status: "COMPLETED",
    result: args.result === undefined ? null : args.result,
    fingerprint: args.fingerprint,
    createdBy: args.actorId,
    createdAt: Date.now(),
    completedAt: Date.now(),
  });
}
