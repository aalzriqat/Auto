/**
 * Phase 41 — Bank Accounts
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts — there remains exactly one SYSTEM_KEYS.BANK_ACCOUNT control
 * account (see convex/utils/defaultChart.ts). Only one bank account per org
 * may be the reconciliation target; its "book balance" is derived from the
 * GL at query time (see getBookBalance), never posted as a journal entry, so
 * this file never touches the posting engine. `openingBalanceMinor` is
 * reference metadata only.
 */
import { v, ConvexError } from "convex/values";
import { query, MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { resolveSystemAccount } from "./chartOfAccounts";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { NO_ACCOUNTING_DATE_SENTINEL } from "./accountingReports";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const accounts = await ctx.db
      .query("bankAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return accounts.filter((a) => !a.isDeleted);
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    currency: v.string(),
    openingBalanceMinor: v.number(),
    openingBalanceDate: v.number(),
    isReconciliationTarget: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const now = Date.now();

    if (!Number.isFinite(args.openingBalanceMinor) || !Number.isFinite(args.openingBalanceDate)) {
      throw new ConvexError("Opening balance and date must be valid numbers.");
    }

    if (args.isReconciliationTarget) {
      await clearOtherReconciliationTargets(ctx, args.orgId);
    }

    return await ctx.db.insert("bankAccounts", {
      orgId: args.orgId,
      name: args.name,
      bankName: args.bankName,
      iban: args.iban,
      accountNumber: args.accountNumber,
      currency: args.currency,
      openingBalanceMinor: args.openingBalanceMinor,
      openingBalanceDate: args.openingBalanceDate,
      isActive: true,
      isReconciliationTarget: args.isReconciliationTarget ?? false,
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    name: v.optional(v.string()),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    openingBalanceMinor: v.optional(v.number()),
    openingBalanceDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    if (args.openingBalanceMinor !== undefined && !Number.isFinite(args.openingBalanceMinor)) {
      throw new ConvexError("Opening balance must be a valid number.");
    }
    if (args.openingBalanceDate !== undefined && !Number.isFinite(args.openingBalanceDate)) {
      throw new ConvexError("Opening balance date must be a valid number.");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.bankName !== undefined) patch.bankName = args.bankName;
    if (args.iban !== undefined) patch.iban = args.iban;
    if (args.accountNumber !== undefined) patch.accountNumber = args.accountNumber;
    if (args.openingBalanceMinor !== undefined) patch.openingBalanceMinor = args.openingBalanceMinor;
    if (args.openingBalanceDate !== undefined) patch.openingBalanceDate = args.openingBalanceDate;
    if (args.notes !== undefined) patch.notes = args.notes;

    await ctx.db.patch(args.bankAccountId, patch);
  },
});

async function clearOtherReconciliationTargets(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  exceptId?: Id<"bankAccounts">
) {
  const accounts = await ctx.db
    .query("bankAccounts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  for (const account of accounts) {
    if (account.isReconciliationTarget && account._id !== exceptId) {
      await ctx.db.patch(account._id, { isReconciliationTarget: false, updatedAt: Date.now() });
    }
  }
}

export const setReconciliationTarget = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    await clearOtherReconciliationTargets(ctx, args.orgId, args.bankAccountId);
    await ctx.db.patch(args.bankAccountId, { isReconciliationTarget: true, updatedAt: Date.now() });
  },
});

export const deactivate = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    await ctx.db.patch(args.bankAccountId, {
      isActive: false,
      isReconciliationTarget: false,
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: user._id.toString(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Book balance for the org's reconciliation-target bank account (SCRUM-54).
 * The GL is the sole authority: the balance is the cumulative net of the
 * BANK_ACCOUNT control lines whose journal line names this physical bank
 * (`bankAccountId`). `openingBalanceMinor` is reference metadata and is never
 * added — an opening already posted to the GL would be counted twice.
 *
 * The control account's snapshot-aware cumulative total (closed periods read
 * from snapshots) must be fully explained by identified lines, and no
 * relevant line may lack a known same-org bank (even when its net is zero).
 * Otherwise the balance is withheld (`balanceMinor: null`), never inferred
 * by amount/date and never assigned to the target. `unmatchedMinor` is a net
 * diagnostic; `unattributedLineCount` distinguishes net-zero unattributed
 * activity.
 */
export const getBookBalance = query({
  args: {
    orgId: v.id("organizations"),
    asOf: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const accounts = await ctx.db
      .query("bankAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const target = accounts.find((a) => a.isReconciliationTarget && !a.isDeleted);
    if (!target) return null;

    const bankChartAccountId = await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.BANK_ACCOUNT);
    const asOf = args.asOf ?? Date.now();

    // Authoritative control total for this currency (BANK_ACCOUNT is a
    // DEBIT-normal asset — debits increase the balance).
    const cumulative = await getCumulativeBalancesAsOf(ctx, args.orgId, asOf);
    let controlNetMinor = 0;
    for (const b of cumulative) {
      if (b.accountId === bankChartAccountId && b.currency === target.currency) {
        controlNetMinor += b.debitMinor - b.creditMinor;
      }
    }

    // Valid attribution = a same-org bank (deleted banks still own their
    // history) in the line's own currency; a JOD line naming a USD bank is
    // not a physical identity for that line.
    const bankCurrencyById = new Map<string, string>(accounts.map((a) => [a._id, a.currency]));
    // Only the control account's own lines, bounded by date on the index
    // (the -1 "no date" sentinel is excluded, as in getPostedLines).
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account_date", (q) =>
        q
          .eq("orgId", args.orgId)
          .eq("accountId", bankChartAccountId)
          .gt("accountingDate", NO_ACCOUNTING_DATE_SENTINEL)
          .lte("accountingDate", asOf)
      )
      .collect();
    // Draft/validated entries are not ledger activity; REVERSED originals are
    // (their reversal is a separate entry). One lookup per entry.
    const countsAsLedger = new Map<string, boolean>();
    let targetNetMinor = 0;
    let identifiedNetMinor = 0;
    // Counted by line, not by net: equal-and-opposite unidentified lines net
    // to zero but are still activity with no physical bank behind it.
    let unattributedLineCount = 0;
    for (const line of lines) {
      if (line.currency !== target.currency) continue;
      let counts = countsAsLedger.get(line.journalEntryId);
      if (counts === undefined) {
        const entry = await ctx.db.get(line.journalEntryId);
        counts = entry?.status === "POSTED" || entry?.status === "REVERSED";
        countsAsLedger.set(line.journalEntryId, counts);
      }
      if (!counts) continue;
      if (!line.bankAccountId || bankCurrencyById.get(line.bankAccountId) !== line.currency) {
        unattributedLineCount += 1;
        continue;
      }
      const netMinor = line.debitMinor - line.creditMinor;
      identifiedNetMinor += netMinor;
      if (line.bankAccountId === target._id) targetNetMinor += netMinor;
    }

    const base = { bankAccountId: target._id, name: target.name, currency: target.currency, asOf };
    const unmatchedMinor = controlNetMinor - identifiedNetMinor;
    if (unmatchedMinor !== 0 || unattributedLineCount > 0) {
      return {
        ...base,
        status: "UNATTRIBUTED_GL_ACTIVITY" as const,
        balanceMinor: null,
        unmatchedMinor,
        unattributedLineCount,
      };
    }
    return { ...base, status: "OK" as const, balanceMinor: targetNetMinor, unmatchedMinor: 0, unattributedLineCount: 0 };
  },
});
