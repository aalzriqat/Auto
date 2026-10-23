import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { DEFAULT_CHART, SYSTEM_KEYS } from "./defaultChart";
import { requireOwnedRow } from "./tenancy";
import { resolveSystemAccount } from "../chartOfAccounts";

type Allocation = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number];
export type OpeningCommissionAllocation = Extract<Allocation, { kind: "EMPLOYEE_COMMISSION" }>;
const reservedCodes = new Set(DEFAULT_CHART.map((account) => account.code));

export function isOpeningCommissionAccount(account: Doc<"chartOfAccounts">): boolean {
  return account.active && account.type === "LIABILITY" && account.normalBalance === "CREDIT" &&
    (account.systemKey === SYSTEM_KEYS.COMMISSION_PAYABLE || (!account.systemKey && !reservedCodes.has(account.code)));
}

export async function validateOpeningCommissions(ctx: QueryCtx | MutationCtx, args: {
  orgId: Id<"organizations">; currency: string;
  lines: readonly { accountId: Id<"chartOfAccounts">; debitMinor: number; creditMinor: number }[];
  allocations: readonly Allocation[];
}): Promise<void> {
  const rows = args.allocations.filter((row): row is OpeningCommissionAllocation => row.kind === "EMPLOYEE_COMMISSION");
  if (rows.length === 0) return;
  if (await ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", args.orgId)).first()) {
    throw new ConvexError("Existing opening commissions require a finance review before posting another opening.");
  }
  const totals = new Map<Id<"chartOfAccounts">, number>();
  const employees = new Set<string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) throw new ConvexError("Opening commission amounts must be positive exact minor units.");
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", row.accountId, "Opening commission account unavailable.");
    if (!isOpeningCommissionAccount(account) || (account.currencyRestriction && account.currencyRestriction !== args.currency)) {
      throw new ConvexError("Opening commissions require an active, same-currency commission liability account.");
    }
    if (account.systemKey === SYSTEM_KEYS.COMMISSION_PAYABLE && account._id !== await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.COMMISSION_PAYABLE)) {
      throw new ConvexError("Opening commissions must use the actual native commission control account.");
    }
    const user = await ctx.db.get(row.userId);
    const membership = await ctx.db.query("memberships").withIndex("by_org_user", q => q.eq("orgId", args.orgId).eq("userId", row.userId)).unique();
    if (!user || !membership || membership.offboardingStatus) throw new ConvexError("Opening commission employee is not an active member of this organization.");
    const pair = `${row.accountId}:${row.userId}`;
    if (employees.has(pair)) throw new ConvexError("An employee can have only one opening commission per declared account.");
    employees.add(pair);
    const total = (totals.get(row.accountId) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(total)) throw new ConvexError("Opening commission total is too large.");
    totals.set(row.accountId, total);
  }
  for (const [accountId, total] of totals) {
    const controlLines = args.lines.filter(line => line.accountId === accountId);
    if (!controlLines.length || controlLines.some(line => line.debitMinor !== 0 || !Number.isSafeInteger(line.creditMinor) || line.creditMinor <= 0) ||
        controlLines.reduce((sum, line) => sum + line.creditMinor, 0) !== total) {
      throw new ConvexError("Opening commissions must exactly match their declared liability credit.");
    }
  }
}

/** Central opening materialization only; this creates no new accrual or cash movement. */
export async function materializeOpeningCommission(ctx: MutationCtx, args: {
  orgId: Id<"organizations">; currency: string; draftId: Id<"openingBalanceDrafts">;
  row: OpeningCommissionAllocation; now: number;
}): Promise<Id<"openingCommissionLiabilities">> {
  const sourceKey = `opening:${args.draftId}:${args.row.rowKey}`;
  if (await ctx.db.query("openingCommissionLiabilities").withIndex("by_org_source", q => q.eq("orgId", args.orgId).eq("sourceKey", sourceKey)).first()) {
    throw new ConvexError("The opening commission source has already been materialized.");
  }
  return ctx.db.insert("openingCommissionLiabilities", { orgId: args.orgId, userId: args.row.userId,
    openingDraftId: args.draftId, openingRowKey: args.row.rowKey, sourceKey, version: 1,
    amountMinor: args.row.amountMinor, paidMinor: 0, currency: args.currency, createdAt: args.now });
}
