import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";

export function requireOpeningRefundReservation(deposit: Doc<"deposits">, key: string, actorId: Id<"users">) {
  const reservation = deposit.openingRefundReservation;
  if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
      !reservation || reservation.key !== key || reservation.reservedBy !== actorId) {
    throw new ConvexError("Only the approver holding the active opening refund reservation can settle or cancel it.");
  }
  return reservation;
}

export async function priorCustodianLostAuthority(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
) {
  const membership = await ctx.db.query("memberships").withIndex("by_org_user",
    q => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!membership || membership.offboardingStatus) return true;
  const role = await ctx.db.get(membership.roleId);
  return !!role && role.orgId === orgId &&
    (!isSystemOwnerRole(role) && !role.permissions.includes(PERMISSIONS.APPROVE_REQUESTS));
}
