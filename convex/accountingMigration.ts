/**
 * Phase 6 — Migration audit tooling
 *
 * Tools for detecting duplicate/gap between the legacy transactions table and
 * the new GL (journalLines), classifying legacy records, and producing dry-run
 * migration plans.  No data is mutated unless `dryRun: false` is explicitly
 * passed.
 */
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postAccountingEvent } from "./accounting/postingEngine";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";

// ─── Snapshot / classification helpers ───────────────────────────────────────

interface LegacyTransactionRow {
  id: string;
  type: string;
  amount: number;
  date: number;
  category: string;
  description: string;
  vehicleId: string | undefined;
  hasJournalEntry: boolean;
  eventType: string | null;
}

function mapCategoryToEventType(category: string, type: string): string | null {
  if (category === "VEHICLE_SALE") return "SALE_COMPLETED";
  if (category === "DEPOSIT") return type === "IN" ? "DEPOSIT_RECEIVED" : "DEPOSIT_REFUNDED";
  if (category === "COLLECTION_PAYMENT") return "COLLECTION_PAYMENT";
  if (category === "EXPENSE") return "EXPENSE_POSTED";
  return null;
}

async function classifyLegacyTransaction(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  tx: { _id: Id<"transactions">; type: "IN" | "OUT"; category: string; vehicleId?: Id<"vehicles">; amount: number; date: number; description: string }
): Promise<LegacyTransactionRow> {
  const existing = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", orgId)
        .eq("sourceType", "transactions")
        .eq("sourceId", tx._id.toString())
    )
    .first();

  const eventType = mapCategoryToEventType(tx.category, tx.type);

  return {
    id: tx._id.toString(),
    type: tx.type,
    amount: tx.amount,
    date: tx.date,
    category: tx.category,
    description: tx.description,
    vehicleId: tx.vehicleId?.toString(),
    hasJournalEntry: !!existing,
    eventType,
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const auditLegacyTransactions = query({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
    onlyUnposted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const limit = Math.min(args.limit ?? 100, 500);

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(limit);

    const rows = await Promise.all(txns.map((tx) => classifyLegacyTransaction(ctx, args.orgId, tx)));
    const unposted = rows.filter((r) => !r.hasJournalEntry);
    const posted = rows.filter((r) => r.hasJournalEntry);

    return {
      total: rows.length,
      postedCount: posted.length,
      unpostedCount: unposted.length,
      rows: args.onlyUnposted ? unposted : rows,
    };
  },
});

export const duplicateEventCheck = query({
  args: {
    orgId: v.id("organizations"),
    sourceType: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) =>
        q.eq("orgId", args.orgId).eq("eventType", args.sourceType)
      )
      .collect();

    const seenIdempotencyKeys = new Map<string, string[]>();
    for (const e of events) {
      const existing = seenIdempotencyKeys.get(e.idempotencyKey) ?? [];
      existing.push(e._id.toString());
      seenIdempotencyKeys.set(e.idempotencyKey, existing);
    }

    const duplicates = Array.from(seenIdempotencyKeys.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => ({ idempotencyKey: key, eventIds: ids }));

    return {
      totalEvents: events.length,
      uniqueKeys: seenIdempotencyKeys.size,
      duplicateCount: duplicates.length,
      duplicates,
    };
  },
});

export const migrationGapAnalysis = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const legacyCount = (
      await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    const glEventCount = (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    const glJournalCount = (
      await ctx.db
        .query("journalEntries")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    const glLineCount = (
      await ctx.db
        .query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    const receivableCount = (
      await ctx.db
        .query("receivableDocuments")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    const paymentCount = (
      await ctx.db
        .query("canonicalPayments")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    const allocationCount = (
      await ctx.db
        .query("paymentAllocations")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).length;

    return {
      legacy: { transactions: legacyCount },
      gl: { events: glEventCount, journalEntries: glJournalCount, journalLines: glLineCount },
      subledger: { receivables: receivableCount, payments: paymentCount, allocations: allocationCount },
      migrationProgress: legacyCount > 0 ? Math.round((glEventCount / legacyCount) * 100) : 100,
    };
  },
});

// ─── Migration mutation ───────────────────────────────────────────────────────

export const migrateUnpostedTransactions = mutation({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const dryRun = args.dryRun !== false;
    const limit = Math.min(args.limit ?? 50, 200);

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(limit * 3);

    const currency = await getOrgCurrency(ctx, args.orgId);
    const results: Array<{ transactionId: string; action: string; eventType: string | null; reason?: string }> = [];

    for (const tx of txns) {
      if (results.filter((r) => r.action !== "SKIP").length >= limit) break;

      // Check if already posted
      const existing = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("sourceType", "transactions")
            .eq("sourceId", tx._id.toString())
        )
        .first();

      if (existing) {
        results.push({ transactionId: tx._id.toString(), action: "SKIP", eventType: null, reason: "already_posted" });
        continue;
      }

      const eventType = mapCategoryToEventType(tx.category, tx.type);

      if (!eventType) {
        results.push({ transactionId: tx._id.toString(), action: "SKIP", eventType: null, reason: "no_rule_for_category" });
        continue;
      }

      const amountMinor = toMinorUnits(tx.amount, currency);
      const idempotencyKey = `migrate_${tx._id}`;

      if (dryRun) {
        results.push({ transactionId: tx._id.toString(), action: "WOULD_POST", eventType });
        continue;
      }

      try {
        const payload: Record<string, unknown> = {
          amountMinor,
          currency,
          legacyTransactionId: tx._id.toString(),
        };
        if (tx.vehicleId) payload.vehicleId = tx.vehicleId.toString();

        if (eventType === "EXPENSE_POSTED") {
          payload.expenseId = tx.expenseId?.toString() ?? tx._id.toString();
        } else if (eventType === "COLLECTION_PAYMENT") {
          payload.paymentId = tx._id.toString();
          payload.paymentMethod = "CASH";
        } else if (eventType === "DEPOSIT_RECEIVED" || eventType === "DEPOSIT_REFUNDED") {
          payload.depositId = tx._id.toString();
          payload.paymentMethod = "CASH";
        } else if (eventType === "SALE_COMPLETED") {
          payload.saleId = tx._id.toString();
          payload.saleAmountMinor = amountMinor;
        }

        await postAccountingEvent(ctx, {
          orgId: args.orgId,
          eventType: eventType as "EXPENSE_POSTED" | "COLLECTION_PAYMENT" | "DEPOSIT_RECEIVED" | "DEPOSIT_REFUNDED" | "SALE_COMPLETED",
          sourceType: "transactions",
          sourceId: tx._id.toString(),
          eventVersion: 1,
          accountingDate: tx.date,
          occurredAt: tx.date,
          currency,
          idempotencyKey,
          payload,
          actorId: user._id,
        });
        results.push({ transactionId: tx._id.toString(), action: "POSTED", eventType });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ transactionId: tx._id.toString(), action: "FAILED", eventType, reason: message });
      }
    }

    const posted = results.filter((r) => r.action === "POSTED" || r.action === "WOULD_POST").length;
    const skipped = results.filter((r) => r.action === "SKIP").length;
    const failed = results.filter((r) => r.action === "FAILED").length;

    return { dryRun, posted, skipped, failed, results };
  },
});
