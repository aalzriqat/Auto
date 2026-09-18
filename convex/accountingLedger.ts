import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { internalMutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postAccountingEvent } from "./accounting/postingEngine";
import { reverseAccountingEvent } from "./accounting/reversals";
import { RECEIPT_EVENT_TYPE, RECEIPT_SOURCE_TYPE } from "./accounting/receiptOccurrence";
import { requireFeature } from "./subscriptions";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";

// ─── Queries ──────────────────────────────────────────────────────────────────

interface LedgerCursor {
  lineCursor: string | null;
  lastEmittedEntryId?: string;
}

function parseLedgerCursor(cursor: string | null | undefined): LedgerCursor {
  if (!cursor) return { lineCursor: null };
  try {
    const parsed = JSON.parse(cursor);
    if (typeof parsed === "object" && parsed !== null && "lineCursor" in parsed) {
      return parsed as LedgerCursor;
    }
  } catch {
    // fallback if raw convex cursor string
  }
  return { lineCursor: cursor };
}

// AF-318-01 — the General Ledger is read through real cursor pagination, not
// a fixed `take(N)`. `by_org_date` and `by_org_period` are both sorted on
// `accountingDate` — the financial truth date a manual journal can legitimately
// backdate into an earlier period than its `_creationTime` — with Convex's
// implicit `_creationTime` (then `_id`) tie-breaker giving every page a stable,
// deterministic order with no possibility of a skipped or duplicated row
// across pages as long as the client keeps requesting with the returned
// cursor (see docs: "Convex automatically appends `_creationTime` to the end
// of every index to break ties"). `periodId` narrows the SAME indexed range —
// never a `.collect()` of the unfiltered table filtered in memory — so a
// period filter costs no more than the entries it actually returns.
export const listJournalEntries = query({
  args: {
    orgId: v.id("organizations"),
    periodId: v.optional(v.id("accountingPeriods")),
    accountId: v.optional(v.id("chartOfAccounts")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    // Account filtering on the entry-level list is answered through the
    // journalLines index (an entry can touch many accounts; the entry itself
    // carries no accountId), so it is handled as its own indexed pass below
    // rather than bolted onto the by_org_date/by_org_period range as a
    // post-hoc `.filter()` — a filter after `.paginate()` would silently
    // shrink pages (or return empty pages) instead of the page size the
    // client asked for, and would still have read every non-matching entry
    // in the range to discard it.
    if (args.accountId) {
      const account = await ctx.db.get(args.accountId);
      if (!account || account.orgId !== args.orgId) {
        return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
      }

      const period = args.periodId ? await ctx.db.get(args.periodId) : null;
      if (args.periodId && (!period || period.orgId !== args.orgId)) {
        return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
      }

      const { lineCursor: initialLineCursor, lastEmittedEntryId: initialLastEmitted } =
        parseLedgerCursor(args.paginationOpts.cursor);

      const targetItems = args.paginationOpts.numItems;
      const seen = new Set<string>();
      if (initialLastEmitted) {
        seen.add(initialLastEmitted);
      }

      const entries = [];
      let currentCursor = initialLineCursor;
      let isDone = false;
      let lastEmittedEntryId = initialLastEmitted;

      // Bound fetch rounds to prevent runaway transaction execution
      const MAX_FETCH_ROUNDS = 10;
      let rounds = 0;

      while (entries.length < targetItems && !isDone && rounds < MAX_FETCH_ROUNDS) {
        rounds++;
        const remaining = targetItems - entries.length;
        const linePage = await ctx.db
          .query("journalLines")
          .withIndex("by_org_account_date", (q) => {
            const base = q.eq("orgId", args.orgId).eq("accountId", args.accountId!);
            return period
              ? base.gte("accountingDate", period.startDate).lte("accountingDate", period.endDate)
              : base;
          })
          .order("desc")
          .paginate({ numItems: remaining, cursor: currentCursor });

        for (const line of linePage.page) {
          if (seen.has(line.journalEntryId)) continue;
          seen.add(line.journalEntryId);

          const entry = await ctx.db.get(line.journalEntryId);
          if (!entry || entry.orgId !== args.orgId) continue;
          if (args.periodId && entry.periodId !== args.periodId) continue;

          entries.push(entry);
          lastEmittedEntryId = entry._id;
        }

        currentCursor = linePage.continueCursor;
        isDone = linePage.isDone;
      }

      const continueCursor = isDone || !currentCursor
        ? ""
        : JSON.stringify({ lineCursor: currentCursor, lastEmittedEntryId });

      return {
        page: entries,
        isDone,
        continueCursor,
      };
    }

    const q = args.periodId
      ? ctx.db
          .query("journalEntries")
          .withIndex("by_org_period", (q) => q.eq("orgId", args.orgId).eq("periodId", args.periodId!))
      : ctx.db
          .query("journalEntries")
          .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId));
    return await q.order("desc").paginate(args.paginationOpts);
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
    const period = entry.periodId ? await ctx.db.get(entry.periodId) : null;
    return { entry, lines, event, period };
  },
});

