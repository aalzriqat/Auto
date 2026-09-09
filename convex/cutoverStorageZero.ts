import { v } from "convex/values";
// `internalMutation` comes from `./functions`, not `./_generated/server`, so
// aggregate triggers still fire — the same import the sibling destructive
// modules `orgFinancialReset.ts` and `adminOrgs.ts` use. Nothing here writes a
// domain row, so no trigger has anything to react to today; the rule is
// followed anyway because "my case does not need it" is exactly the reasoning
// the restriction exists to stop.
import { internalMutation } from "./functions";
import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * SCRUM-306 — deployment-wide `_storage` zero for the one-time clean-slate
 * Accounting launch (SCRUM-231).
 *
 * ## Why this module exists
 *
 * `_storage` carries no `orgId`. Its rows are `{ _id, _creationTime, sha256,
 * size, contentType? }` and nothing else, so a blob cannot be attributed to a
 * tenant by reading the system table, and once the last domain row referencing
 * it is deleted the blob is unreachable from every other code path in this
 * repository. SCRUM-231 could therefore prove database-row zero while every
 * file the deployment ever stored survived — which is exactly the data the
 * cutover exists to destroy.
 *
 * ## The shape this module deliberately does NOT have
 *
 * Under the owner ruling of 2026-09-09, all current production data is
 * disposable test/demo data and the launch cutover empties `_storage`
 * **deployment-wide**. That ruling removes the hard problem rather than
 * solving it: with no tenant to attribute a blob to, this module never needs —
 * and never has — a storage ownership ledger, a historical backfill, per-org
 * blob inference, field-name matching, `v.any()` value inspection, or a
 * storage allowlist.
 *
 * This matters beyond simplicity. SCRUM-231's containment guard derived
 * storage field names from validator shapes and then applied them by matching
 * key names on a row, and was wrong in both directions: blind to a blob
 * referenced from an opaque `v.any()` payload, and falsely tripped by an
 * ordinary string under a key named `fileId`. **Neither blind side is
 * reachable here.** Nothing in this module reads a domain row, a field name or
 * a field value. The `_storage` system table is the sole authority on what a
 * stored file is, so unrelated schema field names and opaque payload contents
 * cannot influence the result by construction.
 *
 * ## Generality boundary — read before reusing this
 *
 * This is launch-specific clean-slate machinery. It empties the WHOLE
 * deployment's file storage and is safe only because every current file is
 * disposable. It is **not** a per-tenant deletion mechanism and must never be
 * used for GDPR erasure, a single-org purge, or any post-launch deletion where
 * one tenant's files must survive another's removal. That problem still needs
 * per-blob ownership, which this deployment does not record.
 *
 * ## Ordering contract — storage LAST
 *
 * The cutover runs: hold writes → drive domain/command/accounting state to
 * zero → prove database zero → THEN empty `_storage` → prove storage zero.
 *
 * Storage goes last because deleting blobs first can leave still-live domain
 * rows pointing at missing files if an earlier phase aborts, whereas after the
 * rows are gone `_storage` remains independently enumerable and can be emptied
 * directly. This module does **not** enforce that ordering itself: the
 * domain-zero predicate belongs to SCRUM-231's cutover module, which is not on
 * `main` and which this lane is barred from editing. `deleteStoredFilesBatch`
 * is exported as a plain helper precisely so SCRUM-231 can call it inside its
 * own transaction, after its own domain-zero assertion, and get the ordering
 * enforced where the predicate actually lives.
 *
 * ## Safety boundary
 *
 * Internal-only: no client-facing action, no public query or mutation. The
 * destructive entry point additionally requires an exact confirmation literal,
 * so it cannot be invoked by accident or by an argument-shape mistake. Nothing
 * here is authorized to run against production; the existence of this code
 * authorizes no deployment, workflow or reset.
 */

/**
 * The hard ceiling on files deleted per invocation.
 *
 * A Convex mutation is one transaction with bounded reads and writes. The bound
 * here is STRUCTURAL, not a convention: `deleteStoredFilesBatch` reads at most
 * `budget` rows and performs at most `budget` deletes, whatever the size of the
 * population, so no invocation grows with the deployment. That property must
 * not depend on `convex-test` tolerating a large operation — the harness does
 * not enforce Convex's transaction limits, so a design that only stays inside
 * them "in practice" would pass the suite and fail in production.
 *
 * There is exactly ONE table here — `_storage`, deployment-wide — so the budget
 * is global by construction. A per-category budget, the defect that a
 * multi-table reset can have (spending the whole budget on each of N tables),
 * has no way to arise in this module.
 */
