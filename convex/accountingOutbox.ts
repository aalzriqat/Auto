/**
 * accountingOutbox.ts
 *
 * Durable outbox for accounting events that could not post at the moment of the
 * domain operation (no chart of accounts, or no open accounting period covering
 * the date). The workflow hooks enqueue such events here rather than silently
 * skipping them, so a sale / payment / expense / disbursement is never made
 * operationally final without a captured, retryable GL record.
 *
 * The queue is re-driven (idempotently) whenever the conditions that gate
 * posting change — i.e. when a chart is initialized or a period is opened —
 * via a scheduled drain. Posting itself is idempotent (postAccountingEvent and
 * reverseAccountingEvent dedupe by idempotency key), so re-driving is safe even
 * if the original operation later posts directly.
 */
import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { PostCommand, postAccountingEvent } from "./accounting/postingEngine";
import { prepaidPostingBlockedReason } from "./utils/prepaidSourceLedger";
import { payrollPostingBlockedReason } from "./utils/payrollSourceLedger";
import { reverseAccountingEvent } from "./accounting/reversals";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

// ─── Enqueue helpers (called from workflow hooks) ─────────────────────────────

export async function enqueuePendingPost(
  ctx: MutationCtx,
  cmd: PostCommand,
  reason: string
): Promise<void> {
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
  const existing = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  if (existing) return;

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

// A pending event that fails this many times stops being auto-retried and
// moves to FAILED so it surfaces distinctly for manual attention (via
// listPending / retryFailed below) instead of retrying forever on every
// drain — the underlying cause (e.g. a still-missing chart of accounts) is
// usually not something that will resolve itself between drains.
const MAX_ATTEMPTS = 10;

// ─── Drain core (plain function, reused by the mutation + schedulers) ──────────

async function postPendingEntry(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">): Promise<Id<"accountingEvents">> {
  if (!p.eventType) throw new Error("Pending POST record missing eventType");
  if (!p.currency) throw new Error("Pending POST record missing currency");
  const res = await postAccountingEvent(ctx, {
    orgId: p.orgId,
    branchId: p.branchId,
    eventType: p.eventType,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    eventVersion: p.eventVersion ?? 1,
    accountingDate: p.accountingDate,
    occurredAt: p.occurredAt ?? p.accountingDate,
    currency: p.currency,
    idempotencyKey: p.idempotencyKey,
    payload: (p.payload ?? {}) as Record<string, unknown>,
    actorId: p.actorId,
  });
  return res.eventId;
}

async function reversePendingEntry(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">): Promise<Id<"accountingEvents">> {
  if (!p.originalEventId) throw new Error("Pending REVERSE record missing originalEventId");
  const res = await reverseAccountingEvent(ctx, {
    orgId: p.orgId,
    originalEventId: p.originalEventId,
    reversalDate: p.accountingDate,
    reason: p.reason ?? "Reversal (deferred)",
    actorId: p.actorId,
    idempotencyKey: p.idempotencyKey,
  });
  return res.reversalEventId;
}

async function markEntryPosted(
  ctx: MutationCtx,
  p: Doc<"pendingAccountingEvents">,
  resultEventId: Id<"accountingEvents">
): Promise<void> {
  await ctx.db.patch(p._id, { status: "POSTED", resolvedAt: Date.now(), resultEventId, attempts: p.attempts + 1 });
}

/**
 * Below the retry threshold: keep it PENDING and retryable, just surface the
 * error for visibility. At/above it: stop auto-retrying and mark FAILED so it
 * needs deliberate attention instead of retrying forever.
 */
async function markEntryFailed(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">, message: string): Promise<void> {
  const attempts = p.attempts + 1;
  await ctx.db.patch(p._id, {
    attempts,
    lastError: message,
    ...(attempts >= MAX_ATTEMPTS ? { status: "FAILED" as const } : {}),
  });
}

/**
 * Records WHY an entry was skipped without counting it as an attempt, so it
 * stays PENDING and drains by itself once its blocker clears. The reason lands
 * in lastError purely so it is visible on the Accounting → Setup pending list —
 * an entry that silently refuses to post with no explanation is worse for the
 * accountant than one that fails loudly.
 */
async function markEntryHeld(ctx: MutationCtx, p: Doc<"pendingAccountingEvents">, reason: string): Promise<void> {
  const lastError = `Waiting to post: ${reason}.`;
  if (p.lastError === lastError) return;
  await ctx.db.patch(p._id, { lastError });
}

/**
 * Attempts to post/reverse a batch of already-fetched outbox rows, one at a
 * time, isolating each row's failure from the rest. Factored out of
 * drainPendingForOrg so a narrower, pre-filtered subset (e.g. one prepaid
 * schedule's own rows — see prepaidExpenses.redriveScheduleEvents) can share
 * the exact same posting/retry/dead-letter logic instead of re-implementing it.
 */
export async function drainEntries(
  ctx: MutationCtx,
  entries: Doc<"pendingAccountingEvents">[]
): Promise<{ posted: number; failed: number; held: number }> {
  let posted = 0;
  let failed = 0;
  let held = 0;

  for (const p of entries) {
    // Posting-side guard. What makes an entry drain is "a period covering THIS
    // entry's date opened" — which says nothing about whether the entry is
    // still coherent with the rest of the ledger. A prepaid correction queued
    // before prepaidExpenses.ts's guard existed would otherwise post here and
    // credit an asset whose debit is still queued, recreating the exact
    // negative balance that guard prevents, with no operator action. Reversals
    // are exempt: they unwind something that already posted.
    if (p.kind === "POST") {
      const blockedReason =
        (await prepaidPostingBlockedReason(ctx, p)) ?? (await payrollPostingBlockedReason(ctx, p));
      if (blockedReason) {
        // Held, not failed: this entry is not broken and retrying it is not
        // wrong — it is waiting on something else to post first. Routing it
        // through markEntryFailed would burn attempts and eventually
        // dead-letter a perfectly valid entry for someone else's blocker.
        await markEntryHeld(ctx, p, blockedReason);
        held++;
        continue;
      }
    }
    try {
      const resultEventId = p.kind === "POST" ? await postPendingEntry(ctx, p) : await reversePendingEntry(ctx, p);
      await markEntryPosted(ctx, p, resultEventId);
      posted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markEntryFailed(ctx, p, message);
      failed++;
    }
  }

  return { posted, failed, held };
}

export async function drainPendingForOrg(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  limit = 50
): Promise<{ posted: number; failed: number; held: number }> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .take(Math.min(limit, 200));

  return drainEntries(ctx, pending);
}

