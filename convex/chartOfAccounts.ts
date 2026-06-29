import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { DEFAULT_CHART, REQUIRED_SYSTEM_KEYS, SystemKey } from "./utils/defaultChart";

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

// ─── Queries ──────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    type: v.optional(accountTypeValidator),
    activeOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId) return null;
    return account;
  },
});

export const isInitialized = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    return isChartInitialized(ctx, args.orgId);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const initialize = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

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