// AF-318-01 — account drill-down through real cursor pagination on the
// `by_org_account_date` index (orgId, accountId, accountingDate — again with
// Convex's implicit _creationTime/_id tie-breaker giving every page a stable
// order), instead of the old `take(500)` that silently dropped every line
// past the 500th. `fromDate` narrows the SAME indexed range server-side; a
// caller who omits it gets the account's full history one page at a time,
// never a truncated snapshot mistaken for the whole account.
//
// The running balance is computed from `getCumulativeBalancesAsOf` — the SAME
// O(periods)+O(one open period) balance the Trial Balance and Balance Sheet
// already trust (accountingReports.ts, vatReport.ts) — as of the moment just
// before this page's first line, then walked FORWARD through the page in
// chronological (ascending) order. It is kept PER CURRENCY throughout
// (`getCumulativeBalancesAsOf` itself buckets by (accountId, currency), the
// same way accountingReports.ts's Trial Balance never sums two currencies
// into one number): an account can legitimately carry both a pre-conversion
// historical currency and the org's current one (task domain #1), and
// collapsing JOD minor units and USD minor units into a single running total
// would silently fabricate a number with no real denomination. Each returned
// line carries its OWN currency's running balance after it posted; totals are
// grouped the same way.
export const getAccountActivity = query({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId) return null;

    const linePage = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account_date", (q) =>
        args.fromDate !== undefined
          ? q.eq("orgId", args.orgId).eq("accountId", args.accountId).gte("accountingDate", args.fromDate!)
          : q.eq("orgId", args.orgId).eq("accountId", args.accountId)
      )
      .order("asc")
      .paginate(args.paginationOpts);

    const page = args.toDate !== undefined
      ? linePage.page.filter((l) => l.accountingDate <= args.toDate!)
      : linePage.page;

    const netOf = (debitMinor: number, creditMinor: number) =>
      account.normalBalance === "DEBIT" ? debitMinor - creditMinor : creditMinor - debitMinor;

    // Opening balance as of the moment just BEFORE this page's first line,
    // real cumulative history rather than an assumed zero — so a page that
    // does not start at the account's very first entry still reconciles.
    // One lookup per distinct currency actually present on this page (never
    // per line), each scoped to that currency's own cumulative balance.
    const firstLine = page[0];
    const openingAsOf = firstLine ? firstLine.accountingDate - 1 : (args.fromDate ?? 0) - 1;
    const cumulative = openingAsOf >= 0 ? await getCumulativeBalancesAsOf(ctx, args.orgId, openingAsOf) : [];

    // Ties on accountingDate: if multiple journal lines share the exact same
    // accountingDate as firstLine, lines that precede firstLine under Convex's
    // index ordering (_creationTime asc, _id asc) belong to preceding pages and
    // must be credited/debited into this page's opening balance.
    const sameDatePrecedingBalances = new Map<string, { debitMinor: number; creditMinor: number }>();
    if (firstLine) {
      const sameDateLines = await ctx.db
        .query("journalLines")
        .withIndex("by_org_account_date", (q) =>
          q.eq("orgId", args.orgId).eq("accountId", args.accountId).eq("accountingDate", firstLine.accountingDate)
        )
        .order("asc")
        .collect();

      for (const l of sameDateLines) {
        if (
          l._creationTime < firstLine._creationTime ||
          (l._creationTime === firstLine._creationTime && l._id < firstLine._id)
        ) {
          const b = sameDatePrecedingBalances.get(l.currency) ?? { debitMinor: 0, creditMinor: 0 };
          b.debitMinor += l.debitMinor;
          b.creditMinor += l.creditMinor;
          sameDatePrecedingBalances.set(l.currency, b);
        }
      }
    }

    const relevantCurrencies = new Set<string>([
      ...page.map((l) => l.currency),
      ...Array.from(sameDatePrecedingBalances.keys()),
    ]);
    if (account.currencyRestriction) {
      relevantCurrencies.add(account.currencyRestriction);
    }

    const runningByCurrency = new Map<string, number>();
    for (const currency of relevantCurrencies) {
      const baseOpening = cumulative.find((b) => b.accountId === args.accountId && b.currency === currency);
      let debit = baseOpening?.debitMinor ?? 0;
      let credit = baseOpening?.creditMinor ?? 0;

      const sameDateB = sameDatePrecedingBalances.get(currency);
      if (sameDateB) {
        debit += sameDateB.debitMinor;
        credit += sameDateB.creditMinor;
      }

      runningByCurrency.set(currency, netOf(debit, credit));
    }
    const openingBalanceByCurrency = new Map(runningByCurrency);

    const totalsByCurrency = new Map<string, { debitMinor: number; creditMinor: number }>();
    const linesWithBalance = page.map((l) => {
      const t = totalsByCurrency.get(l.currency) ?? { debitMinor: 0, creditMinor: 0 };
      t.debitMinor += l.debitMinor;
      t.creditMinor += l.creditMinor;
      totalsByCurrency.set(l.currency, t);

      const running = (runningByCurrency.get(l.currency) ?? 0) + netOf(l.debitMinor, l.creditMinor);
      runningByCurrency.set(l.currency, running);
      return { ...l, runningBalanceMinor: running };
    });

    const currencyBreakdown = Array.from(totalsByCurrency.entries()).map(([currency, t]) => ({
      currency,
      debitMinor: t.debitMinor,
      creditMinor: t.creditMinor,
      netMinor: netOf(t.debitMinor, t.creditMinor),
      openingBalanceMinor: openingBalanceByCurrency.get(currency) ?? 0,
      closingBalanceMinor: runningByCurrency.get(currency) ?? 0,
    }));

    // Legacy single-number fields kept for existing callers, scoped to the
    // account's own restriction currency (or the first currency this page
    // actually saw) when one currency dominates; a genuinely multi-currency
    // account's real per-currency numbers live in `currencyBreakdown`.
    const primaryCurrency = account.currencyRestriction ?? (page[0]?.currency);
    const primary = currencyBreakdown.find((c) => c.currency === primaryCurrency) ?? currencyBreakdown[0];
    const defaultOpening = primaryCurrency ? (openingBalanceByCurrency.get(primaryCurrency) ?? 0) : 0;

    return {
      account,
      lines: linesWithBalance,
      currencyBreakdown,
      totalDebits: primary?.debitMinor ?? 0,
      totalCredits: primary?.creditMinor ?? 0,
      netMinor: primary?.netMinor ?? 0,
      openingBalanceMinor: primary?.openingBalanceMinor ?? defaultOpening,
      closingBalanceMinor: primary?.closingBalanceMinor ?? defaultOpening,
      isDone: linePage.isDone,
      continueCursor: linePage.continueCursor,
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
// The refusal below is deliberately blind to `idempotencyKey`. SCRUM-249 adds a
// reserved key-namespace guard, which answers "may this key be used here" — a
// different question from "may this caller reverse this at all". So the exact
// derived reserved key is refused here for the same reason an invented one is:
// authority is not a spelling.
//
// ⚠️ CORRECTED DURING RC INTEGRATION (SCRUM-313). This comment used to say
// SCRUM-249 was "a separate branch, not an ancestor of this one" and that "no
// such guard exists here". Both were true on the artifact branch and are FALSE
// in the release candidate: 249 is integrated, and its guard lives in
// `reverseAccountingEvent` — this door's callee. The reasoning above survives
// the correction unchanged, and the two guards still never overlap, but they now
// compose on the same call path and the ORDER is worth stating: this wrapper
// refuses a certified receipt BEFORE the engine is entered, so 249's key guard
// is never reached for one. 249's own note records the complement — it
// deliberately does not decide who may reverse a receipt, and points at this
// authority question as an open boundary. This is where it closes.
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
