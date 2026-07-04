/**
 * GL Phase 17 — legacy money migration + accountant sign-off.
 *
 * Three distinct capabilities:
 *  - postOpeningBalance: a one-time, direct-lines journal entry seeding an
 *    org's starting GL position (mirrors financialAudit.ts's manual-journal
 *    posting mechanics — arbitrary caller-specified lines, not a fixed
 *    payload-driven posting rule — but constrained to post exactly once).
 *  - signOffCutover / listSignOffs: an accountant's point-in-time attestation
 *    that the legacy-to-GL cutover has been reviewed, carrying a snapshot of
 *    the numbers reviewed (not a live computation, so the sign-off stays
 *    meaningful after later activity changes current totals).
 *  - compareLegacyToGL: a parallel-reporting query so a human can verify
 *    nothing was lost or double-counted for a given period.
 */
import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { validateManualJournalLines, auditLog, type ManualJournalLine } from "./financialAudit";
import { toMinorUnits, scaleForCurrency } from "./utils/money";
import { QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * A deliberately minimal, sign-off-scoped total — not a substitute for
 * accountingReports.trialBalance (which is per-currency and drives the real
 * trial balance report). Convex query/mutation handlers aren't plain
 * callable functions, so this is a small self-contained sum rather than
 * cross-calling that query's handler.
 */
async function sumAllPostedJournalLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<{ totalDebits: number; totalCredits: number; isBalanced: boolean }> {
  const entries = (
    await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect()
  ).filter((e) => e.status === "POSTED");

  let totalDebits = 0;
  let totalCredits = 0;
  for (const entry of entries) {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
      .collect();
    for (const line of lines) {
      totalDebits += line.debitMinor;
      totalCredits += line.creditMinor;
    }
  }
  return { totalDebits, totalCredits, isBalanced: totalDebits === totalCredits };
}

export const postOpeningBalance = mutation({
  args: {
    orgId: v.id("organizations"),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ journalId: string }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const existing = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("category"), "OPENING_BALANCE"))
      .first();
    if (existing) {
      throw new ConvexError("An opening balance has already been posted for this organization.");
    }

    const totalDebits = validateManualJournalLines(args.lines as ManualJournalLine[]);

    const period = await getOpenPeriodForDate(ctx, args.orgId, args.asOfDate);
    if (!period) {
      throw new ConvexError("No open accounting period covers the opening-balance date. Create and open a period first.");
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();

    const journalId = await ctx.db.insert("journalEntries", {
      orgId: args.orgId,
      periodId: period._id,
      journalNumber: "OB-pending",
      accountingDate: args.asOfDate,
      sourceType: "cutover",
      sourceId: args.orgId.toString(),
      category: "OPENING_BALANCE",
      memo: args.memo ?? "Opening balance",
      status: "POSTED",
      currency,
      postedBy: user._id,
      postedAt: now,
      createdAt: now,
    });
    const journalNumber = `OB-${journalId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
    await ctx.db.patch(journalId, { journalNumber });

    const scale = scaleForCurrency(currency);
    for (let i = 0; i < args.lines.length; i++) {
      const line = args.lines[i];
      await ctx.db.insert("journalLines", {
        orgId: args.orgId,
        journalEntryId: journalId,
        lineNumber: i + 1,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency,
        scale,
        accountingDate: args.asOfDate,
        description: line.description,
      });
    }

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_MANUAL_JOURNAL",
      resourceType: "journalEntries",
      resourceId: journalId.toString(),
      description: `Opening balance posted: ${args.lines.length} lines, ${totalDebits} total.`,
      after: { lines: args.lines.length, totalDebits },
    });

    return { journalId: journalId.toString() };
  },
});

export const hasOpeningBalance = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const existing = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("category"), "OPENING_BALANCE"))
      .first();
    return existing !== null;
  },
});

/**
 * Parallel-reporting comparison for a cutover period: legacy operational
 * totals (the pre-GL transactions table) against what's actually landed in
 * the GL for events sourced from that same table, so a human can confirm
 * the migration neither lost nor double-counted anything.
 */
export const compareLegacyToGL = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.number(),
    toDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const currency = await getOrgCurrency(ctx, args.orgId);

    const legacyTxns = (
      await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).filter((t) => !t.isDeleted && t.date >= args.fromDate && t.date <= args.toDate);

    let legacyInMinor = 0;
    let legacyOutMinor = 0;
    for (const tx of legacyTxns) {
      const minor = toMinorUnits(tx.amount, currency);
      if (tx.type === "IN") legacyInMinor += minor;
      else legacyOutMinor += minor;
    }

    const glEvents = (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).filter((e) => e.sourceType === "transactions" && e.occurredAt >= args.fromDate && e.occurredAt <= args.toDate);

    const postedEvents = glEvents.filter((e) => e.status === "POSTED");
    let glTotalDebitMinor = 0;
    let glTotalCreditMinor = 0;
    for (const event of postedEvents) {
      if (!event.journalEntryId) continue;
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event.journalEntryId!))
        .collect();
      for (const line of lines) {
        glTotalDebitMinor += line.debitMinor;
        glTotalCreditMinor += line.creditMinor;
      }
    }

    const migratedTransactionIds = new Set(postedEvents.map((e) => e.sourceId));
    const unmigrated = legacyTxns.filter((tx) => !migratedTransactionIds.has(tx._id.toString()));

    return {
      currency,
      legacy: {
        transactionCount: legacyTxns.length,
        totalInMinor: legacyInMinor,
        totalOutMinor: legacyOutMinor,
      },
      gl: {
        migratedEventCount: postedEvents.length,
        totalDebitMinor: glTotalDebitMinor,
        totalCreditMinor: glTotalCreditMinor,
        isBalanced: glTotalDebitMinor === glTotalCreditMinor,
      },
      unmigratedCount: unmigrated.length,
      unmigratedTransactionIds: unmigrated.map((tx) => tx._id.toString()),
    };
  },
});

export const signOffCutover = mutation({
  args: {
    orgId: v.id("organizations"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const legacyTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const activeLegacy = legacyTransactions.filter((t) => !t.isDeleted);

    const glEvents = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", args.orgId).eq("sourceType", "transactions"))
      .collect();
    const migratedIds = new Set(
      glEvents.filter((e) => e.status === "POSTED").map((e) => e.sourceId)
    );
    const migratedCount = activeLegacy.filter((t) => migratedIds.has(t._id.toString())).length;

    const tb = await sumAllPostedJournalLines(ctx, args.orgId);

    const snapshot = {
      legacyTransactionCount: activeLegacy.length,
      migratedTransactionCount: migratedCount,
      unmigratedTransactionCount: activeLegacy.length - migratedCount,
      trialBalanceTotalDebitsMinor: tb.totalDebits,
      trialBalanceTotalCreditsMinor: tb.totalCredits,
      isBalanced: tb.isBalanced,
    };

    const signOffId = await ctx.db.insert("accountingCutoverSignOffs", {
      orgId: args.orgId,
      snapshot,
      notes: args.notes,
      signedOffBy: user._id,
      signedOffAt: Date.now(),
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_EVENT",
      resourceType: "accountingCutoverSignOffs",
      resourceId: signOffId.toString(),
      description: `Accounting cutover signed off: ${snapshot.migratedTransactionCount}/${snapshot.legacyTransactionCount} legacy transactions migrated, trial balance ${snapshot.isBalanced ? "balanced" : "UNBALANCED"}.`,
      after: snapshot,
    });

    return { signOffId: signOffId.toString(), snapshot };
  },
});

export const listSignOffs = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("accountingCutoverSignOffs")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});
