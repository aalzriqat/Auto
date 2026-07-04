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
import { ensurePartnerEquityAccounts, ensureClaimAccounts } from "./chartOfAccounts";
import { toMinorUnits } from "./utils/money";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";

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
  // GL Phase 12 closed the equity skip gap: these post through the partner
  // equity rules without a partnerId (legacy rows never recorded which
  // partner — the rules treat it as optional metadata).
  if (category === "PARTNER_DRAW") return "PARTNER_DREW";
  if (category === "CAPITAL_INJECTION") return "CAPITAL_CONTRIBUTED";
  // GL Phase 13 closed the claim skip gap the same way.
  if (category === "CLAIM_PAYMENT") return "CLAIM_SETTLED";
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
    // Only consider an event as posted if it is in POSTED status with a journal entry linked
    hasJournalEntry: !!(existing && existing.status === "POSTED" && existing.journalEntryId),
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
    await requireFeature(ctx, args.orgId, "accounting");

    const rawLimit = args.limit ?? 100;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
      throw new Error("limit must be a positive integer.");
    }
    const limit = Math.min(rawLimit, 500);

    // Scan enough rows to collect `limit` unposted entries when onlyUnposted=true
    const scanLimit = args.onlyUnposted ? limit * 5 : limit;
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(scanLimit);

    const rows = await Promise.all(txns.map((tx) => classifyLegacyTransaction(ctx, args.orgId, tx)));
    const unposted = rows.filter((r) => !r.hasJournalEntry);
    const posted = rows.filter((r) => r.hasJournalEntry);

    return {
      scannedCount: rows.length,
      hasMore: txns.length === scanLimit,
      total: rows.length,
      postedCount: posted.length,
      unpostedCount: unposted.length,
      rows: args.onlyUnposted ? unposted.slice(0, limit) : rows,
    };
  },
});

