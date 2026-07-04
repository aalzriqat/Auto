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
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { PostCommand, postAccountingEvent } from "./accounting/postingEngine";
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

// ─── Drain core (plain function, reused by the mutation + schedulers) ──────────

export async function drainPendingForOrg(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  limit = 50
): Promise<{ posted: number; failed: number }> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .take(Math.min(limit, 200));

  let posted = 0;
  let failed = 0;

  for (const p of pending) {
    try {
      if (p.kind === "POST") {
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
        await ctx.db.patch(p._id, {
          status: "POSTED",
          resolvedAt: Date.now(),
          resultEventId: res.eventId,
          attempts: p.attempts + 1,
        });
      } else {
        if (!p.originalEventId) throw new Error("Pending REVERSE record missing originalEventId");
        const res = await reverseAccountingEvent(ctx, {
          orgId: p.orgId,
          originalEventId: p.originalEventId,
          reversalDate: p.accountingDate,
          reason: p.reason ?? "Reversal (deferred)",
          actorId: p.actorId,
          idempotencyKey: p.idempotencyKey,
        });
        await ctx.db.patch(p._id, {
          status: "POSTED",
          resolvedAt: Date.now(),
          resultEventId: res.reversalEventId,
          attempts: p.attempts + 1,
        });
      }
      posted++;
    } catch (err) {
      // Keep the record PENDING and retryable; surface the error for visibility.
      const message = err instanceof Error ? err.message : String(err);
      await ctx.db.patch(p._id, { attempts: p.attempts + 1, lastError: message });
      failed++;
    }
  }

  return { posted, failed };
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
