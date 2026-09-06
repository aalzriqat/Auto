import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { internalMutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postAccountingEvent } from "./accounting/postingEngine";
import { reverseAccountingEvent } from "./accounting/reversals";
import { RECEIPT_EVENT_TYPE, RECEIPT_SOURCE_TYPE } from "./accounting/receiptOccurrence";
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

// ─── Mutations (engine entry points, internal-only) ───────────────────────────
//
// post/reverse are internalMutation, not mutation: every production event is
// posted through a specific hookXxx wrapper in accounting/workflowHooks.ts that
// builds a well-typed, event-specific payload from a real operational record
// (sale, deposit, vehicle, etc). If these were public, any MANAGE_FINANCE user
// (the default ACCOUNTANT role included) could post an arbitrary payload under
// any event type/source directly from the client — postAccountingEvent's rule
// dispatcher does an unchecked `payload as unknown as XPayload` cast per event
// type with no schema or source-record-existence validation, so a fabricated
// vehicle acquisition, sale, deposit, or supplier payment would post straight
// to the GL. Likewise reverseAccountingEvent accepts any POSTED event id,
// letting a real SALE_COMPLETED entry be reversed directly, bypassing
// saleCancellation.ts's coordinated operational reversal entirely. Keep both
// internal-only; genuine back-office adjustments go through financialAudit.ts's
// two-person manual-journal workflow instead.

export const post = internalMutation({
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

// SCRUM-254 — being allowed to operate the ledger is not authority to unwind a
// customer receipt.
//
// This wrapper authenticates the caller against the org and the accounting
// feature and then hands ANY POSTED event to the shared reversal engine, with a
// reversal key the caller picks. For a certified direct-collection receipt —
// the row asserting a customer's money arrived — that is a generic operator
// command deciding a receipt never happened, and the money's disposition
// (retained credit, refund, cheque return) is never a consequence the generic
// door can reason about.
//
// SCRUM-249 guards the reserved `occr…` key NAMESPACE inside the engine. That
// answers "may this key be used here", a different question from "may this
// caller reverse this at all", which is why the refusal below is deliberately
// blind to `idempotencyKey`: the exact derived reserved key must be refused for
// the same reason an invented one is. Authority is not a spelling.
//
// The refusal is at the WRAPPER, not in `reverseAccountingEvent`, because the
// engine is the shared seam legitimate domain code reverses through —
// `collections.ts`'s cheque-return path (SCRUM-130), the outbox drain, and the
// workflow hooks all call it directly. A receipt denylist inside the engine
// would revoke those lifecycles' own sanctioned authority. This door has no
// production callers to break: every real reversal in the repo reaches the
// engine directly.
const GENERIC_RECEIPT_REVERSAL_REFUSED =
  "A certified receipt occurrence cannot be reversed through the generic ledger " +
  "reversal. Generic operator access is not authority over a receipt — reverse it " +
  "through the collection lifecycle that owns it.";

export const reverse = internalMutation({
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

    // Classify only a row whose tenancy is already established. A missing
    // original, or one belonging to another org, falls through UNCLASSIFIED to
    // the engine's existing `Accounting event not found in this organization`
    // refusal — so this guard can never tell a caller that a row they have no
    // claim to is a receipt. "Not yours" stays the whole answer.
    const original = await ctx.db.get(args.originalEventId);
    if (
      original &&
      original.orgId === args.orgId &&
      original.eventType === RECEIPT_EVENT_TYPE &&
      original.sourceType === RECEIPT_SOURCE_TYPE
    ) {
      // Before the engine call, therefore before any event, journal, line,
      // balance snapshot, status patch or pending-reversal row exists.
      throw new ConvexError(GENERIC_RECEIPT_REVERSAL_REFUSED);
    }

    return reverseAccountingEvent(ctx, { ...args, actorId: user._id });
  },
});
