import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { DEFAULT_CHART, SYSTEM_KEYS } from "../utils/defaultChart";
import { requireOwnedRow } from "../utils/tenancy";
import { resolveSystemAccount } from "../chartOfAccounts";

type Allocation = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number];
type PartnerAllocation = Extract<Allocation, { kind: "PARTNER_CAPITAL" }>;
const reservedCodes = new Set(DEFAULT_CHART.map((account) => account.code));

export function isOpeningPartnerAccount(account: Doc<"chartOfAccounts">): boolean {
  return account.type === "EQUITY" && account.normalBalance === "CREDIT" &&
    (account.systemKey === SYSTEM_KEYS.PARTNER_CAPITAL || (!account.systemKey && !reservedCodes.has(account.code)));
}

/** All partners must start clean, not just the ones named by the submitted rows.
 * Bounds are an admission limit; exceeding them never means partial validation. */
export async function validateOpeningPartners(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">,
  lines: readonly { accountId: Id<"chartOfAccounts">; debitMinor: number; creditMinor: number }[],
  allocations: readonly Allocation[]): Promise<void> {
  const partners = await ctx.db.query("partnerEquity").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(101);
  if (partners.length > 100) throw new ConvexError("This opening requires a finance review because it has too many partners.");
  for (const partner of partners) {
    if (partner.openingBalanceDraftId || [partner.openingBalanceMinor, partner.currentBalance, partner.initialCapital]
      .some((amount) => amount !== undefined && (!Number.isFinite(amount) || amount !== 0)) ||
      await ctx.db.query("partnerEquityTransactions").withIndex("by_org_partner_time", (q) =>
        q.eq("orgId", orgId).eq("partnerId", partner._id)).first()) {
      throw new ConvexError("Existing partner balances require a finance review before an opening can be posted.");
    }
  }
  const rows: PartnerAllocation[] = allocations.filter((row): row is PartnerAllocation => row.kind === "PARTNER_CAPITAL");
  const totals = new Map<Id<"chartOfAccounts">, number>();
  const pairs = new Set<string>();
  const partnerTotals = new Map<Id<"partnerEquity">, number>();
  const canonicalCapital = rows.some((row) => lines.some((line) => line.accountId === row.accountId))
    ? await resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.PARTNER_CAPITAL) : undefined;
  for (const row of rows) {
    const partner = await requireOwnedRow(ctx, orgId, "partnerEquity", row.partnerId, "Opening partner not found in this organization.");
    if (partner.isDeleted) throw new ConvexError("Opening partner is unavailable.");
    const account = await requireOwnedRow(ctx, orgId, "chartOfAccounts", row.accountId, "Opening account not found in this organization.");
    if (!isOpeningPartnerAccount(account)) throw new ConvexError("Partner openings require an explicitly classified capital account.");
    if (account.systemKey === SYSTEM_KEYS.PARTNER_CAPITAL && account._id !== canonicalCapital) {
      throw new ConvexError("Partner openings must use the account used by native partner movements.");
    }
    const pair = `${row.partnerId}:${row.accountId}`;
    if (pairs.has(pair)) throw new ConvexError("A partner can have only one opening allocation per account.");
    pairs.add(pair);
    const total = (totals.get(row.accountId) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(total)) throw new ConvexError("The opening partner total is too large.");
    totals.set(row.accountId, total);
    const partnerTotal = (partnerTotals.get(row.partnerId) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(partnerTotal)) throw new ConvexError("The opening partner total is too large.");
    partnerTotals.set(row.partnerId, partnerTotal);
  }
  const credits = new Map<Id<"chartOfAccounts">, number>();
  for (const line of lines) {
    const account = await requireOwnedRow(ctx, orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    if (account.systemKey !== SYSTEM_KEYS.PARTNER_CAPITAL && !totals.has(line.accountId)) continue;
    if (line.debitMinor !== 0) throw new ConvexError("Partner opening capital requires credit-only journal lines.");
    const total = (credits.get(line.accountId) ?? 0) + line.creditMinor;
    if (!Number.isSafeInteger(total)) throw new ConvexError("The opening partner total is too large.");
    credits.set(line.accountId, total);
  }
  for (const accountId of new Set([...totals.keys(), ...credits.keys()])) {
    if ((totals.get(accountId) ?? 0) <= 0 || totals.get(accountId) !== credits.get(accountId)) {
      throw new ConvexError("Partner opening allocations must match each capital account's credit balance.");
    }
  }
}
