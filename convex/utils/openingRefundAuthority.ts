import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";
import { requireOwnedRow } from "./tenancy";

export async function assertNoHeldOpeningDeposits(
  ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">,
): Promise<void> {
  const openingDeposit = await ctx.db.query("deposits")
    .withIndex("by_org_customer_opening_status", q => q.eq("orgId", orgId).eq("customerId", customerId)
      .eq("origin", "OPENING").eq("status", "HELD").lt("isDeleted", true)).first();
  if (openingDeposit) throw new ConvexError("Settle the customer's held opening deposits before deleting the customer.");
}

export function hasOpeningRefundAuthority(role: Doc<"roles"> | null, orgId: Id<"organizations">): role is Doc<"roles"> {
  return !!role && role.orgId === orgId && !role.isDeleted &&
    (isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.APPROVE_REQUESTS));
}

export function assertOpeningRefundAuthority(role: Doc<"roles">, orgId: Id<"organizations">): void {
  if (!hasOpeningRefundAuthority(role, orgId)) throw new ConvexError("This account no longer has refund authority.");
}

export function hasArchivedRefundAuthority(role: Doc<"roles">, orgId: Id<"organizations">) {
  return hasOpeningRefundAuthority(role, orgId) &&
    (isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.MANAGE_FINANCE));
}

export function openingRefundActorAllowed(
  deposit: Doc<"deposits">, method: "CASH" | "BANK_TRANSFER", actorId: Id<"users">,
): boolean {
  // SCRUM-956 c25298 permits either opening-entry actor to handle a cash refund.
  return method === "CASH" || actorId !== deposit.createdBy;
}

export async function assertRefundCustomerAvailable(
  ctx: QueryCtx, deposit: Doc<"deposits">, role: Doc<"roles">,
) {
  const customer = await requireOwnedRow(ctx, deposit.orgId, "customers", deposit.customerId, "The deposit customer is unavailable.");
  if (customer.isDeleted && !(deposit.origin === "OPENING" && (deposit.releaseCount ?? 0) > 0 && hasArchivedRefundAuthority(role, deposit.orgId))) {
    throw new ConvexError("The deposit customer is unavailable for this refund.");
  }
}

export function requireOpeningRefundReservation(deposit: Doc<"deposits">, key: string, actorId: Id<"users">) {
  const reservation = deposit.openingRefundReservation;
  if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
      reservation?.key !== key || reservation.reservedBy !== actorId) {
    throw new ConvexError("Only the approver holding the active opening refund reservation can settle or cancel it.");
  }
  return reservation;
}

export async function priorCustodianLostAuthority(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  forArchivedCustomer = false,
) {
  const membership = await ctx.db.query("memberships").withIndex("by_org_user",
    q => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!membership || membership.offboardingStatus) return true;
  const user = await ctx.db.get(userId);
  if (!user || user.disabled) return true;
  const role = await ctx.db.get(membership.roleId);
  if (!hasOpeningRefundAuthority(role, orgId)) return true;
  return forArchivedCustomer && !hasArchivedRefundAuthority(role, orgId);
}
