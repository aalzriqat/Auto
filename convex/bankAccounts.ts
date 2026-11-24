// One GL bank control serves every physical bank. The balance reader attributes
// its journal lines by physical bank; openingBalanceMinor is reference metadata.
import { v, ConvexError } from "convex/values";
import { query, MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { computeBankOpeningReconciliation } from "./accounting/bankOpeningReconciliation";
import { BOOK_BALANCE_READ_BUDGET, computeBankBalances, computeBookBalance } from "./accounting/bankBookBalances";

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

    if (!Number.isSafeInteger(args.openingBalanceMinor) || !Number.isSafeInteger(args.openingBalanceDate) ||
        Math.abs(args.openingBalanceDate) > 8_640_000_000_000_000) {
      throw new ConvexError("Enter a valid stated bank balance and statement date.");
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
    const notFound = "Bank account not found in this organization.";
    const account = await requireOwnedRow(ctx, args.orgId, "bankAccounts", args.bankAccountId, notFound);
    if (account.isDeleted) throw new ConvexError(notFound);
    const reservation = await ctx.db.query("deposits")
      .withIndex("by_org_refund_bank", q => q.eq("orgId", args.orgId).eq("openingRefundReservation.bankAccountId", account._id))
      .first();
    if (reservation) throw new ConvexError("Settle or cancel the opening deposit refunds reserved against this bank account first.");
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
 * The control account's own cumulative total (elapsed periods from that
 * account's snapshots; the containing period from its snapshot only while it is
 * certified and has no later-dated entry, otherwise from that period's POSTED or
 * REVERSED entries dated on or before asOf and their lines, as the shared
 * reader selects them) must be
 * fully explained by identified lines, and no relevant line may lack a known
 * same-org bank (even when its net is zero). Otherwise the balance is withheld
 * (`balanceMinor: null`), never inferred by amount/date and never assigned to
 * the target. `unmatchedMinor` is a net diagnostic; `unattributedLineCount`
 * distinguishes net-zero unattributed activity.
 *
 * Every read spends one shared document budget (see `computeBookBalance`). When
 * it is exhausted, or a control line disagrees with its entry's date or period,
 * the status is `BALANCE_HISTORY_INCOMPLETE` with a null balance and null
 * diagnostics: the history could not be verified, so it is never reported OK.
 */
export const getBookBalance = query({
  args: {
    orgId: v.id("organizations"),
    asOf: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await computeBookBalance(ctx, args.orgId, args.asOf ?? Date.now(), BOOK_BALANCE_READ_BUDGET);
  },
});

/**
 * SCRUM-858 S5 (owner ruling c23884): per-bank opening reconciliation. Each bank's posted opening line against the
 * balance the dealer stated for it, the Σ of bank lines against the bank control's opening debit, and any
 * difference under the owner's label. Read-only: it posts nothing and changes no balance.
 */
export const openingReconciliation = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({
    status: v.union(v.literal("OK"), v.literal("NO_OPENING"), v.literal("OPENING_PROOF_UNAVAILABLE")),
    currency: v.union(v.string(), v.null()),
    asOfDate: v.union(v.number(), v.null()),
    banks: v.array(v.object({
      bankAccountId: v.id("bankAccounts"),
      name: v.string(),
      currency: v.string(),
      openingLineMinor: v.union(v.number(), v.null()),
      referenceOpeningMinor: v.number(),
      differenceMinor: v.union(v.number(), v.null()),
      referenceAfterOpening: v.optional(v.literal(true)),
      referenceNotComparable: v.optional(v.literal(true)),
    })),
    controlOpeningMinor: v.union(v.number(), v.null()),
    bankLinesTotalMinor: v.union(v.number(), v.null()),
    unattributedOpeningMinor: v.union(v.number(), v.null()),
    unexplainedOpeningDifference: v.union(v.object({
      label: v.object({ en: v.string(), ar: v.string() }),
      currencies: v.array(v.object({
        currency: v.string(),
        differenceMinor: v.number(),
        absoluteDifferenceMinor: v.number(),
      })),
    }), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await computeBankOpeningReconciliation(ctx, args.orgId);
  },
});

const bankBalanceStatus = v.union(
  v.literal("OK"), v.literal("UNATTRIBUTED_GL_ACTIVITY"), v.literal("BALANCE_HISTORY_INCOMPLETE"),
);

const bankBalanceFields = {
  bankAccountId: v.union(v.id("bankAccounts"), v.null()),
  name: v.union(v.string(), v.null()),
  currency: v.union(v.string(), v.null()),
  asOf: v.number(),
  status: bankBalanceStatus,
  balanceMinor: v.union(v.number(), v.null()),
  unmatchedMinor: v.union(v.number(), v.null()),
  unattributedLineCount: v.union(v.number(), v.null()),
};

export const listBookBalances = query({
  args: { orgId: v.id("organizations") },
  returns: v.array(v.object({ ...bankBalanceFields, isDeleted: v.boolean() })),
  handler: async (ctx, { orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await computeBankBalances(ctx, orgId, Date.now(), BOOK_BALANCE_READ_BUDGET);
  },
});
