import { ConvexError } from "convex/values";
import { type Id } from "../_generated/dataModel";
import { type MutationCtx } from "../_generated/server";
import { DEFAULT_CHART, type SystemKey, SYSTEM_KEYS } from "../utils/defaultChart";
import { resolveSystemAccount, DEAL_CUSTODY_ACCOUNT_CODES } from "./chartAccountsRead";

/**
 * Generic version of the ensureGeneralExpenseAccount/ensureSupplierAPAccount
 * pattern: insert the DEFAULT_CHART account for `code` if this org has none
 * mapped to `systemKey` yet. Unlike those two (which had to re-map an
 * existing pre-systemKey account by code), every GL Phase 11 fixed-asset
 * code is brand new, so there's never a pre-existing account to re-map —
 * plain insert-if-missing is sufficient.
 */
export async function ensureSystemAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  systemKey: SystemKey,
  code: string
): Promise<"ALREADY_ACTIVE" | "CREATED"> {
  // .collect(), not .unique(): a legacy duplicate systemKey row (see
  // resolveSystemAccount above) must not crash the self-heal either — the
  // system account already exists in some form, so there's nothing to insert
  // regardless of how many rows currently share the key.
  const mapped = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .collect();
  if (mapped.some((account) => account.active)) return "ALREADY_ACTIVE";
  if (mapped.length > 0) {
    throw new ConvexError(
      `Required system account "${systemKey}" is mapped only to an inactive account. Reactivate or explicitly replace that account before retrying repair.`
    );
  }

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
    if (byCode.some((a) => a.systemKey === systemKey && a.active)) return "ALREADY_ACTIVE";
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
    const compatible = byCode.some((a) => a.type === def.type && a.normalBalance === def.normalBalance);
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
  return "CREATED";
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

/** Charts initialized before the opening-balance suspense account existed get it here, when first needed. */
export async function ensureOpeningSuspenseAccount(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<Id<"chartOfAccounts">> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.OPENING_SUSPENSE, "1900");
  const account = await resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.OPENING_SUSPENSE);
  if (!account) throw new ConvexError("The opening-balance suspense account could not be resolved.");
  return account;
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
 * Payroll self-heal, scoped to the payroll hooks (employee advances + payroll
 * runs). Existing orgs' charts predate these accounts, so create them on demand
 * before any payroll GL event posts. SALARIES_EXPENSE is also self-healed by
 * ensureExpenseCategoryAccounts, but a payroll run can be the first thing that
 * needs it, so include it here too (ensureSystemAccount is idempotent).
 */
export async function ensurePayrollAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.SALARIES_EXPENSE, "6820");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.SALARIES_PAYABLE, "2310");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.EMPLOYEE_ADVANCES, "1230");
}

/**
 * Self-heal for the two commission accounts, same shape as the payroll one.
 *
 * Commission now accrues INLINE at sale completion rather than at payment, so
 * an org whose chart lacks these keys no longer merely fails to pay a
 * commission — `resolveSystemAccount` throws and rolls back the entire sale
 * completion, which is the most important write a dealership makes. Nothing
 * warned them either: REQUIRED_SYSTEM_KEYS omits both, so Accounting → Setup
 * reports such a chart as valid. Charts predating the commission accounts are
 * real (migrateCommissionAccruals has to skip those orgs), so this closes the
 * class for every tenant instead of relying on an inspection of the ones we
 * happen to know about.
 */
export async function ensureCommissionAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.COMMISSION_EXPENSE, "6100");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.COMMISSION_PAYABLE, "2300");
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

/**
 * The three accounts a consigned (agent-basis) sale posts to.
 *
 * Self-heal for every org whose chart was initialized before agent accounting
 * existed — which is all of them. Without this the posting engine would fail to
 * resolve the system key on the first sourced sale after deploy, and the sale
 * would be refused for a reason that has nothing to do with the sale.
 */
export async function ensureConsignmentAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, "1240");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, "4170");
}

/**
 * The accounts a financed settlement posts to.
 *
 * Every org's chart predates them, so the first financed sale after deploy
 * would otherwise fail to resolve the keys. Same insert-if-missing self-heal
 * every other account group here uses — no migration, and an org that already
 * has one of these codes as a custom account is refused rather than having it
 * quietly repurposed.
 *
 * Called only when a sale actually carries a settlement plan, so an ordinary
 * cash sale pays for none of these lookups.
 */
export async function ensureFinancedSettlementAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS, "4180");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.ACCOUNTS_PAYABLE_FINANCE_COMPANIES, "2220");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE, "6860");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.APPRAISAL_EXPENSE, "6870");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.INSURANCE_EXPENSE, "6880");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE, "6890");
  await ensureSystemAccount(ctx, orgId, actorId, SYSTEM_KEYS.SELLING_EXPENSE, "6900");
}

/**
 * The accounts a financed deal's EMPLOYEE CASH CUSTODY posts to.
 *
 * 1250 is the clearing account every custody movement and custody-paid fee
 * touches; 6200 is where an unaccountable shortage is written off. Same
 * insert-if-missing self-heal as the other groups: a chart initialized
 * before either account existed gets it on the first custody posting, and
 * an org that already uses one of these codes for a custom account is
 * refused rather than having it quietly repurposed. Called only by the
 * custody hooks, so no other posting pays for the lookups.
 */
export async function ensureDealCustodyAccounts(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  for (const [key, code] of DEAL_CUSTODY_ACCOUNT_CODES) {
    await ensureSystemAccount(ctx, orgId, actorId, key, code);
  }
}
