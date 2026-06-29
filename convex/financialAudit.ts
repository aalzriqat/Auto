/**
 * Phase 7 — Financial audit log + segregation of duties enforcement
 *
 * Every sensitive financial mutation writes an immutable audit log entry.
 * Segregation of duties (SoD) rules are checked before high-risk operations.
 * The audit log itself is append-only: no update or delete mutations are exposed.
 */
import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

type AuditActionType =
  | "CREATE_PERIOD"
  | "POST_EVENT"
  | "POST_MANUAL_JOURNAL"
  | "REVERSE_EVENT"
  | "OPEN_PERIOD"
  | "CLOSE_PERIOD"
  | "LOCK_PERIOD"
  | "REOPEN_PERIOD"
  | "INIT_CHART"
  | "UPDATE_ACCOUNT"
  | "MIGRATE_TRANSACTION"
  | "ALLOCATE_PAYMENT"
  | "REVERSE_ALLOCATION";

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
    const limit = Math.min(args.limit ?? 50, 200);
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

// ─── Manual journal (phase 7 gate) ───────────────────────────────────────────

export const postManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    memo: v.string(),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    idempotencyKey: v.string(),
    reviewedBy: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    // SoD: reviewer cannot be the same person as poster
    if (args.reviewedBy && args.reviewedBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    // Reviewer must be a valid org member (server-side verification)
    if (args.reviewedBy) {
      const reviewerMembership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", args.reviewedBy!)
        )
        .first();
      if (!reviewerMembership) {
        throw new ConvexError("Reviewer is not a member of this organization.");
      }
    }

    // Per-line validation: safe integers, non-negative, exactly one side non-zero
    for (const [idx, line] of args.lines.entries()) {
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

    // Balance validation
    const totalDebits = args.lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredits = args.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (totalDebits !== totalCredits) {
      throw new ConvexError(`Manual journal is unbalanced: debits=${totalDebits} credits=${totalCredits}.`);
    }
    if (totalDebits === 0) {
      throw new ConvexError("Manual journal must have at least one non-zero line.");
    }

    // Validate all accounts exist, belong to this org, and allow manual posting
    for (const line of args.lines) {
      const account = await ctx.db.get(line.accountId);
      if (!account || account.orgId !== args.orgId) {
        throw new ConvexError(`Account ${line.accountId} not found in this org.`);
      }
      if (!account.allowManualPosting) {
        throw new ConvexError(`Account "${account.name}" does not allow manual posting.`);
      }
    }

    // Idempotency: namespaced under POST_MANUAL_JOURNAL to avoid collisions with POST_EVENT
    const existing = await ctx.db
      .query("financialAuditLog")
      .withIndex("by_org_action_idempotency", (q) =>
        q.eq("orgId", args.orgId).eq("actionType", "POST_MANUAL_JOURNAL").eq("idempotencyKey", args.idempotencyKey)
      )
      .first();
    if (existing) {
      return { alreadyPosted: true, resourceId: existing.resourceId };
    }

    const now = Date.now();

    // Verify an open period covers today; inline to avoid circular import with accountingPeriods.ts
    const period = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_startDate", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.and(q.lte(q.field("startDate"), now), q.gte(q.field("endDate"), now))
      )
      .first();
    if (!period) {
      throw new ConvexError("No accounting period found for today. Create and open a period first.");
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
      journalNumber: `MJ-${now.toString().slice(-8)}`,
      accountingDate: now,
      sourceType: "manual",
      sourceId: user._id.toString(),
      category: "MANUAL",
      memo: args.memo,
      status: "POSTED",
      postedBy: user._id,
      postedAt: now,
      createdAt: now,
    });

    for (let i = 0; i < args.lines.length; i++) {
      const line = args.lines[i];
      const account = await ctx.db.get(line.accountId);
      await ctx.db.insert("journalLines", {
        orgId: args.orgId,
        journalEntryId: journalId,
        lineNumber: i + 1,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: account?.currencyRestriction ?? "JOD",
        scale: 3,
        accountingDate: now,
        description: line.description,
      });
    }

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_MANUAL_JOURNAL",
      resourceType: "journalEntries",
      resourceId: journalId.toString(),
      description: `Manual journal posted: ${args.memo}`,
      after: { lines: args.lines.length, totalDebits, reviewedBy: args.reviewedBy },
      idempotencyKey: args.idempotencyKey,
    });

    return { alreadyPosted: false, resourceId: journalId.toString(), journalId };
  },
});
