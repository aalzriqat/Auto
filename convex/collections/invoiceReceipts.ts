import type { PaginationOptions } from "convex/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { activatePendingInvoiceReceipt, InvoiceReceiptProofError, verifyPendingInvoiceReceiptActivation } from "../accounting/invoiceReceiptActivation";
import { pendingSaleInvoiceReceiptMinor, reservePendingInvoiceReceipt } from "../accounting/invoiceReceiptReservation";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { getReceivableOutstandingMinor } from "../utils/subledgerAllocations";
import { areSaleInvoiceReceiptDoorsDisabled, assertSaleInvoiceReceiptDoorsAllowed, isCustomerCreditPayoutDisabled } from "../utils/customerCreditPayoutContainment";
import { runWithIdempotency } from "../utils/idempotency";
import { fromMinorUnits } from "../utils/money";
import { PERMISSIONS } from "../utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { registerChequeInTransaction } from "./chequeLifecycle";

export async function saleInvoiceReceiptStatusHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    paginationOpts: PaginationOptions;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.saleId);
  const invoice = sale.canonicalReceivableDocumentId
    ? await ctx.db.get(sale.canonicalReceivableDocumentId) : null;
  if (invoice && (invoice.orgId !== args.orgId || invoice.sourceType !== "sales" ||
    invoice.sourceId !== String(sale._id) || invoice.documentType !== "INVOICE" ||
    invoice.payerType !== "CUSTOMER" || invoice.customerId !== sale.customerId)) {
    throw new ConvexError("The sale's customer invoice cannot be verified.");
  }
  const pending = await ctx.db.query("invoiceReceiptApplications")
    .withIndex("by_org_sale_status", (q) => q.eq("orgId", args.orgId)
      .eq("saleId", sale._id).eq("status", "PENDING"))
    .paginate(args.paginationOpts);
  const page = await Promise.all(pending.page.map(async (row) => {
    let readiness: "ORIGINS_VERIFIED" | "REVIEW_REQUIRED" = "REVIEW_REQUIRED";
    let reason: string | undefined;
    try {
      await verifyPendingInvoiceReceiptActivation(ctx, args.orgId, row._id);
      readiness = "ORIGINS_VERIFIED";
    } catch (error) {
      // This preview is advisory. The writer checks the same proof again;
      // never show a technical lineage error or mark missing evidence ready.
      console.error("Pending invoice receipt proof unavailable", error);
      reason = error instanceof InvoiceReceiptProofError ? error.reason : "PROOF_UNAVAILABLE";
    }
    return {
      applicationId: row._id,
      receiptMovementId: row.receiptMovementId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      createdAt: row.createdAt,
      readiness,
      reason,
    };
  }));
  const outstandingMinor = invoice ? await getReceivableOutstandingMinor(ctx, invoice._id) : null;
  const pendingMinor = invoice ? await pendingSaleInvoiceReceiptMinor(ctx, args.orgId, sale._id) : null;
  return {
    ...pending,
    page,
    invoice: invoice ? {
      currency: invoice.currency,
      originalAmountMinor: invoice.originalAmountMinor,
      outstandingMinor: outstandingMinor!,
      availableToReserveMinor: Math.max(0, outstandingMinor! - pendingMinor!),
    } : null,
    saleStatus: sale.status,
    customerId: sale.customerId,
    receiptCurrency: await getOrgCurrency(ctx, args.orgId),
    // Additive (SCRUM-724): the UI shows its disabled state from these.
    // Absent (older backend) must be read as unavailable by every client.
    saleInvoiceDoorsAvailable: !areSaleInvoiceReceiptDoorsDisabled(),
    retainedCreditPayoutAvailable: !isCustomerCreditPayoutDisabled(),
  };
}

export async function listSaleCustomerChequesHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    paginationOpts: PaginationOptions;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.saleId);
  const result = await ctx.db.query("postDatedCheques")
    .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", sale.customerId))
    .paginate(args.paginationOpts);
  return { ...result, saleStatus: sale.status, page: result.page.filter((cheque) =>
    !cheque.isDeleted && cheque.invoiceSaleId === sale._id &&
    !cheque.receivableId && !cheque.saleId &&
    !cheque.applicationId && !cheque.originApplicationId && !cheque.drawerType &&
    (cheque.status === "HELD" || cheque.status === "DEPOSITED")
  ).map((cheque) => ({ chequeId: cheque._id, bank: cheque.bank,
    chequeNumber: cheque.chequeNumber, chequeDate: cheque.chequeDate,
    amount: cheque.amount, status: cheque.status })) };
}