export const duplicateEventCheck = query({
  args: {
    orgId: v.id("organizations"),
    eventType: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) =>
        q.eq("orgId", args.orgId).eq("eventType", args.eventType)
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
    await requireFeature(ctx, args.orgId, "accounting");

    const legacyCount = (
      await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    // Count only events sourced from the legacy transactions table for accurate progress
    const glEventCount = (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", args.orgId).eq("sourceType", "transactions")
        )
        .take(10000)
    ).length;

    const glJournalCount = (
      await ctx.db
        .query("journalEntries")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    const glLineCount = (
      await ctx.db
        .query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    const receivableCount = (
      await ctx.db
        .query("receivableDocuments")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    const paymentCount = (
      await ctx.db
        .query("canonicalPayments")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    const allocationCount = (
      await ctx.db
        .query("paymentAllocations")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(10000)
    ).length;

    return {
      legacy: { transactions: legacyCount },
      gl: { events: glEventCount, journalEntries: glJournalCount, journalLines: glLineCount },
      subledger: { receivables: receivableCount, payments: paymentCount, allocations: allocationCount },
      migrationProgress: legacyCount > 0 ? Math.min(100, Math.round((glEventCount / legacyCount) * 100)) : 100,
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
    await requireFeature(ctx, args.orgId, "accounting");

    const dryRun = args.dryRun !== false;
    const rawMigLimit = args.limit ?? 50;
    if (!Number.isSafeInteger(rawMigLimit) || rawMigLimit < 1) {
      throw new Error("limit must be a positive integer.");
    }
    const limit = Math.min(rawMigLimit, 200);

    // Scan 10x the requested limit to work past already-posted or unmappable rows
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(limit * 10);

    const currency = await getOrgCurrency(ctx, args.orgId);
    // Migration posts directly through postAccountingEvent (not the domain
    // hooks), so the Phase 12 equity accounts must be self-healed here —
    // otherwise migrating PARTNER_DRAW/CAPITAL_INJECTION rows on an older
    // chart fails to resolve PARTNER_CAPITAL/PARTNER_DRAWINGS.
    if (!dryRun) {
      await ensurePartnerEquityAccounts(ctx, args.orgId, user._id);
      await ensureClaimAccounts(ctx, args.orgId, user._id);
    }
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
        } else if (eventType === "PARTNER_DREW" || eventType === "CAPITAL_CONTRIBUTED") {
          payload.paymentMethod = "CASH";
        } else if (eventType === "CLAIM_SETTLED") {
          payload.claimId = tx._id.toString();
          payload.paymentMethod = "CASH";
        }

        await postAccountingEvent(ctx, {
          orgId: args.orgId,
          eventType: eventType as "EXPENSE_POSTED" | "COLLECTION_PAYMENT" | "DEPOSIT_RECEIVED" | "DEPOSIT_REFUNDED" | "SALE_COMPLETED" | "PARTNER_DREW" | "CAPITAL_CONTRIBUTED" | "CLAIM_SETTLED",
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

    const posted = results.filter((r) => r.action === "POSTED").length;
    const wouldPost = results.filter((r) => r.action === "WOULD_POST").length;
    const skipped = results.filter((r) => r.action === "SKIP").length;
    const failed = results.filter((r) => r.action === "FAILED").length;

    return { dryRun, posted, wouldPost, skipped, failed, results };
  },
});

// ─── GL Phase 17: legacy money widen-migrate-narrow backfills ────────────────
//
// Each backfill is additive-only (writes the new minor-unit field, never
// touches the legacy major-unit field) and idempotent (already-migrated rows
// are skipped by checking the target field is still unset), matching the
// "Cross-Phase Risks" note in the phase plan: these tables must migrate
// additively first and narrow only after the backfill is verified against
// production. Narrowing (removing purchaseValue/initialCapital/currentBalance/
// claimAmount from the schema) is deliberately NOT done in this phase — it
// requires this migration to have actually run and been verified against
// live org data, which is a deploy-time operation, not something to do
// blind in code.

export const backfillFixedAssetMinorUnits = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);

    const assets = await ctx.db
      .query("fixedAssets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    let migrated = 0;
    for (const asset of assets) {
      if (asset.costMinor != null) continue; // already on minor units
      if (asset.purchaseValue == null) continue; // nothing to backfill from
      // Cost/currency only — deliberately NOT setting usefulLifeMonths/status
      // here. We don't have real historical depreciation data for these
      // rows, so they stay "known cost, no schedule" (disposable, but not
      // eligible for the depreciation cron) until someone sets up a real
      // schedule. See fixedAssets.dispose/impair status guards.
      await ctx.db.patch(asset._id, {
        costMinor: toMinorUnits(asset.purchaseValue, currency),
        currency,
      });
      migrated++;
    }

    await auditLogForMigration(ctx, args.orgId, user._id, "fixedAssets", assets.length, migrated);
    return { scanned: assets.length, migrated };
  },
});

export const backfillPartnerEquityMinorUnits = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);

    const partners = await ctx.db
      .query("partnerEquity")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    let migrated = 0;
    for (const partner of partners) {
      if (partner.openingBalanceMinor != null) continue;
      if (partner.currentBalance == null) continue;
      await ctx.db.patch(partner._id, {
        openingBalanceMinor: toMinorUnits(partner.currentBalance, currency),
      });
      migrated++;
    }

    await auditLogForMigration(ctx, args.orgId, user._id, "partnerEquity", partners.length, migrated);
    return { scanned: partners.length, migrated };
  },
});

export const backfillClaimMinorUnits = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);

    const claims = await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    let migrated = 0;
    for (const claim of claims) {
      if (claim.claimAmountMinor != null) continue;
      if (claim.claimAmount == null) continue;
      await ctx.db.patch(claim._id, {
        claimAmountMinor: toMinorUnits(claim.claimAmount, currency),
        currency,
      });
      migrated++;
    }

    await auditLogForMigration(ctx, args.orgId, user._id, "claims", claims.length, migrated);
    return { scanned: claims.length, migrated };
  },
});

async function auditLogForMigration(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  tableName: string,
  scanned: number,
  migrated: number
): Promise<void> {
  await auditLog(ctx, {
    orgId,
    actorId,
    actionType: "MIGRATE_TRANSACTION",
    resourceType: tableName,
    resourceId: tableName,
    description: `Backfilled minor-unit amounts on ${tableName}: ${migrated}/${scanned} rows.`,
    after: { scanned, migrated },
  });
}
