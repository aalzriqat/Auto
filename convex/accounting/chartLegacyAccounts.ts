import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEFAULT_CHART, SYSTEM_KEYS } from "../utils/defaultChart";

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
