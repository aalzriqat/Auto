import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";
import { isValidMinorAmount } from "./money";
import { PERMISSIONS } from "./permissions";
import { projectSaleRow } from "./saleRowProjection";
import { requireOwnedRow, requireTenantAuth } from "./tenancy";
import { projectOptionalVehicleForRole } from "./vehicleCostVisibility";

export async function getSaleDetail(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; saleId: Id<"sales"> },
) {
  const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

  const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.saleId).catch((error: unknown) => {
    if (!(error instanceof ConvexError)) throw error;
    throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
  });
  if (sale.isDeleted) {
    throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
  }

  const isCash = sale.financingType === "CASH" ||
    (sale.financingType === undefined && sale.applicationId === undefined);
  const [vehicle, customer, salesperson, receivable] = await Promise.all([
    ctx.db.get(sale.vehicleId),
    ctx.db.get(sale.customerId),
    ctx.db.get(sale.salespersonId),
    isCash && sale.status === "COMPLETED" && sale.canonicalReceivableDocumentId
      ? ctx.db.get(sale.canonicalReceivableDocumentId) : null,
  ]);
  const paymentStatus = receivable?.orgId === sale.orgId && receivable.sourceType === "sales" &&
    receivable.sourceId === sale._id && receivable.documentType === "INVOICE" &&
    receivable.payerType === "CUSTOMER" && receivable.customerId === sale.customerId &&
    isValidMinorAmount(receivable.originalAmountMinor) && receivable.originalAmountMinor > 0 &&
    (receivable.status === "OPEN" || receivable.status === "PARTIALLY_PAID" || receivable.status === "PAID")
    ? receivable.status : undefined;

  return {
    ...projectSaleRow(sale, role),
    ...(paymentStatus === undefined ? {} : { paymentStatus }),
    vehicle: projectOptionalVehicleForRole(vehicle, role),
    customer,
    salesperson: salesperson
      ? { _id: salesperson._id, name: salesperson.name, email: salesperson.email }
      : null,
  };
}
