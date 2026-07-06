/**
 * Phase 41 — Bank Reconciliation
 *
 * Matches uploaded bank-statement lines against posted journalLines on the
 * single SYSTEM_KEYS.BANK_ACCOUNT control account (org-wide — day-to-day
 * postings don't carry a per-bank-account tag, so this is only meaningful
 * for the org's reconciliation-target account; see convex/bankAccounts.ts).
 * Matching only ever suggests candidates — confirmMatch always requires an
 * explicit user click, never auto-applies.
 */
import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { resolveSystemAccount } from "./chartOfAccounts";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { getPostedLines } from "./accountingReports";

const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_WINDOW_DAYS = 10;

export const uploadStatementLines = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    rows: v.array(
      v.object({
        statementDate: v.number(),
        description: v.string(),
        amountMinor: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const bankAccount = await ctx.db.get(args.bankAccountId);
    if (!bankAccount || bankAccount.orgId !== args.orgId || bankAccount.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    if (args.rows.length === 0) {
      throw new ConvexError("The uploaded statement has no rows to import.");
    }

    const importBatchId = crypto.randomUUID();
    const now = Date.now();
    for (const row of args.rows) {
      await ctx.db.insert("bankStatementLines", {
        orgId: args.orgId,
        bankAccountId: args.bankAccountId,
        importBatchId,
        statementDate: row.statementDate,
        description: row.description,
        amountMinor: row.amountMinor,
        status: "UNMATCHED",
        createdAt: now,
        createdBy: user._id,
      });
    }
    return { importBatchId, count: args.rows.length };
  },
});

export const listStatementLines = query({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    status: v.optional(v.union(v.literal("UNMATCHED"), v.literal("MATCHED"), v.literal("IGNORED"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const lines = await ctx.db
      .query("bankStatementLines")
      .withIndex("by_org_bankAccount", (q) => q.eq("orgId", args.orgId).eq("bankAccountId", args.bankAccountId))
      .collect();
    return args.status ? lines.filter((l) => l.status === args.status) : lines;
  },
});

/**
 * For each unmatched statement line, scores candidate posted journalLines on
 * the BANK_ACCOUNT control account by exact-amount + date-proximity, same
 * score/no-guess-on-ambiguity shape as convex/utils/vehicleTextMatch.ts.
 * Amount match is required (not scored) — a statement line's signed
 * amountMinor must equal a journal line's (debitMinor - creditMinor).
 */
export const suggestMatches = query({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const unmatched = (
      await ctx.db
        .query("bankStatementLines")
        .withIndex("by_org_bankAccount", (q) => q.eq("orgId", args.orgId).eq("bankAccountId", args.bankAccountId))
        .collect()
    ).filter((l) => l.status === "UNMATCHED");
    if (unmatched.length === 0) return [];

    const alreadyClaimed = new Set(
      (
        await ctx.db
          .query("bankStatementLines")
          .withIndex("by_org_bankAccount", (q) => q.eq("orgId", args.orgId).eq("bankAccountId", args.bankAccountId))
          .collect()
      )
        .filter((l) => l.status === "MATCHED" && l.matchedJournalLineId)
        .map((l) => l.matchedJournalLineId!.toString())
    );

    const bankChartAccountId = await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.BANK_ACCOUNT);
    const dates = unmatched.map((l) => l.statementDate);
    const fromDate = Math.min(...dates) - MATCH_WINDOW_DAYS * DAY_MS;
    const toDate = Math.max(...dates) + MATCH_WINDOW_DAYS * DAY_MS;
    const candidateLines = (await getPostedLines(ctx, args.orgId, fromDate, toDate)).filter(
      (l) => l.accountId === bankChartAccountId && !alreadyClaimed.has(l._id.toString())
    );

    const entryIds = [...new Set(candidateLines.map((l) => l.journalEntryId))];
    const entries = await Promise.all(entryIds.map((id) => ctx.db.get(id)));
    const entryMemoById = new Map(
      entries
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => [e._id.toString(), e.memo])
    );

    return unmatched.map((statementLine) => {
      const scored = candidateLines
        .map((journalLine) => {
          const netMinor = journalLine.debitMinor - journalLine.creditMinor;
          if (netMinor !== statementLine.amountMinor) return null;
          const daysDiff = Math.abs(journalLine.accountingDate - statementLine.statementDate) / DAY_MS;
          if (daysDiff > MATCH_WINDOW_DAYS) return null;
          const score = 10 + Math.max(0, MATCH_WINDOW_DAYS - daysDiff);
          return {
            journalLineId: journalLine._id,
            accountingDate: journalLine.accountingDate,
            amountMinor: netMinor,
            memo: entryMemoById.get(journalLine.journalEntryId.toString()) ?? "",
            score,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => b.score - a.score);

      const suggestedJournalLineId =
        scored.length > 0 && (scored.length === 1 || scored[0].score > scored[1].score)
          ? scored[0].journalLineId
          : undefined;

      return {
        statementLineId: statementLine._id,
        statementDate: statementLine.statementDate,
        description: statementLine.description,
        amountMinor: statementLine.amountMinor,
        candidates: scored.slice(0, 5),
        suggestedJournalLineId,
      };
    });
  },
});

async function assertBankAccountActive(ctx: MutationCtx, orgId: Id<"organizations">, bankAccountId: Id<"bankAccounts">) {
  const bankAccount = await ctx.db.get(bankAccountId);
  if (!bankAccount || bankAccount.orgId !== orgId || bankAccount.isDeleted) {
    throw new ConvexError("This bank account is no longer active.");
  }
}

export const confirmMatch = mutation({
  args: {
    orgId: v.id("organizations"),
    statementLineId: v.id("bankStatementLines"),
    journalLineId: v.id("journalLines"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const statementLine = await ctx.db.get(args.statementLineId);
    if (!statementLine || statementLine.orgId !== args.orgId) {
      throw new ConvexError("Statement line not found.");
    }
    await assertBankAccountActive(ctx, args.orgId, statementLine.bankAccountId);
    if (statementLine.status !== "UNMATCHED") {
      throw new ConvexError("This statement line is no longer unmatched.");
    }

    const journalLine = await ctx.db.get(args.journalLineId);
    if (!journalLine || journalLine.orgId !== args.orgId) {
      throw new ConvexError("Ledger line not found.");
    }

    // Guard against double-claiming the same ledger line from two statement
    // lines — read-then-write is safe under Convex's OCC within one mutation.
    const claimedBy = await ctx.db
      .query("bankStatementLines")
      .withIndex("by_matched_journal_line", (q) => q.eq("matchedJournalLineId", args.journalLineId))
      .first();
    if (claimedBy) {
      throw new ConvexError("This ledger line has already been matched to another statement line.");
    }

    await ctx.db.patch(args.statementLineId, {
      status: "MATCHED",
      matchedJournalLineId: args.journalLineId,
      matchedAt: Date.now(),
      matchedBy: user._id,
    });
  },
});

export const unmatch = mutation({
  args: {
    orgId: v.id("organizations"),
    statementLineId: v.id("bankStatementLines"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const statementLine = await ctx.db.get(args.statementLineId);
    if (!statementLine || statementLine.orgId !== args.orgId) {
      throw new ConvexError("Statement line not found.");
    }
    await assertBankAccountActive(ctx, args.orgId, statementLine.bankAccountId);
    await ctx.db.patch(args.statementLineId, {
      status: "UNMATCHED",
      matchedJournalLineId: undefined,
      matchedAt: undefined,
      matchedBy: undefined,
    });
  },
});

export const ignoreLine = mutation({
  args: {
    orgId: v.id("organizations"),
    statementLineId: v.id("bankStatementLines"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const statementLine = await ctx.db.get(args.statementLineId);
    if (!statementLine || statementLine.orgId !== args.orgId) {
      throw new ConvexError("Statement line not found.");
    }
    await assertBankAccountActive(ctx, args.orgId, statementLine.bankAccountId);
    if (statementLine.status === "MATCHED") {
      throw new ConvexError("Unmatch this line before ignoring it.");
    }
    await ctx.db.patch(args.statementLineId, { status: "IGNORED" });
  },
});
