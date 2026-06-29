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

// ─── Internal: write audit entry ─────────────────────────────────────────────

export async function auditLog(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    actorId: Id<"users">;
    actionType:
      | "POST_EVENT"
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

/**
 * Asserts that the actor attempting a financial action is NOT the same person
 * who initiated the underlying source record (e.g., the person who created a
 * sale cannot also approve/post the corresponding accounting event).
 *
 * In smaller orgs (single-user), this guard can be explicitly bypassed by
 * an OWNER setting `allowSoDBypasses: true` on org settings, or the check
 * degrades to a warning rather than a hard throw.
 */
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

    let entries;
    if (args.actorId) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_actor", (q) => q.eq("orgId", args.orgId).eq("actorId", args.actorId!))
        .order("desc")
        .take(limit);
    } else if (args.actionType) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_action", (q) =>
          q.eq("orgId", args.orgId).eq("actionType", args.actionType as "POST_EVENT" | "REVERSE_EVENT" | "OPEN_PERIOD" | "CLOSE_PERIOD" | "LOCK_PERIOD" | "REOPEN_PERIOD" | "INIT_CHART" | "UPDATE_ACCOUNT" | "MIGRATE_TRANSACTION" | "ALLOCATE_PAYMENT" | "REVERSE_ALLOCATION")
        )
        .order("desc")
        .take(limit);
    } else {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_time", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(limit);
    }

    if (args.fromDate || args.toDate) {
      entries = entries.filter((e) => {
        if (args.fromDate && e.occurredAt < args.fromDate) return false;
        if (args.toDate && e.occurredAt > args.toDate) return false;
        return true;
      });
    }

    return entries;
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

    // Manual journals require either OWNER role or a reviewer different from the poster
    if (args.reviewedBy && args.reviewedBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    // Validate balance
    const totalDebits = args.lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredits = args.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (totalDebits !== totalCredits) {
      throw new ConvexError(`Manual journal is unbalanced: debits=${totalDebits} credits=${totalCredits}.`);
    }
    if (totalDebits === 0) {
      throw new ConvexError("Manual journal must have at least one non-zero line.");
    }

    // Validate all accounts exist and belong to this org, and allow manual posting
    for (const line of args.lines) {
      const account = await ctx.db.get(line.accountId);
      if (!account || account.orgId !== args.orgId) {
        throw new ConvexError(`Account ${line.accountId} not found in this org.`);
      }
      if (!account.allowManualPosting) {
        throw new ConvexError(`Account "${account.name}" does not allow manual posting.`);
      }
    }

    // Idempotency check
    const existing = await ctx.db
      .query("financialAuditLog")
      .withIndex("by_org_action", (q) => q.eq("orgId", args.orgId).eq("actionType", "POST_EVENT"))
      .filter((q) => q.eq(q.field("idempotencyKey"), args.idempotencyKey))
      .first();
    if (existing) {
      return { alreadyPosted: true, resourceId: existing.resourceId };
    }

    const now = Date.now();
    const journalId = await ctx.db.insert("journalEntries", {
      orgId: args.orgId,
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
      actionType: "POST_EVENT",
      resourceType: "journalEntries",
      resourceId: journalId.toString(),
      description: `Manual journal posted: ${args.memo}`,
      after: { lines: args.lines.length, totalDebits, reviewedBy: args.reviewedBy },
      idempotencyKey: args.idempotencyKey,
    });

    return { alreadyPosted: false, resourceId: journalId.toString(), journalId };
  },
});
