import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { DEFAULT_CHART, REQUIRED_SYSTEM_KEYS, SystemKey, SYSTEM_KEYS } from "./utils/defaultChart";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";

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
  // .collect(), not .unique(): this runs on every posting for the org, and a
  // pre-existing org (from before ensureSystemAccount started guarding against
  // duplicate systemKey rows) may still carry more than one row from the old
  // blind self-heal. A hot posting path must never hard-crash on dirty legacy
  // data — deterministically pick the earliest-created ACTIVE row (the
  // original mapping) so every posting keeps resolving to the same account
  // instead of failing or picking randomly. The duplicate itself still needs
  // a one-time cleanup, but that's a data-hygiene task, not a reason to block
  // every future posting until someone gets to it.
  const accounts = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .collect();
  if (accounts.length === 0) {
    throw new ConvexError(
      `System account "${systemKey}" is not mapped for this organization. Initialize the chart of accounts first.`
    );
  }
  const active = accounts.filter((a) => a.active);
  const candidates = active.length > 0 ? active : accounts;
  const account = candidates.reduce((oldest, a) => (a._creationTime < oldest._creationTime ? a : oldest));
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
  // .collect(), not .unique() — see resolveSystemAccount's comment: this runs
  // on the expense-posting hot path and must not crash on a legacy duplicate.
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.GENERAL_EXPENSE)
    )
    .collect();
  if (mapped.length > 0) return;

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
  // .collect(), not .unique() — see resolveSystemAccount's comment: this runs
  // on the sourced-vehicle posting hot path and must not crash on a legacy duplicate.
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)
    )
    .collect();
  if (mapped.length > 0) return;

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
  // .collect(), not .unique(): a legacy duplicate systemKey row (see
  // resolveSystemAccount above) must not crash the self-heal either — the
  // system account already exists in some form, so there's nothing to insert
  // regardless of how many rows currently share the key.
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .collect();
  if (mapped.length > 0) return;

  const now = Date.now();
  const def = DEFAULT_CHART.find((d) => d.code === code)!;

  // Codes are unique within an org (see the `create` mutation). This self-heal
  // used to insert `code` blindly, which — if an org had already created a
  // custom account on one of these reserved codes (e.g. a hand-made 6800) —
  // produced a duplicate code the normal create path would have rejected.
  // `collect()` (not `unique()`) because a chart the old blind-insert already
  // corrupted may hold more than one row on this code; unique() would throw
  // before we could diagnose it.
  const byCode = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", code))
    .collect();

  if (byCode.length > 0) {
    // Already the right system account under a slightly different lookup? done.
    if (byCode.some((a) => a.systemKey === systemKey)) return;
    // Occupied by a *different* system account — cannot silently steal its code.
    const conflictingSystem = byCode.find((a) => a.systemKey && a.systemKey !== systemKey);
    if (conflictingSystem) {
      throw new ConvexError(
        `Chart of accounts conflict: code ${code} is already the "${conflictingSystem.systemKey}" system account, but "${systemKey}" also needs it. Resolve the conflicting code before this posting can proceed.`
      );
    }
    // Only plain custom accounts remain. A shape-compatible one (same
    // type/normalBalance) COULD be adopted as the system account, but doing
    // that silently — as this used to — changes what a manually-created
    // account means without anyone deciding to, and never confirms the
    // account's existing purpose/balance. Block instead and point at the
    // Resolve Conflicts panel (listSystemAccountAdoptionRequests), which
    // detects this same conflict live rather than from a stored row: a
    // mutation that throws rolls back every write it made this call,
    // including an "I found a conflict" row inserted moments earlier — so
    // there is no way to durably persist that fact from inside this call.
    const compatible = byCode.find((a) => a.type === def.type && a.normalBalance === def.normalBalance);
    if (!compatible) {
      const shapes = byCode.map((a) => `${a.type}/${a.normalBalance}`).join(", ");
      throw new ConvexError(
        `Chart of accounts conflict: code ${code} exists as ${shapes}, but system account "${systemKey}" requires ${def.type}/${def.normalBalance}. Move the custom account to a different code.`
      );
    }
    throw new ConvexError(
      `System account "${systemKey}" needs an explicit mapping decision: an existing account (code ${code}) matches its required shape but has never been confirmed as that system account. Go to Accounting > Chart of Accounts > Resolve Conflicts to adopt it or remap it.`
    );
  }

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

/**
 * Self-heal for the dedicated operating-expense accounts: previously every
 * expense category posted to the single GENERAL_EXPENSE account, so any
 * chart initialized before this addition won't have these mapped yet.
 * Scoped to hookExpensePosted only — nothing else resolves these keys.
 */
export async function ensureExpenseCategoryAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.RENT_EXPENSE, "6800");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.UTILITIES_EXPENSE, "6810");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.SALARIES_EXPENSE, "6820");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.MARKETING_EXPENSE, "6830");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.OFFICE_EXPENSE, "6840");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.PROFESSIONAL_FEES_EXPENSE, "6850");
}