export const MAX_STORAGE_DELETE_BUDGET = 256;

/** Budget used when a caller does not name one. */
export const DEFAULT_STORAGE_DELETE_BUDGET = 128;

/** Ceiling on rows a single census invocation may read. */
export const MAX_STORAGE_CENSUS_CAP = 4096;

/** Census cap used when a caller does not name one. */
export const DEFAULT_STORAGE_CENSUS_CAP = 1024;

/**
 * The exact string the destructive mutation requires.
 *
 * Declared as a `v.literal` argument so the destructive form is not the
 * default and cannot be reached by omitting or mistyping an argument.
 */
export const PURGE_ALL_STORED_FILES_CONFIRMATION =
  "DELETE ALL STORED FILES IN THIS DEPLOYMENT" as const;

/**
 * Refuses an unusable budget BEFORE any destructive work.
 *
 * `v.number()` accepts `NaN` and `Infinity`, so the argument validator is not
 * the guard — `NaN` would make every comparison below false and slip through a
 * naive range check. This throws rather than clamping: a caller that asked for
 * an impossible budget has a bug, and silently substituting a different one
 * would delete a different number of files than the operator believed.
 *
 * It throws UNCAUGHT on purpose. In Convex a caught exception still commits,
 * so a refusal that is caught and reported would be a refusal wearing a
 * partially completed deletion.
 */
function assertUsableBudget(budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_STORAGE_DELETE_BUDGET) {
    throw new Error(
      `Storage delete budget must be an integer between 1 and ${MAX_STORAGE_DELETE_BUDGET}; ` +
        `received ${String(budget)}. The bound is what keeps one invocation inside a single ` +
        `Convex transaction regardless of how many files the deployment holds.`,
    );
  }
}

/** Same discipline for the read-only census cap. */
function assertUsableCensusCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_STORAGE_CENSUS_CAP) {
    throw new Error(
      `Storage census cap must be an integer between 1 and ${MAX_STORAGE_CENSUS_CAP}; ` +
        `received ${String(cap)}.`,
    );
  }
}

export type StorageZeroState = {
  /** True only when enumeration returned no rows at all. */
  zero: boolean;
  /** Up to two surviving ids, so a failure names evidence instead of a count. */
  survivors: Id<"_storage">[];
};

/**
 * The independent zero-state verifier.
 *
 * Establishes zero by ENUMERATION, never by trusting what the destructive
 * mutation returned. One surviving row disproves zero, so this reads at most
 * two — enough to name evidence, and O(1) whatever the population size, which
 * means the proof itself can never be the thing that exceeds a transaction
 * limit.
 *
 * ⚠️ There is deliberately NO try/catch. If `_storage` cannot be enumerated the
 * exception propagates and the caller gets a failure, never `zero: true`. A
 * catch here would convert "I could not look" into "there is nothing there",
 * which is the precise failure this verifier exists to prevent.
 */
export async function storageZeroState(
  ctx: QueryCtx | MutationCtx,
): Promise<StorageZeroState> {
  const survivors = await ctx.db.system.query("_storage").take(2);
  return {
    zero: survivors.length === 0,
    survivors: survivors.map((row) => row._id),
  };
}

export type StorageCensus = {
  /** Files counted. When `complete` is false this is the cap, i.e. "at least". */
  counted: number;
  /** False when the population exceeds `cap` and the count is a lower bound. */
  complete: boolean;
  cap: number;
  /** Total bytes, or null when the count is only a lower bound. */
  totalBytes: number | null;
};

/**
 * Bounded read-only inventory.
 *
 * Reads `cap + 1` rows so it can tell "exactly cap files" from "more than cap"
 * without reading the whole table. When the population exceeds the cap it
 * reports `complete: false` and `counted` is a LOWER BOUND, never a total —
 * the one thing this must not do is present a truncated read as a census.
 *
 * As with the verifier, an enumeration failure propagates rather than being
 * reported as an empty deployment.
 */
export async function storageCensus(
  ctx: QueryCtx | MutationCtx,
  cap: number = DEFAULT_STORAGE_CENSUS_CAP,
): Promise<StorageCensus> {
  assertUsableCensusCap(cap);
  const rows = await ctx.db.system.query("_storage").take(cap + 1);
  const complete = rows.length <= cap;
  return {
    counted: complete ? rows.length : cap,
    complete,
    cap,
    totalBytes: complete ? rows.reduce((sum, row) => sum + row.size, 0) : null,
  };
}

