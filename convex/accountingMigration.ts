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
import { getOrgCurrency, hookVehiclePrepExpenseReclassified } from "./accounting/workflowHooks";
import { ensurePartnerEquityAccounts, ensureClaimAccounts } from "./chartOfAccounts";
import { toMinorUnits } from "./utils/money";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";
import { computeVehicleCapitalizedCost, CAPITALIZABLE_EXPENSE_CATEGORIES } from "./utils/vehicleCost";
import { getOpenPeriodForDate } from "./accountingPeriods";

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
  // Only created going forward by vehicles.create (vehicle acquisition
  // capitalization) — legacy rows predating that never exist with this category.
  if (category === "VEHICLE_PURCHASE") return "VEHICLE_ACQUIRED";
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
        } else if (eventType === "VEHICLE_ACQUIRED") {
          payload.costMinor = amountMinor;
          payload.paymentMethod = "CASH";
        }

        await postAccountingEvent(ctx, {
          orgId: args.orgId,
          eventType: eventType as "EXPENSE_POSTED" | "COLLECTION_PAYMENT" | "DEPOSIT_RECEIVED" | "DEPOSIT_REFUNDED" | "SALE_COMPLETED" | "PARTNER_DREW" | "CAPITAL_CONTRIBUTED" | "CLAIM_SETTLED" | "VEHICLE_ACQUIRED",
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

// ─── Vehicle inventory opening-balance backfill ────────────────────────────────
//
// Vehicles already in stock when inventory capitalization shipped never had
// their acquisition cost debited to Vehicle Inventory. This posts a one-time
// catch-up entry per vehicle so today's Balance Sheet stops understating
// inventory — see ruleVehicleInventoryOpeningBalance for why it credits
// Retained Earnings rather than cash/bank (the cash already left the business
// in the past; crediting the current cash/bank account for it would just
// introduce a new error at the bank-reconciliation end instead).
//
// Deliberately scoped to vehicles NOT yet sold: an already-sold vehicle's
// historical COGS/revenue effect is a prior-period restatement question for
// an accountant to resolve via manual journal, not something to guess at here.
//
// The opening-balance amount is NOT simply computeVehicleCapitalizedCost(),
// because some of a vehicle's capitalizable prep expenses (repair/maintenance/
// detailing/transport) may have already been posted historically to
// GENERAL_EXPENSE, before capitalization existed. Blindly adding the full
// cost to inventory/retained earnings would leave that amount double-counted:
// once in the historical P&L, once in this backfill. Each capitalizable
// expense is classified individually:
//   - already flagged CAPITALIZED_INVENTORY (posted under the current regime)
//     → already correctly in inventory via its own entry; excluded entirely.
//   - flagged PERIOD_EXPENSE, or non-capitalizable, or PENDING → not a gap.
//   - never classified (predates this feature) and never posted to the GL at
//     all → safe to fold into the same opening-balance entry as the base cost.
//   - never classified but already posted to GENERAL_EXPENSE historically →
//     reclassified via its own Dr Inventory / Cr General Expense entry
//     (VEHICLE_PREP_EXPENSE_RECLASSIFIED) if its accounting date falls in a
//     still-open period; otherwise left untouched and flagged for an
//     accountant to handle as a prior-period adjustment.

export const backfillVehicleInventoryOpeningBalances = mutation({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const dryRun = args.dryRun !== false;
    const rawLimit = args.limit ?? 100;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
      throw new Error("limit must be a positive integer.");
    }
    const limit = Math.min(rawLimit, 500);

    const currency = await getOrgCurrency(ctx, args.orgId);
    // RETAINED_EARNINGS may predate the current chart on very old orgs —
    // self-heal it the same way the Phase 12 equity migration does.
    if (!dryRun) {
      await ensurePartnerEquityAccounts(ctx, args.orgId, user._id);
    }

    const vehicles = (
      await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(limit * 10)
    ).filter((v) => !v.isDeleted && v.status !== "SOLD" && v.sourceType !== "SOURCED");

    const results: Array<{
      vehicleId: string;
      action: "POSTED" | "WOULD_POST" | "NEEDS_REVIEW" | "SKIP" | "FAILED";
      amountMinor?: number;
      reclassifiedExpenseIds?: string[];
      manualReviewExpenseIds?: string[];
      reason?: string;
    }> = [];

    for (const vehicle of vehicles) {
      if (results.filter((r) => r.action !== "SKIP").length >= limit) break;

      const alreadyPosted = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", args.orgId).eq("sourceType", "vehicles").eq("sourceId", vehicle._id.toString())
        )
        .filter((q) =>
          q.or(q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"), q.eq(q.field("eventType"), "VEHICLE_INVENTORY_OPENING_BALANCE"))
        )
        .first();
      if (alreadyPosted) {
        results.push({ vehicleId: vehicle._id.toString(), action: "SKIP", reason: "already_posted" });
        continue;
      }

      let uncapitalizedBase = (vehicle.purchasePrice ?? 0) + (vehicle.landedCostTotal ?? 0);
      const reclassifications: Array<{ expenseId: Id<"expenses">; date: number; amountMinor: number; netAmount: number }> = [];
      // Never touched the GL at all — folded straight into the opening-balance
      // amount below (not a separate GL entry), but still needs its own
      // accountingTreatment/capitalizedAmount patched once posted, same as the
      // reclassified ones, so computeVehicleCapitalizedCost counts it going forward.
      const baseFoldedExpenses: Array<{ expenseId: Id<"expenses">; netAmount: number }> = [];
      const manualReviewExpenseIds: string[] = [];

      const expenses = await ctx.db
        .query("expenses")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", vehicle._id))
        .collect();

      for (const expense of expenses) {
        if (expense.isDeleted) continue;
        if (expense.status === "PENDING") continue;
        if (expense.accountingTreatment) continue; // already classified — either already in inventory or correctly expensed
        if (!CAPITALIZABLE_EXPENSE_CATEGORIES.has(expense.category)) continue;

        const netAmount = expense.amount - (expense.taxAmount ?? 0);

        const postedEvent = await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", args.orgId).eq("sourceType", "expenses").eq("sourceId", expense._id.toString())
          )
          .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first();
        const pendingPost = postedEvent
          ? null
          : await ctx.db
              .query("pendingAccountingEvents")
              .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", `expense_posted_${expense._id}`))
              .first();

        if (!postedEvent && !pendingPost) {
          // Never touched the GL at all — no conflicting historical entry to
          // double-count against.
          uncapitalizedBase += netAmount;
          baseFoldedExpenses.push({ expenseId: expense._id, netAmount });
          continue;
        }
        if (!postedEvent && pendingPost) {
          // Still queued in the outbox with a pre-capitalization payload — its
          // eventual posting is unpredictable from here, so don't guess.
          manualReviewExpenseIds.push(expense._id.toString());
          continue;
        }

        const period = await getOpenPeriodForDate(ctx, args.orgId, expense.date);
        if (!period) {
          manualReviewExpenseIds.push(expense._id.toString());
          continue;
        }
        reclassifications.push({
          expenseId: expense._id,
          date: expense.date,
          amountMinor: toMinorUnits(netAmount, currency),
          netAmount,
        });
      }

      const baseAmountMinor = toMinorUnits(uncapitalizedBase, currency);
      const hasPostableWork = baseAmountMinor > 0 || reclassifications.length > 0;
      if (!hasPostableWork && manualReviewExpenseIds.length === 0) {
        results.push({ vehicleId: vehicle._id.toString(), action: "SKIP", reason: "zero_cost" });
        continue;
      }
      if (!hasPostableWork) {
        results.push({ vehicleId: vehicle._id.toString(), action: "NEEDS_REVIEW", manualReviewExpenseIds });
        continue;
      }

      if (dryRun) {
        results.push({
          vehicleId: vehicle._id.toString(),
          action: "WOULD_POST",
          amountMinor: baseAmountMinor,
          reclassifiedExpenseIds: reclassifications.map((r) => r.expenseId.toString()),
          manualReviewExpenseIds,
        });
        continue;
      }

      try {
        const now = Date.now();
        if (baseAmountMinor > 0) {
          await postAccountingEvent(ctx, {
            orgId: args.orgId,
            eventType: "VEHICLE_INVENTORY_OPENING_BALANCE",
            sourceType: "vehicles",
            sourceId: vehicle._id.toString(),
            eventVersion: 1,
            accountingDate: now,
            occurredAt: now,
            currency,
            idempotencyKey: `vehicle_inventory_opening_${vehicle._id}`,
            payload: { vehicleId: vehicle._id.toString(), amountMinor: baseAmountMinor, currency },
            actorId: user._id,
          });
          for (const be of baseFoldedExpenses) {
            await ctx.db.patch(be.expenseId, {
              accountingTreatment: "CAPITALIZED_INVENTORY",
              capitalizedAmount: be.netAmount,
            });
          }
        }
        for (const r of reclassifications) {
          await hookVehiclePrepExpenseReclassified(ctx, {
            orgId: args.orgId,
            expenseId: r.expenseId,
            vehicleId: vehicle._id,
            amountMinor: r.amountMinor,
            currency,
            actorId: user._id,
            occurredAt: r.date,
          });
          // Mark it capitalized going forward so computeVehicleCapitalizedCost
          // (COGS at sale, commission, both profit reports) stays in sync with
          // what's now actually sitting in the Vehicle Inventory GL account.
          await ctx.db.patch(r.expenseId, {
            accountingTreatment: "CAPITALIZED_INVENTORY",
            capitalizedAmount: r.netAmount,
          });
        }
        results.push({
          vehicleId: vehicle._id.toString(),
          action: "POSTED",
          amountMinor: baseAmountMinor,
          reclassifiedExpenseIds: reclassifications.map((r) => r.expenseId.toString()),
          manualReviewExpenseIds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ vehicleId: vehicle._id.toString(), action: "FAILED", reason: message });
      }
    }

    const posted = results.filter((r) => r.action === "POSTED").length;
    const wouldPost = results.filter((r) => r.action === "WOULD_POST").length;
    const needsReview = results.filter((r) => r.action === "NEEDS_REVIEW").length;
    const skipped = results.filter((r) => r.action === "SKIP").length;
    const failed = results.filter((r) => r.action === "FAILED").length;

    return { dryRun, posted, wouldPost, needsReview, skipped, failed, results };
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
