import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postAccountingEvent } from "./accounting/postingEngine";
import { reverseAccountingEvent } from "./accounting/reversals";
import { requireFeature } from "./subscriptions";

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listJournalEntries = query({
  args: {
    orgId: v.id("organizations"),
    periodId: v.optional(v.id("accountingPeriods")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const limit = Math.min(args.limit ?? 50, 200);
    let q;
    if (args.periodId) {
      q = ctx.db
        .query("journalEntries")
        .withIndex("by_org_period", (q) => q.eq("orgId", args.orgId).eq("periodId", args.periodId!));
    } else {
      q = ctx.db
        .query("journalEntries")
        .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId));
    }
    return await q.order("desc").take(limit);
  },
});

export const getJournalEntry = query({
  args: {
    orgId: v.id("organizations"),
    journalEntryId: v.id("journalEntries"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const entry = await ctx.db.get(args.journalEntryId);
    if (!entry || entry.orgId !== args.orgId) return null;
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", args.journalEntryId))
      .collect();
    const event = entry.accountingEventId ? await ctx.db.get(entry.accountingEventId) : null;
    return { entry, lines, event };
  },
});

export const getAccountActivity = query({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId) return null;

    const limit = Math.min(args.limit ?? 100, 500);
    const lines = await (args.fromDate !== undefined
      ? ctx.db
          .query("journalLines")
          .withIndex("by_org_account_date", (q) =>
            q.eq("orgId", args.orgId).eq("accountId", args.accountId).gte("accountingDate", args.fromDate!)
          )
          .take(limit)
      : ctx.db
          .query("journalLines")
          .withIndex("by_org_account_date", (q) =>
            q.eq("orgId", args.orgId).eq("accountId", args.accountId)
          )
          .take(limit));

    const filtered = args.toDate
      ? lines.filter((l) => l.accountingDate <= args.toDate!)
      : lines;

    let totalDebits = 0;
    let totalCredits = 0;
    for (const l of filtered) {
      totalDebits += l.debitMinor;
      totalCredits += l.creditMinor;
    }

    return {
      account,
      lines: filtered,
      totalDebits,
      totalCredits,
      netMinor: account.normalBalance === "DEBIT" ? totalDebits - totalCredits : totalCredits - totalDebits,
    };
  },
});

export const listAccountingEvents = query({
  args: {
    orgId: v.id("organizations"),
    sourceType: v.optional(v.string()),
    sourceId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const limit = Math.min(args.limit ?? 50, 200);
    if (args.sourceType && args.sourceId) {
      return ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", args.orgId).eq("sourceType", args.sourceType!).eq("sourceId", args.sourceId!)
        )
        .take(limit);
    }
    return ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});

// ─── Mutations (engine entry points for manual use / testing) ─────────────────

export const post = mutation({
  args: {
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    eventType: v.string(),
    sourceType: v.string(),
    sourceId: v.string(),
    eventVersion: v.number(),
    accountingDate: v.number(),
    occurredAt: v.number(),
    currency: v.string(),
    idempotencyKey: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return postAccountingEvent(ctx, { ...args, actorId: user._id });
  },
});

export const reverse = mutation({
  args: {
    orgId: v.id("organizations"),
    originalEventId: v.id("accountingEvents"),
    reversalDate: v.number(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return reverseAccountingEvent(ctx, { ...args, actorId: user._id });
  },
});
