
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { DEFAULT_CHART, REQUIRED_SYSTEM_KEYS, SystemKey, SYSTEM_KEYS } from "./utils/defaultChart";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";
import { NORMAL_BALANCE_BY_ACCOUNT_TYPE } from "../lib/accounting/accountNormalBalance";
import { isChartInitialized } from "./accounting/chartAccountsRead";
import { ensureSystemAccount } from "./accounting/chartAccountsProvision";

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

export {
  resolveSystemAccount,
  isChartInitialized,
  isSystemAccountMapped,
  DEAL_CUSTODY_ACCOUNT_CODES,
  dealCustodyAccountingReadiness,
} from "./accounting/chartAccountsRead";
export { ensureGeneralExpenseAccount, ensureSupplierAPAccount } from "./accounting/chartLegacyAccounts";
export {
  ensureFixedAssetAccounts,
  ensureOpeningSuspenseAccount,
  ensurePartnerEquityAccounts,
  ensureExpenseCategoryAccounts,
  ensurePrepaidExpensesAccount,
  ensureClaimAccounts,
  ensurePayrollAccounts,
  ensureCommissionAccounts,
  ensureVatReceivableAccount,
  ensureMiscIncomeAccount,
  ensureSaleFiAccounts,
  ensureConsignmentAccounts,
  ensureFinancedSettlementAccounts,
  ensureDealCustodyAccounts,
} from "./accounting/chartAccountsProvision";

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

/**
 * Explicit repair for an EXISTING chart that predates one or more required
 * system accounts.
 *
 * This is intentionally an operator action, not a posting-path self-heal. A
 * receipt must never invent an account while accepting money. The finance
 * manager reviews the reported missing keys and invokes this repair from
 * Accounting Settings; compatible occupied codes still stop here and are
 * resolved through the separate adoption panel instead of being silently
 * reclassified.
 */
export const repairMissingSystemAccounts = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    if (!(await isChartInitialized(ctx, args.orgId))) {
      throw new ConvexError("Initialize the chart of accounts before repairing missing system accounts.");
    }

    const repaired: SystemKey[] = [];
    const reconciled: SystemKey[] = [];

    for (const systemKey of REQUIRED_SYSTEM_KEYS) {
      const accounts = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", args.orgId).eq("systemKey", systemKey))
        .collect();

      const active = accounts.filter((a) => a.active);

      if (active.length > 1) {
        // Reconcile duplicate active mappings to converge to exactly one authoritative active mapping
        const authoritative = active.reduce(
          (oldest, a) => (a._creationTime < oldest._creationTime ? a : oldest),
          active[0]
        );
        for (const account of accounts) {
          if (account._id !== authoritative._id && account.systemKey === systemKey) {
            await ctx.db.patch(account._id, {
              systemKey: undefined,
              updatedAt: Date.now(),
              updatedBy: user._id,
            });
          }
        }
        reconciled.push(systemKey);
        continue;
      }

      if (active.length === 1) {
        // Clean up any lingering inactive duplicate rows with the same systemKey
        for (const account of accounts) {
          if (!account.active && account.systemKey === systemKey) {
            await ctx.db.patch(account._id, {
              systemKey: undefined,
              updatedAt: Date.now(),
              updatedBy: user._id,
            });
          }
        }
        continue;
      }

      if (accounts.length > 0) {
        throw new ConvexError(
          `Required system account "${systemKey}" is mapped only to an inactive account. Reactivate or explicitly replace that account before retrying repair.`
        );
      }

      const def = DEFAULT_CHART.find((candidate) => candidate.systemKey === systemKey);
      if (!def) {
        throw new ConvexError(`No default chart definition exists for required system account "${systemKey}".`);
      }
      const outcome = await ensureSystemAccount(ctx, args.orgId, user._id, systemKey, def.code);
      if (outcome === "CREATED") repaired.push(systemKey);
    }

    if (repaired.length > 0 || reconciled.length > 0) {
      const parts: string[] = [];
      if (repaired.length > 0) parts.push(`created missing accounts: ${repaired.join(", ")}`);
      if (reconciled.length > 0) parts.push(`reconciled duplicate active accounts: ${reconciled.join(", ")}`);

      await auditLog(ctx, {
        orgId: args.orgId,
        actorId: user._id,
        actionType: "REPAIR_MISSING_SYSTEM_ACCOUNTS",
        resourceType: "chartOfAccounts",
        resourceId: args.orgId,
        description: `Repaired system accounts: ${parts.join("; ")}.`,
      });
      await ctx.scheduler.runAfter(0, internal.accountingOutbox.drainPendingAccountingEvents, {
        orgId: args.orgId,
      });
    }

    return { repaired, reconciled };
  },
});

function normalizeAccountCode(code: string): string {
  // Normalize Arabic keyboard digits rather than refuse them, so stored codes have one canonical form.
  return code.trim()
    .replace(/[\u0660-\u0669]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

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

    if (args.normalBalance !== NORMAL_BALANCE_BY_ACCOUNT_TYPE[args.type]) {
      throw new ConvexError({
        code: "NORMAL_BALANCE_MISMATCH",
        message: "The normal balance must match the account type.",
      });
    }

    const code = normalizeAccountCode(args.code);
    // Codes allow only ASCII letters, digits, dot and hyphen after normalization.
    // Reject every other character rather than enumerate invisible Unicode lookalikes.
    if (!/^[A-Za-z0-9.-]+$/.test(code)) {
      throw new ConvexError({
        code: "ACCOUNT_CODE_INVALID",
        message: "Enter an account code using only English letters, digits, dots and hyphens.",
      });
    }
    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({
        code: "ACCOUNT_NAME_REQUIRED",
        message: "Enter an English account name.",
      });
    }

    const existing = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_code", (q) => q.eq("orgId", args.orgId).eq("code", code))
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "ACCOUNT_CODE_EXISTS",
        message: "This account code already exists in this organization.",
      });
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
      code,
      name,
      nameAr: args.nameAr?.trim() || undefined,
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
    if (account.systemKey === SYSTEM_KEYS.BANK_ACCOUNT && args.allowManualPosting === true) {
      throw new ConvexError("The bank control account cannot allow manual posting because manual journals cannot identify a physical bank.");
    }

    const name = args.name?.trim();
    if (name !== undefined && !name) {
      throw new ConvexError({
        code: "ACCOUNT_NAME_REQUIRED",
        message: "Enter an English account name.",
      });
    }

    await ctx.db.patch(args.accountId, {
      updatedAt: Date.now(),
      updatedBy: user._id,
      ...(name !== undefined ? { name } : {}),
      ...(args.nameAr !== undefined ? { nameAr: args.nameAr.trim() || undefined } : {}),
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
      const accounts = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", args.orgId).eq("systemKey", key))
        .collect();
      const active = accounts.filter((a) => a.active);
      if (active.length !== 1) {
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
      const openings = await ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "POSTED")).take(2);
      if (openings.length > 1 || openings.some((opening) => opening.allocations?.some((row) =>
        row.kind === "PARTNER_CAPITAL" && row.accountId === candidate._id))) {
        throw new ConvexError("This account belongs to a posted partner opening and cannot be adopted.");
      }
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
