// Keep the organization lifecycle leaf first. SCRUM-302 exposed an
// uninitialized lifecycle import when the outbox was re-entered during module loading.
import { assertOrgEconomicallyActive } from "../utils/orgLifecycle";
import type { OpeningSettlementReader } from "../utils/openingSettlementBasis";
import { assertOpeningPostingProof } from "../utils/openingPostingProof";
import { type MutationCtx } from "../_generated/server";
import { type Id } from "../_generated/dataModel";
import { type PostCommand } from "./postingEngine";
import { isPostedReversalOf, reversalKeyConflict } from "./reversals";

// ─── Enqueue helpers (called from workflow hooks) ─────────────────────────────

/**
 * ⚠️ SCRUM-302 — a queue is not a safe place to park money for a blocked
 * organization. Enqueueing is refused rather than deferred: a pending row for a
 * suspended org would post the moment the org returned to service, turning a
 * refusal into a delayed detonation, and for an org under destructive purge it
 * would wait for a reactivation SCRUM-297 forbids outright.
 *
 * `drainEntries` carries the matching classification for rows that were already
 * PENDING when the organization's lifecycle changed underneath them.
 */
export async function enqueuePendingPost(
  ctx: MutationCtx,
  cmd: PostCommand,
  reason: string,
  openingReader?:OpeningSettlementReader,
): Promise<void> {
  await assertOpeningPostingProof(ctx,cmd,openingReader);
  await assertOrgEconomicallyActive(ctx, cmd.orgId);

  // Dedupe by idempotency key — never queue the same logical event twice.
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .unique();
  if (existing) return;

  await ctx.db.insert("pendingAccountingEvents", {
    orgId: cmd.orgId,
    kind: "POST",
    status: "PENDING",
    idempotencyKey: cmd.idempotencyKey,
    accountingDate: cmd.accountingDate,
    actorId: cmd.actorId,
    branchId: cmd.branchId,
    reason,
    attempts: 0,
    createdAt: Date.now(),
    eventType: cmd.eventType,
    sourceType: cmd.sourceType,
    sourceId: cmd.sourceId,
    eventVersion: cmd.eventVersion,
    occurredAt: cmd.occurredAt,
    currency: cmd.currency,
    payload: cmd.payload,
  });
}

export async function enqueuePendingReversal(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    originalEventId: Id<"accountingEvents">;
    reversalDate: number;
    reason: string;
    actorId: Id<"users">;
    idempotencyKey: string;
    sourceType: string;
    sourceId: string;
  }
): Promise<void> {
  await assertOrgEconomicallyActive(ctx, args.orgId);

  // SCRUM-515 (see isPostedReversalOf): the only no-op is a pending/posted reversal
  // of THIS original; any other key holder fails closed before any write.
  // S515-R2/R3: read BOTH holders, refuse a foreign holder in EITHER table, and
  // only then decide a no-op — a matching holder in one table must never mask a
  // foreign holder in the other.
  const ledgerHolder = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  if (ledgerHolder && !isPostedReversalOf(ledgerHolder, args.originalEventId)) {
    throw reversalKeyConflict(
      args.idempotencyKey,
      `accounting event ${ledgerHolder._id} (${ledgerHolder.eventType}, ${ledgerHolder.status})`,
      args.originalEventId
    );
  }
  if (
    existing &&
    !(existing.kind === "REVERSE" && existing.originalEventId === args.originalEventId)
  ) {
    throw reversalKeyConflict(
      args.idempotencyKey,
      `queued outbox row ${existing._id} (${existing.kind}, ${existing.status})`,
      args.originalEventId
    );
  }
  if (ledgerHolder) return;
  if (existing) {
    // Own REVERSE row: only a PENDING one is queued; FAILED/POSTED is not.
    if (existing.status === "PENDING") return;
    throw reversalKeyConflict(
      args.idempotencyKey,
      `queued outbox row ${existing._id} (${existing.kind}, ${existing.status})`,
      args.originalEventId
    );
  }

  await ctx.db.insert("pendingAccountingEvents", {
    orgId: args.orgId,
    kind: "REVERSE",
    status: "PENDING",
    idempotencyKey: args.idempotencyKey,
    accountingDate: args.reversalDate,
    actorId: args.actorId,
    reason: args.reason,
    attempts: 0,
    createdAt: Date.now(),
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    originalEventId: args.originalEventId,
  });
}

/**
 * Removes an unposted pending POST whose source operation was undone before it
 * could post (e.g. a sale enqueued while no period existed, then cancelled
 * before any period opened). The correct net GL footprint is zero, so the
 * queued event is simply dropped. Returns true if a record was removed.
 */
export async function cancelPendingPostByKey(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (existing && existing.kind === "POST" && existing.status !== "POSTED") {
    await ctx.db.delete(existing._id);
    return true;
  }
  return false;
}

/**
 * Removes every unposted (PENDING or FAILED) queued POST tied to a given
 * source record — for a source that gets voided/cancelled while it can have
 * more than one outstanding queued post at once (e.g. a monthly F&I
 * recognition deferral that failed to post in two different periods before
 * its sale was cancelled), cancelPendingPostByKey's single-idempotencyKey
 * lookup isn't enough: a stuck entry from an earlier period would survive
 * and could still post — recognizing revenue for something that no longer
 * exists — the next time the outbox drains. Returns the number removed.
 */
export async function cancelPendingPostsBySource(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
): Promise<number> {
  const entries = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId)
    )
    .collect();

  let cancelled = 0;
  for (const entry of entries) {
    if (entry.kind === "POST" && entry.status !== "POSTED") {
      await ctx.db.delete(entry._id);
      cancelled++;
    }
  }
  return cancelled;
}
