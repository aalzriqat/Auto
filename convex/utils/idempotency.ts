import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";
import { orgResetState } from "./orgResetGeneration";

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** English text of the SCRUM-563 refusal; `ServerError_COMMAND_RECORDED_BEFORE_RESET` carries the Arabic. */
export const COMMAND_RECORDED_BEFORE_RESET_MESSAGE =
  "This request was recorded before the organization's financial data was reset and can no longer be replayed. Start a new operation.";

/**
 * SCRUM-563 (protocol: `orgResetGeneration.ts`). Reads the org row on every
 * call, so callers invoke it only when they actually need the generation. A
 * missing org row reads as generation 0.
 */
async function currentResetGeneration(ctx: MutationCtx, orgId: Id<"organizations">): Promise<number> {
  return orgResetState(await ctx.db.get(orgId)).generation;
}

/** Refuses a stored command written under an older generation; absent means 0. */
async function assertReplayable(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  existing: { resetGeneration?: number }
): Promise<void> {
  if ((existing.resetGeneration ?? 0) !== (await currentResetGeneration(ctx, orgId))) {
    throwAppError(AppErrorCode.COMMAND_RECORDED_BEFORE_RESET, COMMAND_RECORDED_BEFORE_RESET_MESSAGE);
  }
}

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

/**
 * ─── SCRUM-57: an economic command must be identifiable ─────────────────────
 *
 * `economic` is REQUIRED and has no default. Adding a new `runWithIdempotency`
 * call site is therefore a forced classification decision rather than a silent
 * inheritance of whichever behaviour happened to be permissive — a compile
 * error where the old shape only had a convention.
 *
 * ECONOMIC means the command produces an at-most-once effect on money, the
 * general ledger, a subledger, or an obligation. For those, the identity and a
 * canonical fingerprint are both non-optional at the type level AND re-checked
 * at runtime, because a validator is not the last word: an untyped or future
 * client can still reach the mutation.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES *NOT* DO: derive the identity from the payload.
 * That was tried and it caused a real incident — see the note at
 * `components/vehicles/VehicleDetailsDialog.tsx`, where a key derived from
 * (deposit, resolution) made a SECOND genuine payout collide with the first's
 * stored command; the mutation returned without running, no money moved, and
 * the operator was told the customer had been refunded. Payload equality cannot
 * distinguish "this is a retry" from "this is a second, genuinely identical
 * intent". Only an identity minted once per INTENT can, so the identity is
 * minted at the intent boundary and this layer's job is to ENFORCE that one
 * exists — not to invent one.
 */
type IdempotencyArgsBase = {
  orgId: Id<"organizations">;
  operation: string;
  actorId?: Id<"users">;
  /**
   * Replaces the plain-string refusal of a replay whose fingerprint differs from
   * the stored one (e.g. to raise a coded, translatable refusal). It must throw;
   * it runs before anything is written. Omitted, the default refusal is raised
   * exactly as before.
   */
  onFingerprintConflict?: () => never;
};

type EconomicIdempotencyArgs = IdempotencyArgsBase & {
  economic: true;
  /** Minted once per user/business intent and preserved across every retry. */
  idempotencyKey: string;
  /**
   * Canonical fingerprint of the material economic inputs — at minimum amount,
   * counterparty, source and effective date. Replaying the same identity with a
   * materially different intent is rejected instead of silently returning the
   * prior result.
   */
  fingerprint: string;
};

type NonEconomicIdempotencyArgs = IdempotencyArgsBase & {
  economic: false;
  idempotencyKey?: string;
  fingerprint?: string;
};

export type RunWithIdempotencyArgs =
  | EconomicIdempotencyArgs
  | NonEconomicIdempotencyArgs;

export async function runWithIdempotency<T>(
  ctx: MutationCtx,
  args: RunWithIdempotencyArgs,
  run: () => Promise<T>
): Promise<T> {
  const idempotencyKey = normalizeIdempotencyKey(args.idempotencyKey);

  if (args.economic) {
    // The whole point of SCRUM-57. An economic effect this server cannot
    // identify is an economic effect it cannot deduplicate, so it refuses to
    // produce one. `run()` has not been called at this point and must not be.
    if (!idempotencyKey) {
      throw new ConvexError(
        "This financial command requires a command identity (idempotencyKey) and cannot be executed without one."
      );
    }
    if (!args.fingerprint || !args.fingerprint.trim()) {
      throw new ConvexError(
        "This financial command requires a canonical fingerprint of its economic inputs."
      );
    }
  } else if (!idempotencyKey) {
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
    if (args.economic) {
      // Fail CLOSED, including when the stored row carries no fingerprint at
      // all. The previous rule — `args.fingerprint && existing.fingerprint &&
      // …` — was an allowlist that failed open by omission: with either side
      // missing, a replay carrying a different amount was handed back the
      // earlier command's result as though it were its own. "Cannot tell
      // whether this is the same intent" must never take the permissive branch
      // on a money path.
      if (existing.fingerprint !== args.fingerprint) {
        if (args.onFingerprintConflict) args.onFingerprintConflict();
        throw new ConvexError(
          "Idempotency key reused with different request content. Use a new key for a different operation."
        );
      }
    } else if (
      args.fingerprint &&
      existing.fingerprint &&
      existing.fingerprint !== args.fingerprint
    ) {
      if (args.onFingerprintConflict) args.onFingerprintConflict();
      throw new ConvexError(
        "Idempotency key reused with different request content. Use a new key for a different operation."
      );
    }
    if (existing.status !== "COMPLETED") {
      throw new ConvexError("This command is already being processed. Please retry shortly.");
    }
    await assertReplayable(ctx, args.orgId, existing);
    return existing.result as T;
  }

  const now = Date.now();
  const recordId = await ctx.db.insert("commandIdempotency", {
    orgId: args.orgId,
    operation: args.operation,
    idempotencyKey,
    status: "STARTED",
    resetGeneration: await currentResetGeneration(ctx, args.orgId),
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
  await assertReplayable(ctx, args.orgId, existing);
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
    resetGeneration: await currentResetGeneration(ctx, args.orgId),
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