export type StorageDeleteBatchResult = {
  deleted: number;
  deletedIds: Id<"_storage">[];
  budget: number;
  /**
   * The table held fewer rows than the budget when this transaction READ it.
   *
   * ⚠️ This is NOT a proof of zero and must never be reported as one. It is a
   * statement about one transaction's read, and a file stored after that read
   * would not be reflected in it. Zero is established only by
   * `storageZeroState` / `verifyStorageZeroState`, which enumerate again.
   */
  exhaustedAtReadTime: boolean;
};

/**
 * Deletes at most `budget` stored files, oldest first.
 *
 * ## Why there is no cursor
 *
 * A cursor into a table you are deleting from is the classic way to skip rows
 * or to resume somewhere that falsely looks like the end. This deletes the
 * OLDEST rows and takes them fresh from the start of the table every
 * invocation, so the next call always sees whatever actually survived. That
 * makes the awkward cases non-events rather than handled cases: there is no
 * cursor to lose, no boundary to resume at incorrectly, and restarting from
 * the beginning is not merely safe, it is the only mode this has. Repeated
 * invocation converges monotonically because every call that deletes anything
 * strictly shrinks the population.
 *
 * ## Already-missing files
 *
 * Every id passed to `ctx.storage.delete` was read from `_storage` inside THIS
 * transaction, so it provably existed when it was read and the transaction is
 * serializable. A file deleted out of band earlier simply never appears in the
 * read, so it cannot be deleted twice and cannot block completion. This is
 * deliberate: `convex-test` throws "Delete on non-existent doc" for a missing
 * id, and rather than depend on production matching that behaviour, the design
 * never reaches the case. Callers must not pass caller-supplied ids here — the
 * function does not accept any.
 *
 * Exported as a plain helper so SCRUM-231 can call it INSIDE its own cutover
 * transaction, after its own domain-zero assertion, which is where the
 * storage-last ordering can actually be enforced.
 */
export async function deleteStoredFilesBatch(
  ctx: MutationCtx,
  budget: number = DEFAULT_STORAGE_DELETE_BUDGET,
): Promise<StorageDeleteBatchResult> {
  // First statement, before any read or write: an unusable budget must refuse
  // rather than partially delete.
  assertUsableBudget(budget);

  const batch = await ctx.db.system.query("_storage").take(budget);

  const deletedIds: Id<"_storage">[] = [];
  for (const row of batch) {
    await ctx.storage.delete(row._id);
    deletedIds.push(row._id);
  }

  return {
    deleted: deletedIds.length,
    deletedIds,
    budget,
    exhaustedAtReadTime: batch.length < budget,
  };
}

/**
 * A — read-only inventory / dry run.
 *
 * A Convex QUERY cannot write and its `ctx.storage` is a reader with no
 * `delete`, so "this dry run cannot delete anything" is enforced by the
 * platform rather than by a flag this module checks. That is why the inventory
 * is a separate function instead of a `dryRun: true` argument on the
 * destructive one.
 */
export const inventoryStoredFiles = internalQuery({
  args: { cap: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await storageCensus(ctx, args.cap ?? DEFAULT_STORAGE_CENSUS_CAP);
  },
});

/**
 * C — the independent zero-state verifier, exposed for the cutover proof.
 *
 * Read this INSTEAD of the purge mutation's return value. The purge reports
 * what one transaction did; only this reports what is actually left.
 */
export const verifyStorageZeroState = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await storageZeroState(ctx);
  },
});

/**
 * B — the bounded destructive batch, as a standalone operator entry point.
 *
 * Requires the exact confirmation literal, is internal-only, and deletes at
 * most `MAX_STORAGE_DELETE_BUDGET` files per call. Call it repeatedly until
 * `verifyStorageZeroState` reports zero — and rely on that verifier, not on
 * this mutation's `exhaustedAtReadTime`, for the completion claim.
 *
 * 🛑 Running this against production destroys every stored file in the
 * deployment. It is authorized only inside a separately approved SCRUM-231
 * cutover window.
 */
export const purgeAllStoredFiles = internalMutation({
  args: {
    confirm: v.literal(PURGE_ALL_STORED_FILES_CONFIRMATION),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await deleteStoredFilesBatch(
      ctx,
      args.budget ?? DEFAULT_STORAGE_DELETE_BUDGET,
    );
  },
});
