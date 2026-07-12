import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { DEFAULT_CHART, REQUIRED_SYSTEM_KEYS, SystemKey, SYSTEM_KEYS } from "./utils/defaultChart";
import { requireFeature } from "./subscriptions";

const accountTypeValidator = v.union(
  v.literal("ASSET"),
  v.literal("LIABILITY"),
  v.literal("EQUITY"),
  v.literal("REVENUE"),
  v.literal("COGS"),
  v.literal("EXPENSE"),
  v.literal("OTHER_INCOME"),
  v.literal("OTHER_EXPENSE"),
);

// ─── Internal helpers ─────────────────────────────────────────────────────────

export async function resolveSystemAccount(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  systemKey: SystemKey
): Promise<Id<"chartOfAccounts">> {
  const account = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .unique();
  if (!account) {
    throw new ConvexError(
      `System account "${systemKey}" is not mapped for this organization. Initialize the chart of accounts first.`
    );
  }
  if (!account.active) {
    throw new ConvexError(`System account "${systemKey}" is inactive.`);
  }
  return account._id;
}

export async function isChartInitialized(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<boolean> {
  const first = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  return first !== null;
}

/**
 * Self-healing backfill for the GENERAL_EXPENSE system account.
 *
 * Charts seeded before GENERAL_EXPENSE was introduced have a "General Expenses"
 * account (code 6300) with no systemKey, so resolveSystemAccount(GENERAL_EXPENSE)
 * would throw and break expense posting. This idempotently maps the system key
 * onto the existing 6300 account (or creates it if missing) the first time an
 * expense posts after deploy — no separate migration run required.
 *
 * Safe to call repeatedly; returns immediately once the key is mapped.
 */
export async function ensureGeneralExpenseAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.GENERAL_EXPENSE)
    )
    .unique();
  if (mapped) return;

  const now = Date.now();
  const byCode = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", "6300"))
    .unique();

  if (byCode) {
    await ctx.db.patch(byCode._id, {
      systemKey: SYSTEM_KEYS.GENERAL_EXPENSE,
      active: true,
      updatedAt: now,
      updatedBy: actorId,
    });
    return;
  }

  const def = DEFAULT_CHART.find((d) => d.code === "6300")!;
  await ctx.db.insert("chartOfAccounts", {
    orgId,
    code: def.code,
    name: def.name,
    nameAr: def.nameAr,
    type: def.type,
    normalBalance: def.normalBalance,
    isControlAccount: def.isControlAccount,
    allowManualPosting: def.allowManualPosting,
    active: true,
    systemKey: SYSTEM_KEYS.GENERAL_EXPENSE,
    subtype: def.subtype,
    createdAt: now,
    createdBy: actorId,
    updatedAt: now,
    updatedBy: actorId,
  });
}

/**
 * Same self-healing backfill pattern as ensureGeneralExpenseAccount, but for
 * the 2400 AP-Vehicle-Suppliers liability account used when posting sourced-
 * vehicle deal completions. Idempotent; no migration needed.
 */
export async function ensureSupplierAPAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)
    )
    .unique();
  if (mapped) return;

  const now = Date.now();
  const byCode = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", "2400"))
    .unique();

  if (byCode) {
    await ctx.db.patch(byCode._id, {
      systemKey: SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS,
      active: true,
      updatedAt: now,
      updatedBy: actorId,
    });
    return;
  }

  const def = DEFAULT_CHART.find((d) => d.code === "2400")!;
  await ctx.db.insert("chartOfAccounts", {
    orgId,
    code: def.code,
    name: def.name,
    nameAr: def.nameAr,
    type: def.type,
    normalBalance: def.normalBalance,
    isControlAccount: def.isControlAccount,
    allowManualPosting: def.allowManualPosting,
    active: true,
    systemKey: SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS,
    subtype: def.subtype,
    createdAt: now,
    createdBy: actorId,
    updatedAt: now,
    updatedBy: actorId,
  });
}

/**
 * Generic version of the ensureGeneralExpenseAccount/ensureSupplierAPAccount
 * pattern: insert the DEFAULT_CHART account for `code` if this org has none
 * mapped to `systemKey` yet. Unlike those two (which had to re-map an
 * existing pre-systemKey account by code), every GL Phase 11 fixed-asset
 * code is brand new, so there's never a pre-existing account to re-map —
 * plain insert-if-missing is sufficient.
 */
async function ensureSystemAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  systemKey: SystemKey,
  code: string
): Promise<void> {
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .unique();
  if (mapped) return;

  const now = Date.now();
  const def = DEFAULT_CHART.find((d) => d.code === code)!;
  await ctx.db.insert("chartOfAccounts", {
    orgId,
    code: def.code,
    name: def.name,
    nameAr: def.nameAr,
    type: def.type,
    normalBalance: def.normalBalance,
    isControlAccount: def.isControlAccount,
    allowManualPosting: def.allowManualPosting,
    active: true,
    systemKey,
    subtype: def.subtype,
    createdAt: now,
    createdBy: actorId,
    updatedAt: now,
    updatedBy: actorId,
  });
}

/**
 * Self-heal for the 6 GL Phase 11 fixed-asset accounts (capitalization,
 * accumulated depreciation, depreciation expense, impairment loss, and
 * gain/loss on disposal). Scoped to be called only from the fixed-asset
 * lifecycle hooks — unlike ensureGeneralExpenseAccount/ensureSupplierAPAccount
 * these accounts are never needed by any other event type, so running this on
 * every unrelated posting event (as postOrEnqueue does for those two) would be
 * wasted work.
 */
