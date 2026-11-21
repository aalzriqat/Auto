import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isValidMinorAmount } from "./money";
import { projectSaleRow } from "./saleRowProjection";
import { projectOptionalVehicleForRole } from "./vehicleCostVisibility";

export async function getSaleDetail(
  ctx: QueryCtx,
  sale: Doc<"sales">,
  role: Doc<"roles">,
) {
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
