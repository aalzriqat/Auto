import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import { CUSTODY_NOT_FOUND } from "./dealCostGuards";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { PaginationOptions } from "convex/server";
import { listEligibleBanks } from "../bankAccountGuards";

/**
 * The movement log of ONE custody record, paginated, oldest first.
 *
 * Kept out of `listDealCosts` so that read stays bounded whatever the log's
 * length. Each page row says whether a later REVERSAL cancelled it, through
 * one indexed point read per row (`by_reverses`) rather than a re-read of the
 * whole log. The custody row itself is proven to belong to the caller's org.
 */
export async function listCustodyMovementsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    paginationOpts: PaginationOptions;
  }
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
  const custody = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeDealCustody",
    args.custodyId,
    CUSTODY_NOT_FOUND
  );
  const result = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_custody", (q) => q.eq("custodyId", custody._id))
    .order("asc")
    .paginate(args.paginationOpts);

  const names = new Map<Id<"users">, string>();
  const page = [];
  for (const entry of result.page) {
    let recordedByName = names.get(entry.recordedBy);
    if (recordedByName === undefined) {
      const user = await ctx.db.get(entry.recordedBy);
      recordedByName = user?.name ?? "";
      names.set(entry.recordedBy, recordedByName);
    }
    const reversal =
      entry.kind === "REVERSAL"
        ? null
        : await ctx.db
            .query("financeDealCustodyEntries")
            .withIndex("by_reverses", (q) => q.eq("reversesEntryId", entry._id))
            .first();
    page.push({
      _id: entry._id,
      kind: entry.kind,
      reversesEntryId: entry.reversesEntryId,
      amountMinor: entry.amountMinor,
      method: entry.method,
      reference: entry.reference,
      note: entry.note,
      occurredAt: entry.occurredAt,
      recordedAt: entry.recordedAt,
      recordedByName,
      reversed: reversal !== null,
    });
  }
  return { ...result, page };
}

/** Bank choices for custody cash movements in the deal's currency. */
export async function listCustodyBankOptionsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    currency: string;
  }
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
  return await listEligibleBanks(ctx, args.orgId, args.currency);
}
