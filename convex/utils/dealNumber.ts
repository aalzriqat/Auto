import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { isValidDealNumber } from "./dealNumberFormat";

/**
 * SCRUM-808: allocation of the per-organization deal number.
 *
 * One `dealNumberCounters` row per organization holds the last number handed out. The allocator reads it and writes
 * it back inside the caller's mutation, the same transaction that inserts the deal. Convex mutations are serializable
 * (optimistic concurrency control: a transaction whose read set was written by a concurrent commit is retried), so two
 * deals created at the same time for one organization can never read the same `lastNumber` and both commit. The read of
 * an absent counter is an index range read, and a concurrent insert into that range conflicts the same way, so two
 * "first deal" transactions cannot both create a counter. https://docs.convex.dev/database/advanced/occ
 *
 * The counter is its own table, not a field on `organizations`: almost every mutation reads the organization row, and
 * writing it on each deal would put every one of them in conflict with every deal creation.
 *
 * Numbers are never derived from a count or a scan, never reused, and not gapless: a deal that is cancelled or deleted
 * keeps its number, and a creation that rolls back releases nothing because its counter write rolls back with it.
 */

async function readCounter(ctx: QueryCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("dealNumberCounters")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

/** Reads the deal holding `dealNumber` in either deal table; the canonical deal (the application) first. */
export async function findDealByNumber(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  dealNumber: number,
): Promise<{ kind: "application"; doc: Doc<"financeApplications"> } | { kind: "sale"; doc: Doc<"sales"> } | null> {
  const application = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_dealNumber", (q) => q.eq("orgId", orgId).eq("dealNumber", dealNumber))
    .first();
  if (application) return { kind: "application", doc: application };
  const sale = await ctx.db
    .query("sales")
    .withIndex("by_org_dealNumber", (q) => q.eq("orgId", orgId).eq("dealNumber", dealNumber))
    .first();
  return sale ? { kind: "sale", doc: sale } : null;
}

/** Where a deal number leads: the deal screen of the application, or of the cash sale. Null for an unknown number. */
export type DealNumberMatch =
  | { kind: "application"; id: Id<"financeApplications">; dealNumber: number }
  | { kind: "sale"; id: Id<"sales">; dealNumber: number };

export async function resolveDealNumber(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  dealNumber: number,
): Promise<DealNumberMatch | null> {
  const found = await findDealByNumber(ctx, orgId, dealNumber);
  if (!found) return null;
  if (found.kind === "application") return { kind: "application", id: found.doc._id, dealNumber };
  // A soft-deleted sale is not listed anywhere, so it is not found by its number either.
  if (found.doc.isDeleted) return null;
  return { kind: "sale", id: found.doc._id, dealNumber };
}

/** Hands out the organization's next deal number. Call only from the mutation that stores it on the new deal. */
export async function allocateDealNumber(ctx: MutationCtx, orgId: Id<"organizations">): Promise<number> {
  const counter = await readCounter(ctx, orgId);
  const last = counter?.lastNumber ?? 0;
  const next = last + 1;
  if (!isValidDealNumber(next)) {
    throw new ConvexError("The deal number counter for this organization is not a valid number.");
  }
  // Defence in depth: a counter that fell behind (restored, or edited by hand) must refuse, not hand out a duplicate.
  if (await findDealByNumber(ctx, orgId, next)) {
    throw new ConvexError("The next deal number is already in use. The deal number counter needs repair.");
  }
  if (counter) {
    await ctx.db.patch(counter._id, { lastNumber: next });
  } else {
    await ctx.db.insert("dealNumberCounters", { orgId, lastNumber: next });
  }
  return next;
}

/**
 * The deal number for a finance application that does not have one yet: allocates it and stores it on the application.
 * Returns the stored number when it already has one, so it is safe to call more than once.
 */
export async function ensureApplicationDealNumber(
  ctx: MutationCtx,
  application: Doc<"financeApplications">,
): Promise<number> {
  if (isValidDealNumber(application.dealNumber)) return application.dealNumber;
  const dealNumber = await allocateDealNumber(ctx, application.orgId);
  await ctx.db.patch(application._id, { dealNumber });
  return dealNumber;
}

/**
 * The deal number a new sale row carries. A sale finalized from a finance application is the same deal as that
 * application, so it carries the application's number (one number per deal, however many sale rows a multi-car
 * application produces). Any other sale is a new deal and gets the next number.
 */
export async function dealNumberForNewSale(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; applicationId?: Id<"financeApplications"> },
): Promise<number> {
  if (args.applicationId) {
    const application = await ctx.db.get(args.applicationId);
    if (application && application.orgId === args.orgId) return await ensureApplicationDealNumber(ctx, application);
  }
  return await allocateDealNumber(ctx, args.orgId);
}
