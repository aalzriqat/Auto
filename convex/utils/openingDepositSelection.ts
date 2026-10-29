import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { toMinorUnits } from "./money";

/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884): which named opening deposits a sale
 * of one vehicle to one customer takes. READ-ONLY, and the single source of that
 * decision, so the pre-write cash pay-first check (`cashSalePilotGate.ts`) and the
 * writer (`openingDepositApplication.ts`) cannot disagree about what a sale consumes.
 *
 * What it takes and what it leaves, stated so nobody has to infer it:
 *   - RESERVATION deposits only. A security deposit is the customer's refundable
 *     guarantee, not a payment for a car, so nothing here spends it.
 *   - A row naming a VIN is taken only by a sale of that VIN. A row naming none is
 *     customer credit and is taken by the customer's sale.
 *   - A row is taken whole or not at all, and never beyond what the customer was
 *     billed. A row that does not fit stays HELD for a later sale.
 *
 * LEAF MODULE: imports only types, `./money` and `convex/values`, so the gate and
 * the writer can both import it without creating a cycle.
 */

/** A customer holding more than this many opening rows is an anomaly, not a workload. */
const MAX_OPENING_ROWS_PER_CUSTOMER = 100;

export type OpeningDepositPick = { deposit: Doc<"deposits">; rowMinor: number };

export async function selectOpeningDepositsForSale(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    currency: string;
    /** What the customer was billed and has not already covered by another deposit. */
    capMinor: number;
  }
): Promise<OpeningDepositPick[]> {
  if (!Number.isSafeInteger(args.capMinor) || args.capMinor <= 0) return [];

  const eligible: Doc<"deposits">[] = [];
  let seen = 0;
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))) {
    if (++seen > 10 * MAX_OPENING_ROWS_PER_CUSTOMER) {
      throw new ConvexError("This customer has too many deposits to apply opening deposits safely. Review them first.");
    }
    if (
      deposit.origin !== "OPENING" ||
      deposit.status !== "HELD" ||
      deposit.isDeleted === true ||
      deposit.openingDepositKind !== "RESERVATION" ||
      (deposit.vehicleId !== undefined && deposit.vehicleId !== args.vehicleId) ||
      (deposit.currency ?? args.currency) !== args.currency
    ) {
      continue;
    }
    eligible.push(deposit);
  }
  if (eligible.length === 0) return [];

  // The car's own reservation first, then the customer credit; oldest first within each.
  eligible.sort((a, b) => {
    const aNamed = a.vehicleId === args.vehicleId ? 0 : 1;
    const bNamed = b.vehicleId === args.vehicleId ? 0 : 1;
    return aNamed - bNamed || a._creationTime - b._creationTime;
  });

  const picks: OpeningDepositPick[] = [];
  let remainingMinor = args.capMinor;
  for (const deposit of eligible) {
    const rowMinor = deposit.amountMinor ?? toMinorUnits(deposit.amount, args.currency);
    if (rowMinor <= 0 || rowMinor > remainingMinor) continue;
    picks.push({ deposit, rowMinor });
    remainingMinor -= rowMinor;
  }
  return picks;
}