// ─── Internal mutation (scheduler target) ─────────────────────────────────────

export const drainPendingAccountingEvents = internalMutation({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return drainPendingForOrg(ctx, args.orgId, args.limit ?? 50);
  },
});

// ─── Visibility query ─────────────────────────────────────────────────────────

export const listPending = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("POSTED"), v.literal("FAILED"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const limit = Math.min(args.limit ?? 50, 200);
    if (args.status) {
      return ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});

/** Manual re-drive trigger (MANAGE_FINANCE) for operators clearing a backlog. */
export const redrive = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return drainPendingForOrg(ctx, args.orgId);
  },
});

/**
 * Resets a dead-lettered event back to PENDING (with a fresh attempts count)
 * for another round of automatic retries, once whatever caused it to exhaust
 * MAX_ATTEMPTS has been fixed (e.g. the chart of accounts is now initialized).
 * Does not itself attempt to post — call redrive/drainPendingForOrg after.
 */
export const retryFailed = mutation({
  args: { orgId: v.id("organizations"), pendingEventId: v.id("pendingAccountingEvents") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const event = await ctx.db.get(args.pendingEventId);
    if (!event || event.orgId !== args.orgId) {
      throw new ConvexError("Pending accounting event not found in this organization.");
    }
    if (event.status !== "FAILED") {
      throw new ConvexError(`Only a FAILED event can be retried (current status: ${event.status}).`);
    }

    await ctx.db.patch(args.pendingEventId, { status: "PENDING", attempts: 0, lastError: undefined });
  },
});
