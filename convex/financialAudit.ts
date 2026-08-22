/**
 * Phase 7 — Financial audit log + segregation of duties enforcement
 *
 * Every sensitive financial mutation writes an immutable audit log entry.
 * Segregation of duties (SoD) rules are checked before high-risk operations.
 * The audit log itself is append-only: no update or delete mutations are exposed.
 */
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { scaleForCurrency } from "./utils/money";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";

type AuditActionType =
  | "CREATE_PERIOD"
  | "POST_EVENT"
  | "POST_MANUAL_JOURNAL"
  | "CREATE_MANUAL_JOURNAL_DRAFT"
  | "REJECT_MANUAL_JOURNAL"
  | "REVERSE_EVENT"
  | "OPEN_PERIOD"
  | "CLOSE_PERIOD"
  | "LOCK_PERIOD"
  | "REOPEN_PERIOD"
  | "INIT_CHART"
  | "UPDATE_ACCOUNT"
  | "MIGRATE_TRANSACTION"
  | "ALLOCATE_PAYMENT"
  | "REVERSE_ALLOCATION"
  | "IGNORE_BANK_STATEMENT_LINE"
  | "CORRECT_PREPAID_SCHEDULE"
  | "REQUEST_PREPAID_CORRECTION"
  | "APPROVE_PREPAID_CORRECTION"
  | "REJECT_PREPAID_CORRECTION"
  | "RESOLVE_SYSTEM_ACCOUNT_ADOPTION"
  | "ACKNOWLEDGE_CLOSE_WARNINGS"
  | "SET_COMMISSION_AMOUNT"
  // Who decided which car on a multi-vehicle quote carries which share of the
  // reservation deposit, and what happened to a share whose car left the deal.
  // Not a posting — the money does not move — but it decides where a customer's
  // deposit lands, so it is not a decision that may go unrecorded.
  | "ALLOCATE_DEPOSIT"
  | "RESOLVE_DEPOSIT_ALLOCATION"
  // Who decided that a financed consigned deal settles with the supplier
  // directly rather than through the dealership. Like the deposit allocation
  // above it moves no money by itself, and like it, it decides which way the
  // money moves afterwards: whether the dealership ends up owing the supplier
  // his entitlement or holding a claim on him for its margin. The two produce
  // opposite balance sheets from the same sale.
  | "SET_SUPPLIER_SETTLEMENT_ROUTE"
  // The finance company paid the supplier. Recorded as a fact off the
  // settlement advice, with no journal behind it — which is exactly why it
  // needs an audit trail: nothing in the ledger would otherwise show who
  // asserted it, or when.
  | "CONFIRM_SUPPLIER_DISBURSEMENT"
  | "AMEND_SUPPLIER_DISBURSEMENT_ADVICE";

// ─── Internal: write audit entry ─────────────────────────────────────────────

export async function auditLog(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    actorId: Id<"users">;
    actionType: AuditActionType;
    resourceType: string;
    resourceId: string;
    description: string;
    before?: unknown;
    after?: unknown;
    idempotencyKey?: string;
  }
): Promise<void> {
  await ctx.db.insert("financialAuditLog", {
    ...entry,
    occurredAt: Date.now(),
  });
}

// ─── Segregation of duties guard ─────────────────────────────────────────────