export async function registerSaleInvoiceChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    bank: string;
    chequeNumber: string;
    chequeDate: number;
    amountMinor: number;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  assertSaleInvoiceReceiptDoorsAllowed();
  const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.saleId);
  const invoice = sale.canonicalReceivableDocumentId
    ? await requireOwnedRow(ctx, args.orgId, "receivableDocuments", sale.canonicalReceivableDocumentId) : null;
  if (sale.status !== "COMPLETED" || !invoice || invoice.sourceType !== "sales" ||
    invoice.sourceId !== String(sale._id) || invoice.documentType !== "INVOICE" ||
    invoice.payerType !== "CUSTOMER" || invoice.customerId !== sale.customerId ||
    invoice.currency.toUpperCase() !== (await getOrgCurrency(ctx, args.orgId)).toUpperCase()) {
    throw new ConvexError("This sale has no eligible customer invoice for a cheque.");
  }
  const [outstanding, reserved] = await Promise.all([
    getReceivableOutstandingMinor(ctx, invoice._id),
    pendingSaleInvoiceReceiptMinor(ctx, args.orgId, sale._id),
  ]);
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0 ||
    args.amountMinor > outstanding - reserved || !Number.isFinite(args.chequeDate)) {
    throw new ConvexError("Choose an available customer invoice amount and a valid cheque date.");
  }
  // The generic customer cheque must not carry a saleId: SCRUM-571 keeps
  // clearing from booking directly to a sale. Clearing makes retained 2110;
  // the later explicit reservation and activation settle this invoice.
  return registerChequeInTransaction(ctx, { orgId: args.orgId, customerId: sale.customerId,
    bank: args.bank, chequeNumber: args.chequeNumber, chequeDate: args.chequeDate,
    amount: fromMinorUnits(args.amountMinor, invoice.currency), actorId: user._id,
    branchId: membership.branchId, invoiceSaleId: sale._id });
}

export async function reserveSaleInvoiceReceiptHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    receiptMovementId: Id<"receiptMovements">;
    amountMinor: number;
    idempotencyKey: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  assertSaleInvoiceReceiptDoorsAllowed();
  const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.saleId);
  // A stored command result must not make a cancelled sale look newly
  // reservable on replay. The writer repeats its full proof inside the
  // idempotency boundary for the first execution.
  if (sale.status !== "COMPLETED") {
    throw new ConvexError("This sale cannot accept a customer invoice receipt.");
  }
  await requireOwnedRow(ctx, args.orgId, "receiptMovements", args.receiptMovementId);
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("Choose a positive customer credit amount.");
  }
  const applicationId = await runWithIdempotency(ctx, {
    orgId: args.orgId, operation: "collections.reserveSaleInvoiceReceipt", economic: true,
    idempotencyKey: args.idempotencyKey, actorId: user._id,
    fingerprint: JSON.stringify([args.saleId, args.receiptMovementId, args.amountMinor]),
  }, () => reservePendingInvoiceReceipt(ctx, {
    orgId: args.orgId, saleId: args.saleId,
    receiptMovementId: args.receiptMovementId,
    amountMinor: args.amountMinor, actorId: user._id,
  }));
  const application = await requireOwnedRow(ctx, args.orgId, "invoiceReceiptApplications", applicationId);
  if (application.status !== "PENDING" || application.saleId !== args.saleId ||
    application.receiptMovementId !== args.receiptMovementId || application.amountMinor !== args.amountMinor) {
    throw new ConvexError("This invoice receipt reservation is no longer pending.");
  }
  return applicationId;
}

export async function activateSaleInvoiceReceiptHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"invoiceReceiptApplications">;
    amountMinor: number;
    idempotencyKey: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  assertSaleInvoiceReceiptDoorsAllowed();
  const application = await requireOwnedRow(ctx, args.orgId, "invoiceReceiptApplications", args.applicationId);
  if (application.status !== "PENDING" && application.status !== "ACTIVE") {
    throw new ConvexError("This invoice receipt application is no longer available.");
  }
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("Choose a positive invoice application amount.");
  }
  return runWithIdempotency(ctx, {
    orgId: args.orgId, operation: "collections.activateSaleInvoiceReceipt", economic: true,
    idempotencyKey: args.idempotencyKey, actorId: user._id,
    fingerprint: JSON.stringify([args.applicationId, args.amountMinor]),
  }, () => activatePendingInvoiceReceipt(ctx, {
    orgId: args.orgId, applicationId: args.applicationId,
    amountMinor: args.amountMinor, actorId: user._id,
  }));
}