/**
 * Self-heal for the Prepaid Expenses asset account: a prepaid expense debits
 * this at payment and releases it to an operating-expense account monthly.
 * Scoped to the prepaid posting + amortization hooks only — nothing else
 * resolves this key.
 */
export async function ensurePrepaidExpensesAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.PREPAID_EXPENSES, "1450");
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

/**
 * Self-heal for the 4 accounts orgs that initialized their chart before
 * dealer-fee/trade-in/warranty/GAP support was added would otherwise be
 * missing. Called from hookSaleCompleted (covers dealer fees + warranty/GAP
 * at sale time) and hookFiCommissionRecognized (covers the monthly
 * recognition posting, which can run long after the sale).
 */
export async function ensureSaleFiAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.DEALER_FEE_INCOME, "4150");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.WARRANTY_GAP_PAYABLE, "2410");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.DEFERRED_FI_COMMISSION, "2420");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.FI_COMMISSION_REVENUE, "4160");
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

// ─── Chart-conflict resolution (explicit mapping instead of silent adopt) ────

/**
 * A shape-compatible, unmapped custom account sitting on a reserved system
 * code, for one (orgId, systemKey) pair — the exact conflict ensureSystemAccount
 * blocks posting on. Read-only and computed fresh every call rather than
 * backed by a stored "pending request" row: a posting mutation that detects
 * this conflict must also throw (to actually block the posting), and a thrown
 * mutation rolls back every write it made in the same call — so a row
 * inserted moments before the throw can never durably persist. Recomputing
 * live is the only way to surface an accurate, up-to-date conflict list.
 */
async function findSystemAccountAdoptionCandidate(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  systemKey: SystemKey,
  code: string
): Promise<Doc<"chartOfAccounts"> | null> {
  const alreadyMapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .first();
  if (alreadyMapped) return null;

  const def = DEFAULT_CHART.find((d) => d.code === code);
  if (!def) return null;

  const byCode = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", code))
    .collect();
  if (byCode.some((a) => a.systemKey)) return null; // occupied by a system account (itself or another key) — not this conflict

  return byCode.find((a) => a.type === def.type && a.normalBalance === def.normalBalance) ?? null;
}

/** Every live system-account adoption conflict for the org, with the candidate account's current details. */
export const listSystemAccountAdoptionRequests = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const defsWithSystemKey = DEFAULT_CHART.filter((d) => !!d.systemKey) as Array<
      typeof DEFAULT_CHART[number] & { systemKey: SystemKey }
    >;
    const results = await Promise.all(
      defsWithSystemKey.map(async (def) => {
        const candidateAccount = await findSystemAccountAdoptionCandidate(ctx, args.orgId, def.systemKey, def.code);
        if (!candidateAccount) return null;
        return { systemKey: def.systemKey, code: def.code, candidateAccount };
      })
    );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

/**
 * Resolves a live adoption conflict. "ADOPT" performs the same mapping the
 * old silent self-heal used to do automatically — tag the candidate account
 * as the system account and normalize its posting-safety flags to the
 * DEFAULT_CHART shape. "REJECT" leaves the candidate account untouched and
 * records nothing; the owner is expected to move it to a different code, at
 * which point the conflict stops appearing on its own (findSystemAccountAdoptionCandidate
 * recomputes live) — otherwise it correctly keeps blocking posting and keeps
 * showing up here, since the underlying conflict genuinely still exists.
 */
export const confirmSystemAccountAdoption = mutation({
  args: {
    orgId: v.id("organizations"),
    systemKey: v.string(),
    decision: v.union(v.literal("ADOPT"), v.literal("REJECT")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const def = DEFAULT_CHART.find((d) => d.systemKey === args.systemKey);
    if (!def) throw new ConvexError(`Unknown system account key "${args.systemKey}".`);

    const candidate = await findSystemAccountAdoptionCandidate(ctx, args.orgId, args.systemKey as SystemKey, def.code);
    if (!candidate) {
      throw new ConvexError("No pending adoption conflict found for this system account — it may already be resolved.");
    }

    const now = Date.now();
    if (args.decision === "ADOPT") {
      await ctx.db.patch(candidate._id, {
        systemKey: args.systemKey as SystemKey,
        active: true,
        isControlAccount: def.isControlAccount,
        allowManualPosting: def.allowManualPosting,
        subtype: def.subtype,
        updatedAt: now,
        updatedBy: user._id,
      });
    }

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "RESOLVE_SYSTEM_ACCOUNT_ADOPTION",
      resourceType: "chartOfAccounts",
      resourceId: candidate._id.toString(),
      description: `${args.decision === "ADOPT" ? "Adopted" : "Rejected"} candidate account (code ${def.code}) as system account "${args.systemKey}".`,
    });

    return null;
  },
});