export async function checkSegregationOfDuties(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    actorId: Id<"users">;
    priorActorId: Id<"users"> | undefined;
    operationLabel: string;
  }
): Promise<void> {
  if (!args.priorActorId) return;
  if (args.actorId === args.priorActorId) {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const allowBypass = (settings as unknown as { allowSoDBypasses?: boolean })?.allowSoDBypasses ?? false;
    if (!allowBypass) {
      throw new ConvexError(
        `Segregation of duties violation: the same person cannot both initiate and approve ${args.operationLabel}.`
      );
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listAuditLog = query({
  args: {
    orgId: v.id("organizations"),
    actorId: v.optional(v.id("users")),
    actionType: v.optional(v.string()),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const requestedLimit = args.limit ?? 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new ConvexError("limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, 200);
    const actionType = args.actionType as AuditActionType | undefined;

    // When date bounds are specified with the time index we can push the lower
    // bound into the index scan; for actor/action branches we over-fetch and
    // slice to avoid dropping valid matches before the in-memory date filter.
    const fetchLimit = args.fromDate || args.toDate ? limit * 5 : limit;

    let entries;
    if (args.actorId) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_actor", (q) => q.eq("orgId", args.orgId).eq("actorId", args.actorId!))
        .order("desc")
        .take(fetchLimit);
    } else if (actionType) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_action", (q) =>
          q.eq("orgId", args.orgId).eq("actionType", actionType)
        )
        .order("desc")
        .take(fetchLimit);
    } else if (args.fromDate) {
      // Use time index so fromDate is pushed into the scan, not post-filtered.
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_time", (q) =>
          q.eq("orgId", args.orgId).gte("occurredAt", args.fromDate!)
        )
        .order("desc")
        .take(fetchLimit);
    } else {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_time", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(fetchLimit);
    }

    // Apply remaining date bounds in memory (after the index scan).
    if (args.fromDate || args.toDate) {
      entries = entries.filter((e) => {
        if (args.fromDate && e.occurredAt < args.fromDate) return false;
        if (args.toDate && e.occurredAt > args.toDate) return false;
        return true;
      });
    }

    return entries.slice(0, limit);
  },
});

// ─── Manual journal — true two-person approval (phase 10) ───────────────────

const manualJournalLineValidator = v.object({
  accountId: v.id("chartOfAccounts"),
  debitMinor: v.number(),
  creditMinor: v.number(),
  description: v.optional(v.string()),
});

export type ManualJournalLine = {
  accountId: Id<"chartOfAccounts">;
  debitMinor: number;
  creditMinor: number;
  description?: string;
};

// Per-line validation (safe integers, non-negative, exactly one side non-zero)
// plus the overall balance check. Shared by draft creation and approval, since
// approval must not trust that nothing changed since the draft was created.
export function validateManualJournalLines(lines: ManualJournalLine[]): number {
  for (const [idx, line] of lines.entries()) {
    const n = idx + 1;
    if (!Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor)) {
      throw new ConvexError(`Line ${n}: amounts must be integer minor-unit values.`);
    }
    if (line.debitMinor < 0 || line.creditMinor < 0) {
      throw new ConvexError(`Line ${n}: amounts cannot be negative.`);
    }
    if (line.debitMinor > 0 && line.creditMinor > 0) {
      throw new ConvexError(`Line ${n}: a single line cannot have both debit and credit amounts.`);
    }
    if (line.debitMinor === 0 && line.creditMinor === 0) {
      throw new ConvexError(`Line ${n}: must have a non-zero debit or credit amount.`);
    }
  }

  const totalDebits = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCredits = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (totalDebits !== totalCredits) {
    throw new ConvexError(`Manual journal is unbalanced: debits=${totalDebits} credits=${totalCredits}.`);
  }
  if (totalDebits === 0) {
    throw new ConvexError("Manual journal must have at least one non-zero line.");
  }
  return totalDebits;
}

// Validates every account exists, belongs to the org, and allows manual
// posting, and resolves the single currency + minor-unit scale for the
// journal. Re-run at approval time in case an account changed between draft
// creation and approval.
async function resolveManualJournalCurrency(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  lines: ManualJournalLine[]
): Promise<{ currency: string; scale: number }> {
  let journalCurrency: string | null = null;
  for (const line of lines) {
    const account = await ctx.db.get(line.accountId);
    if (!account || account.orgId !== orgId) {
      throw new ConvexError(`Account ${line.accountId} not found in this org.`);
    }
    if (!account.active) {
      throw new ConvexError(`Account "${account.name}" is inactive and cannot be posted to. Reactivate it first or use a different account.`);
    }
    if (!account.allowManualPosting) {
      throw new ConvexError(`Account "${account.name}" does not allow manual posting.`);
    }
    const lineCurrency = account.currencyRestriction ?? null;
    if (journalCurrency === null) {
      journalCurrency = lineCurrency;
    } else if (lineCurrency !== null && lineCurrency !== journalCurrency) {
      throw new ConvexError("All manual journal lines must use the same currency.");
    }
  }

  let effectiveCurrency = journalCurrency;
  if (!effectiveCurrency) {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();
    effectiveCurrency = settings?.currency ?? "JOD";
  }
  return { currency: effectiveCurrency, scale: scaleForCurrency(effectiveCurrency) };
}

