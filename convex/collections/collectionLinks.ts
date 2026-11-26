import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isFcLineage } from "../utils/fcCheque";
import { assertReceivableNotSaleLinked } from "../utils/saleDebtContainment";

export async function getOptionalVehicle(ctx: QueryCtx | MutationCtx, vehicleId?: Id<"vehicles">) {
  return vehicleId ? await ctx.db.get(vehicleId) : null;
}

export async function validateOrgCustomer(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, customerId: Id<"customers">) {
  const customer = await ctx.db.get(customerId);
  if (!customer || customer.orgId !== orgId) {
    throw new ConvexError("Customer not found in this organization.");
  }
  return customer;
}

export async function validateOptionalLinks(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  links: {
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
  }
) {
  if (links.vehicleId) {
    const vehicle = await ctx.db.get(links.vehicleId);
    if (!vehicle || vehicle.orgId !== orgId) throw new ConvexError("Vehicle not found in this organization.");
  }
  if (links.saleId) {
    const sale = await ctx.db.get(links.saleId);
    if (!sale || sale.orgId !== orgId) throw new ConvexError("Sale not found in this organization.");
  }
  if (links.quoteId) {
    const quote = await ctx.db.get(links.quoteId);
    if (!quote || quote.orgId !== orgId) throw new ConvexError("Quote not found in this organization.");
  }
  if (links.applicationId) {
    const app = await ctx.db.get(links.applicationId);
    if (!app || app.orgId !== orgId) throw new ConvexError("Finance application not found in this organization.");
  }
  if (links.assignedTo) {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", links.assignedTo!))
      .unique();
    if (!membership) throw new ConvexError("Assigned user is not a member of this organization.");
  }
}

/**
 * SCRUM-571 R3/R4: refuse a CUSTOMER cheque whose lineage is a sale, either its
 * own saleId or its receivable's. A finance-company cheque (keyed on lineage,
 * SCRUM-447 D9) is a different instrument and is left to its own guards.
 */
export async function assertCustomerChequeNotSaleLinked(ctx: QueryCtx | MutationCtx, cheque: Doc<"postDatedCheques">) {
  if (isFcLineage(cheque)) return;
  assertReceivableNotSaleLinked(null, cheque.saleId);
  if (cheque.receivableId) assertReceivableNotSaleLinked(await ctx.db.get(cheque.receivableId));
}