export async function ensureFixedAssetAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.FIXED_ASSETS, "1500");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.ACCUMULATED_DEPRECIATION, "1510");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.GAIN_ON_DISPOSAL, "4300");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.DEPRECIATION_EXPENSE, "6400");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.IMPAIRMENT_LOSS, "6500");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.LOSS_ON_DISPOSAL, "6600");
}

/**
 * GL Phase 12 self-heal, scoped to the partner-equity hooks and the legacy
 * migration. Includes RETAINED_EARNINGS since profit distributions debit it
 * and very old charts might predate its arrival in DEFAULT_CHART.
 */
export async function ensurePartnerEquityAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.RETAINED_EARNINGS, "3100");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.PARTNER_CAPITAL, "3200");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.PARTNER_DRAWINGS, "3300");
}

/** GL Phase 13 self-heal: finance-company AR (very old charts may predate it) plus the claim write-off expense account. */
export async function ensureClaimAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, "1210");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.CLAIM_WRITE_OFF_EXPENSE, "6700");
}

/**
 * Phase 41 self-heal: input VAT on expenses/supplier payables debits this
 * account. Scoped to those two posting hooks only, same reasoning as
 * ensureFixedAssetAccounts — no other event type ever needs it.
 */
export async function ensureVatReceivableAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.VAT_RECEIVABLE, "1130");
}

/**
 * Self-heal for the 4400 Other Income account: the default credit side for
 * manually created receivables (collections.createReceivable /
 * createInstallmentPlan) not tied to a vehicle sale. Scoped to that hook only.
 */
export async function ensureMiscIncomeAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.MISCELLANEOUS_INCOME, "4400");
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    type: v.optional(accountTypeValidator),
    activeOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    let q;
    if (args.type) {
      q = ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_type", (q) => q.eq("orgId", args.orgId).eq("type", args.type!));
    } else {
      q = ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId));
    }

    const accounts = await q.collect();
    if (args.activeOnly) return accounts.filter((a) => a.active);
    return accounts;
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId) return null;
    return account;
  },
});

export const isInitialized = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return isChartInitialized(ctx, args.orgId);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const initialize = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    if (await isChartInitialized(ctx, args.orgId)) {
      throw new ConvexError("Chart of accounts is already initialized for this organization.");
    }

    const now = Date.now();
    for (const def of DEFAULT_CHART) {
      await ctx.db.insert("chartOfAccounts", {
        orgId: args.orgId,
        code: def.code,
        name: def.name,
        nameAr: def.nameAr,
        type: def.type,
        normalBalance: def.normalBalance,
        isControlAccount: def.isControlAccount,
        allowManualPosting: def.allowManualPosting,
        active: true,
        systemKey: def.systemKey,
        subtype: def.subtype,
        createdAt: now,
        createdBy: user._id,
        updatedAt: now,
        updatedBy: user._id,
      });
    }

    // Initializing the chart can unblock events enqueued before any chart
    // existed — drain the accounting outbox.
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId: args.orgId,
    });

    return true;
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    code: v.string(),
    name: v.string(),
    nameAr: v.optional(v.string()),
    type: accountTypeValidator,
    subtype: v.optional(v.string()),
    normalBalance: v.union(v.literal("DEBIT"), v.literal("CREDIT")),
    parentAccountId: v.optional(v.id("chartOfAccounts")),
    isControlAccount: v.optional(v.boolean()),
    allowManualPosting: v.optional(v.boolean()),
    currencyRestriction: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const existing = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_code", (q) => q.eq("orgId", args.orgId).eq("code", args.code))
      .unique();
    if (existing) {
      throw new ConvexError(`Account code "${args.code}" already exists in this organization.`);
    }

    if (args.parentAccountId) {
      const parent = await ctx.db.get(args.parentAccountId);
      if (!parent || parent.orgId !== args.orgId) {
        throw new ConvexError("Parent account not found in this organization.");
      }
    }

    const now = Date.now();
    return await ctx.db.insert("chartOfAccounts", {
      orgId: args.orgId,
      code: args.code,
      name: args.name,
      nameAr: args.nameAr,
      type: args.type,
      subtype: args.subtype,
      normalBalance: args.normalBalance,
      parentAccountId: args.parentAccountId,
      isControlAccount: args.isControlAccount ?? false,
      allowManualPosting: args.allowManualPosting ?? true,
      currencyRestriction: args.currencyRestriction,
      active: true,
      createdAt: now,
      createdBy: user._id,
      updatedAt: now,
      updatedBy: user._id,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
    name: v.optional(v.string()),
    nameAr: v.optional(v.string()),
    allowManualPosting: v.optional(v.boolean()),
    active: v.optional(v.boolean()),
    currencyRestriction: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId) {
      throw new ConvexError("Account not found in this organization.");
    }
    if (account.systemKey && args.active === false) {
      throw new ConvexError(`System account "${account.systemKey}" cannot be deactivated.`);
    }

    await ctx.db.patch(args.accountId, {
      updatedAt: Date.now(),
      updatedBy: user._id,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.nameAr !== undefined ? { nameAr: args.nameAr } : {}),
      ...(args.allowManualPosting !== undefined ? { allowManualPosting: args.allowManualPosting } : {}),
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.currencyRestriction !== undefined ? { currencyRestriction: args.currencyRestriction } : {}),
    });
    return args.accountId;
  },
});

export const validateSystemAccounts = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const missing: string[] = [];
    for (const key of REQUIRED_SYSTEM_KEYS) {
      const account = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", args.orgId).eq("systemKey", key))
        .unique();
      if (!account || !account.active) {
        missing.push(key);
      }
    }
    return { valid: missing.length === 0, missing };
  },
});