/**
 * The accounting date participates in the fingerprint (SCRUM-50).
 *
 * Without it, resubmitting the same adjustment under the same idempotency key
 * for a DIFFERENT month would match the stored draft and silently return it —
 * discarding the new date and posting to the old one. Two adjustments that
 * differ only in which month they belong to are not the same adjustment.
 */
function manualJournalFingerprint(
  memo: string,
  accountingDate: number | undefined,
  lines: ManualJournalLine[]
): string {
  return JSON.stringify({
    memo,
    accountingDate: accountingDate ?? null,
    lines: lines.map((l) => ({ a: l.accountId, d: l.debitMinor, c: l.creditMinor })),
  });
}

/**
 * Convex accepts NaN and Infinity through a `v.number()` validator, and either
 * would sail past `create` and surface at approval as "no accounting period
 * found" — a confusing failure, possibly months later. Refuse at the draft,
 * where the accountant is still looking at the form.
 */
function assertUsableAccountingDate(accountingDate: number): void {
  if (!Number.isFinite(accountingDate)) {
    throw new ConvexError("A manual journal needs a usable accounting date.");
  }
}

export const createManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    memo: v.string(),
    /**
     * The date the adjustment belongs to. Required, and never defaulted — a
     * manual journal with an implicit date is the SCRUM-50 defect.
     */
    accountingDate: v.number(),
    lines: v.array(manualJournalLineValidator),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    assertUsableAccountingDate(args.accountingDate);
    validateManualJournalLines(args.lines);
    await resolveManualJournalCurrency(ctx, args.orgId, args.lines);

    const fingerprint = manualJournalFingerprint(args.memo, args.accountingDate, args.lines);
    const existing = await ctx.db
      .query("manualJournalDrafts")
      .withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
      )
      .first();
    if (existing) {
      const priorFingerprint = manualJournalFingerprint(
        existing.memo,
        existing.accountingDate,
        existing.lines
      );
      if (priorFingerprint !== fingerprint) {
        throw new ConvexError("Idempotency key reused with different journal content.");
      }
      return { alreadyCreated: true, draftId: existing._id };
    }

    const now = Date.now();
    const draftId = await ctx.db.insert("manualJournalDrafts", {
      orgId: args.orgId,
      status: "PENDING_APPROVAL",
      memo: args.memo,
      accountingDate: args.accountingDate,
      lines: args.lines,
      idempotencyKey: args.idempotencyKey,
      createdBy: user._id,
      createdAt: now,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "CREATE_MANUAL_JOURNAL_DRAFT",
      resourceType: "manualJournalDrafts",
      resourceId: draftId.toString(),
      description: `Manual journal draft submitted for approval: ${args.memo}`,
      after: { lines: args.lines.length },
      idempotencyKey: args.idempotencyKey,
    });

    return { alreadyCreated: false, draftId };
  },
});

