import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { saleCompletedKey } from "../accounting/postingRules";
import { assertStoredDraftDealIdentity } from "./quotedCommercialDeal";
import { assertNoSaleLinkedLegacyReceivable } from "./saleDebtContainment";
import { requireOwnedRow } from "./tenancy";
import { assertQuotableVehicle, assertVehicleReadyForSale } from "./vehicleLiveness";
import { isConsignedAgentSale } from "./vehicleOwnership";

export function isStandaloneCashDraft(sale: Doc<"sales">): boolean {
  return sale.status === "PENDING" && !sale.applicationId && !sale.quoteId &&
    (sale.financingType === undefined || sale.financingType === "CASH");
}

export function assertCashDraftRevision(sale: Doc<"sales">, expected: number | undefined): void {
  if (expected !== (sale.draftRevision ?? 0)) {
    throw new ConvexError({ code: "CASH_DRAFT_CORRECTION_STALE", message: "This draft changed since you opened it. Review the current terms and try again." });
  }
}

export function cashDraftCorrectionReason(
  correction: Readonly<{ reason: string }>,
  patch: Partial<Doc<"sales">>,
): string {
  const reason = correction.reason.trim();
  if (!reason || reason.length > 500) {
    throw new ConvexError("Give a correction reason of at most 500 characters.");
  }
  if (Object.keys(patch).some((field) => field !== "salePrice" && field !== "saleDate")) {
    throw new ConvexError("This correction can change the agreed price, sale date, buyer or vehicle only.");
  }
  return reason;
}

export async function assertCashDraftHasNoAccountingHistory(ctx: MutationCtx, sale: Doc<"sales">): Promise<void> {
  const { orgId, _id: saleId } = sale;
  const [event, outbox, invoice, cashflow] = await Promise.all([
    ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", saleId)).first(),
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", saleCompletedKey(saleId))).first(),
    ctx.db.query("receivableDocuments").withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", saleId)).first(),
    ctx.db.query("transactions").withIndex("by_org_sale", (q) => q.eq("orgId", orgId).eq("saleId", saleId)).first(),
    assertNoSaleLinkedLegacyReceivable(ctx, orgId, saleId),
  ]);
  if (sale.canonicalReceivableDocumentId || event || outbox || invoice || cashflow) {
    throw new ConvexError({ code: "CASH_DRAFT_CORRECTION_HAS_ACCOUNTING", message: "This sale already has accounting history. An accountant must review the correction." });
  }
}

async function assertNoOriginalVehicleDeposit(
  ctx: MutationCtx,
  { orgId, customerId, vehicleId }: Pick<Doc<"sales">, "orgId" | "customerId" | "vehicleId">,
): Promise<void> {
  const namedHeldDeposit = (origin: "OPENING" | undefined) => ctx.db.query("deposits")
    .withIndex("by_org_customer_opening_status", (q) =>
      q.eq("orgId", orgId).eq("customerId", customerId).eq("origin", origin).eq("status", "HELD"))
    .filter((q) => {
      const matchesVehicle = q.and(q.eq(q.field("vehicleId"), vehicleId), q.neq(q.field("isDeleted"), true));
      return origin === "OPENING" ? matchesVehicle : q.and(matchesVehicle, q.neq(q.field("usesVehicleHoldRows"), true));
    });
  const [opening, ordinary, activeShares] = await Promise.all([
    namedHeldDeposit("OPENING").first(),
    namedHeldDeposit(undefined).take(101),
    ctx.db.query("depositVehicleHolds").withIndex("by_org_vehicle_active", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("active", true)).take(101),
  ]);
  const needsReview = Boolean(opening) || ordinary.length > 100 || activeShares.length > 100;
  // A split deposit's primary vehicle is only a snapshot, including rows recorded before the split flag.
  const [directReceipts, shared] = needsReview ? [[], []] : await Promise.all([
    Promise.all(ordinary.map(async (deposit) => deposit.usesVehicleHoldRows === false ||
      !(await ctx.db.query("depositVehicleHolds").withIndex("by_deposit", (q) =>
        q.eq("depositId", deposit._id)).first()))),
    Promise.all(activeShares.map((share) => ctx.db.get(share.depositId))),
  ]);
  if (needsReview || directReceipts.some(Boolean) || shared.some((deposit) =>
    deposit?.orgId === orgId && deposit.customerId === customerId && deposit.status === "HELD" && deposit.isDeleted !== true)) {
    throw new ConvexError({
      code: "CASH_DRAFT_CORRECTION_DEPOSIT_REVIEW",
      message: "Review the deposit on the original vehicle before changing this draft.",
    });
  }
}

export async function validateCashDraftIdentity(
  ctx: MutationCtx,
  sale: Doc<"sales">,
  correction: { customerId?: Id<"customers">; vehicleId?: Id<"vehicles"> },
): Promise<Partial<Pick<Doc<"sales">, "customerId" | "vehicleId">>> {
  const customerId = correction.customerId ?? sale.customerId;
  const vehicleId = correction.vehicleId ?? sale.vehicleId;
  if (customerId === sale.customerId && vehicleId === sale.vehicleId) return {};
  if (sale.leadId || sale.tradeInVehicleId || (sale.downPayment ?? 0) > 0) {
    throw new ConvexError({
      code: "CASH_DRAFT_CORRECTION_LINKED_REFERENCE",
      message: "Review the linked lead, trade-in or down payment before changing this draft.",
    });
  }

  const { orgId } = sale;
  const [customer, originalVehicle, vehicle] = await Promise.all([
    requireOwnedRow(ctx, orgId, "customers", customerId),
    requireOwnedRow(ctx, orgId, "vehicles", sale.vehicleId),
    requireOwnedRow(ctx, orgId, "vehicles", vehicleId),
    assertStoredDraftDealIdentity(ctx, sale, orgId),
  ]);
  if (customer.isDeleted) {
    throw new ConvexError({
      code: "CASH_DRAFT_CORRECTION_BUYER_INACTIVE", message: "Choose an active buyer in this dealership.",
    });
  }
  assertQuotableVehicle(vehicle);
  assertVehicleReadyForSale(vehicle);
  if (vehicleId !== sale.vehicleId && vehicle.status !== "AVAILABLE") {
    throw new ConvexError({
      code: "CASH_DRAFT_CORRECTION_VEHICLE_UNAVAILABLE", message: "Choose an available replacement vehicle.",
    });
  }
  const branchId = sale.branchId ?? originalVehicle.branchId;
  if (branchId !== vehicle.branchId || isConsignedAgentSale(originalVehicle) !== isConsignedAgentSale(vehicle)) {
    throw new ConvexError({
      code: "CASH_DRAFT_CORRECTION_VEHICLE_BRANCH",
      message: "Verify the draft’s branch and use a vehicle with the original ownership type.",
    });
  }

  await assertNoOriginalVehicleDeposit(ctx, sale);
  return {
    ...(customerId === sale.customerId ? {} : { customerId }),
    ...(vehicleId === sale.vehicleId ? {} : { vehicleId }),
  };
}
