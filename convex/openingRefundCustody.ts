import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwner, requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { assertOrgEconomicallyActive } from "./utils/orgLifecycle";
import { orgResetState } from "./utils/orgResetGeneration";
import { auditLog } from "./utils/financialAuditWriter";
import { runWithIdempotency } from "./utils/idempotency";
import { assertOpeningRefundAuthority, hasArchivedRefundAuthority, hasOpeningRefundAuthority,
  openingRefundActorAllowed, priorCustodianLostAuthority, requireOpeningRefundReservation } from "./utils/openingRefundAuthority";
const openingRefundMethod = v.union(v.literal("CASH"), v.literal("BANK_TRANSFER"));

export const recoverOpeningRefundCustody = mutation({
  args: {
    orgId: v.id("organizations"), depositId: v.id("deposits"),
    expectedReservationKey: v.string(), idempotencyKey: v.string(),
    confirmedPaymentControlTransferred: v.literal(true), reason: v.string(),
  },
  returns: v.object({ reservationKey: v.string() }),
  handler: async (ctx, args) => {
    const { orgId, depositId, expectedReservationKey } = args;
    const { user, membership, role } = await requireOwner(ctx, orgId);
    assertOpeningRefundAuthority(role, orgId);
    if (membership.impersonationGrantId) throw new ConvexError("An impersonation session cannot recover refund custody.");
    await assertOrgEconomicallyActive(ctx, orgId);
    if (orgResetState(await ctx.db.get(orgId)).inProgress) throw new ConvexError("Refund custody is unavailable during a financial reset.");
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId, "Deposit not found.");
    const reason = args.reason.trim();
    const nextKey = args.idempotencyKey.trim();
    if (!reason || reason.length > 240 || nextKey === expectedReservationKey) {
      throw new ConvexError("Enter a reason for transferring refund custody and start a new recovery request.");
    }
    const result = await runWithIdempotency(ctx, {
      orgId, operation: "openingDepositRefunds.recoverCustody", economic: true,
      idempotencyKey: nextKey, actorId: user._id, fingerprint: JSON.stringify([depositId, expectedReservationKey, reason]),
    }, async () => {
      const reservation = deposit.openingRefundReservation;
      if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
          !reservation || reservation.key !== expectedReservationKey) {
        throw new ConvexError("The refund reservation changed. Reopen it and try again.");
      }
      if (!openingRefundActorAllowed(deposit, reservation.method, user._id)) {
        throw new ConvexError("You cannot take custody of your own deposit refund.");
      }
      const customer = await requireOwnedRow(ctx, orgId, "customers", deposit.customerId);
      if (!(await priorCustodianLostAuthority(ctx, orgId, reservation.reservedBy, customer.isDeleted === true))) {
        throw new ConvexError("The reserving approver still has refund authority.");
      }
      const newReservation = { ...reservation, key: nextKey, reservedBy: user._id };
      await ctx.db.patch(depositId, { openingRefundReservation: newReservation });
      await auditLog(ctx, {
        orgId, actorId: user._id, actionType: "RESOLVE_DEPOSIT_ALLOCATION",
        resourceType: "deposits", resourceId: depositId, description: "Opening refund custody recovered",
        before: reservation, after: { reservation: newReservation, reason, confirmedPaymentControlTransferred: true },
        idempotencyKey: nextKey,
      });
      return { reservationKey: nextKey };
    });
    const current = await ctx.db.get(depositId);
    if (!current) throw new ConvexError("The refund reservation is no longer active.");
    requireOpeningRefundReservation(current, result.reservationKey, user._id);
    return result;
  },
});

export const openingRefundReservation = query({
  args: { orgId: v.id("organizations"), depositId: v.id("deposits") },
  returns: v.union(v.null(), v.object({
    reservationKey: v.string(), method: openingRefundMethod,
    bankAccountName: v.optional(v.string()),
    canRecover: v.optional(v.literal(true)),
  })),
  handler: async (ctx, args) => {
    const { user, role, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    if (!hasOpeningRefundAuthority(role, args.orgId)) return null;
    const deposit = await requireOwnedRow(ctx, args.orgId, "deposits", args.depositId, "Deposit not found.");
    const reservation = deposit.openingRefundReservation;
    if (!reservation || deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted) return null;
    const customer = await requireOwnedRow(ctx, args.orgId, "customers", deposit.customerId);
    const archived = customer.isDeleted === true;
    if (archived && !hasArchivedRefundAuthority(role, args.orgId)) return null;
    if (reservation.reservedBy !== user._id) {
      if (!isSystemOwnerRole(role) || membership.impersonationGrantId ||
          !openingRefundActorAllowed(deposit, reservation.method, user._id) ||
          !(await priorCustodianLostAuthority(ctx, args.orgId, reservation.reservedBy, archived))) return null;
      return { reservationKey: reservation.key, method: reservation.method, canRecover: true as const };
    }
    const bank = reservation.bankAccountId
      ? await requireOwnedRow(ctx, args.orgId, "bankAccounts", reservation.bankAccountId)
      : undefined;
    return { reservationKey: reservation.key, method: reservation.method, ...(bank ? { bankAccountName: bank.name } : {}) };
  },
});