export const approveManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("manualJournalDrafts"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Manual journal draft not found.");
    }
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This manual journal has already been resolved.");
    }
    // Segregation of duties: the approver must be a different, finance-authorized
    // person from whoever created the draft. Deliberately hardcoded rather than
    // routed through checkSegregationOfDuties/orgSettings.allowSoDBypasses — a
    // manual journal is an arbitrary, unrestricted GL posting (the highest-risk
    // financial control point), and this is the exact check Phase 10 exists to
    // make unbypassable, unlike lower-risk SoD checks elsewhere that orgs may
    // opt out of.
    if (draft.createdBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    const totalDebits = validateManualJournalLines(draft.lines);
    const { currency: effectiveCurrency, scale: journalScale } =
      await resolveManualJournalCurrency(ctx, args.orgId, draft.lines);

    const now = Date.now();

    // The date the adjustment belongs to — NOT approval time (SCRUM-50).
    //
    // This used to be `now` for all three of: the period lookup, the entry's
    // accountingDate, and every line's. A June 30 accrual approved on July 2
    // landed in July, and reopening June could not help because the lookup
    // never consulted the draft. Approval time survives below as `postedAt` and
    // `decidedAt`, which is what it always was: audit metadata.
    //
    // A draft written before the field existed is refused rather than defaulted.
    // Substituting `now` here is exactly the defect, and a legacy draft's real
    // date is not knowable from anything stored — only the accountant has it.
    const accountingDate = draft.accountingDate;
    if (accountingDate === undefined || !Number.isFinite(accountingDate)) {
      throw new ConvexError(
        "This manual journal has no accounting date, so it cannot be posted. " +
          "Reject it and submit a replacement stating the date the adjustment belongs to."
      );
    }

    // The period covering the TARGET date, revalidated here rather than trusted
    // from draft time — a month can close between drafting and approval, and it
    // is approval that posts. Inline to avoid a circular import with
    // accountingPeriods.ts.
    const period = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_startDate", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.and(
          q.lte(q.field("startDate"), accountingDate),
          q.gte(q.field("endDate"), accountingDate)
        )
      )
      .first();
    if (!period) {
      throw new ConvexError(
        "No accounting period covers this journal's accounting date. Create and open one first."
      );
    }
    if (period.status === "CLOSED" || period.status === "LOCKED") {
      throw new ConvexError(`Accounting period is ${period.status}. Manual journal posting not allowed.`);
    }
    if (period.status === "FUTURE") {
      throw new ConvexError("Accounting period has not been opened yet.");
    }

    const journalId = await ctx.db.insert("journalEntries", {
      orgId: args.orgId,
      periodId: period._id,
      journalNumber: "MJ-pending",
      accountingDate,
      sourceType: "manual",
      sourceId: draft.createdBy.toString(),
      category: "MANUAL",
      memo: draft.memo,
      status: "POSTED",
      postedBy: user._id,
      postedAt: now,
      createdAt: now,
    });
    // Derive journal number from the inserted record ID — guaranteed unique
    const journalNumber = `MJ-${journalId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
    await ctx.db.patch(journalId, { journalNumber });

    for (let i = 0; i < draft.lines.length; i++) {
      const line = draft.lines[i];
      await ctx.db.insert("journalLines", {
        orgId: args.orgId,
        journalEntryId: journalId,
        lineNumber: i + 1,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: effectiveCurrency,
        scale: journalScale,
        // The lines are what the dated reports read, so an entry stamped
        // correctly with lines saying "today" would still misstate the month.
        accountingDate,
        description: line.description,
      });
      // GL Phase 18: a direct journalLines insert (not routed through
      // postAccountingEvent), so the running snapshot needs its own update
      // here too — same as postingEngine.ts, reversals.ts, and
      // accountingCutover.ts's approveOpeningBalance.
      await incrementAccountSnapshot(ctx, {
        orgId: args.orgId,
        accountId: line.accountId,
        currency: effectiveCurrency,
        periodId: period._id,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      });
    }

    await ctx.db.patch(draft._id, {
      status: "POSTED",
      reviewedBy: user._id,
      decidedAt: now,
      journalEntryId: journalId,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_MANUAL_JOURNAL",
      resourceType: "journalEntries",
      resourceId: journalId.toString(),
      description: `Manual journal posted: ${draft.memo}`,
      after: { lines: draft.lines.length, totalDebits, createdBy: draft.createdBy, draftId: draft._id },
    });

    return { resourceId: journalId.toString(), journalId };
  },
});

export const rejectManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("manualJournalDrafts"),
    rejectionReason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!args.rejectionReason.trim()) {
      throw new ConvexError("A rejection reason is required.");
    }

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Manual journal draft not found.");
    }
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This manual journal has already been resolved.");
    }
    // See the matching check in approveManualJournal for why this is hardcoded
    // rather than routed through checkSegregationOfDuties/allowSoDBypasses.
    if (draft.createdBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    const now = Date.now();
    await ctx.db.patch(draft._id, {
      status: "REJECTED",
      reviewedBy: user._id,
      decidedAt: now,
      rejectionReason: args.rejectionReason,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "REJECT_MANUAL_JOURNAL",
      resourceType: "manualJournalDrafts",
      resourceId: draft._id.toString(),
      description: `Manual journal rejected: ${draft.memo} — ${args.rejectionReason}`,
      after: { createdBy: draft.createdBy, rejectionReason: args.rejectionReason },
    });
  },
});

export const listPendingManualJournals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const drafts = await ctx.db
      .query("manualJournalDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .order("desc")
      .collect();

    return Promise.all(
      drafts.map(async (draft) => {
        const creator = await ctx.db.get(draft.createdBy);
        return {
          ...draft,
          creatorName: creator?.name || creator?.email || "Unknown",
        };
      })
    );
  },
});
