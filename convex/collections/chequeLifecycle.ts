import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { pendingSaleInvoiceReceiptMinor } from "../accounting/invoiceReceiptReservation";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { getReceivableOutstandingMinor } from "../utils/subledgerAllocations";
import { assertNoOpenSaleInvoiceForUnlinkedReceipt } from "../utils/cashSalePilotGate";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { FC_RETURN_MESSAGES, isFcLineage } from "../utils/fcCheque";
import { toMinorUnits } from "../utils/money";
import { getActorName, notifyManagers } from "../utils/notifications";
import { PERMISSIONS } from "../utils/permissions";
import { RETAINED_CREDIT_MESSAGES } from "../utils/retainedCreditMessages";
import { assertReceivableNotSaleLinked } from "../utils/saleDebtContainment";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import { assertCustomerChequeNotSaleLinked, validateOptionalLinks, validateOrgCustomer } from "./collectionLinks";
import { queueCustomerReminder } from "./reminderQueue";
import { ConvexError } from "convex/values";

/**
 * Shared cheque-registration core, reused by the registerCheque mutation
 * (MANAGE_FINANCE-gated, for Collections) and applications.registerExpectedPayment
 * (REGISTER_EXPECTED_PAYMENT-gated, for the pre-finalize payment step) — each
 * caller does its own permission check before calling this.
 */
export async function registerChequeInTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId?: Id<"receivables">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    invoiceSaleId?: Id<"sales">;
    applicationId?: Id<"financeApplications">;
    bank: string;
    chequeNumber: string;
    chequeDate: number;
    amount: number;
    notes?: string;
    actorId: Id<"users">;
    branchId?: Id<"branches">;
    /** SCRUM-447: the recorded face (minor units) and its denomination. */
    amountMinor?: number;
    currency?: string;
    /** SCRUM-447: drawer and lineage, written on every new FC row. */
    drawerType?: "FINANCE_COMPANY";
    financeCompanyId?: Id<"financeCompanies">;
    originApplicationId?: Id<"financeApplications">;
  }
) {
  assertPositiveAmount(args.amount);
  if (!args.bank.trim() || !args.chequeNumber.trim()) {
    throw new ConvexError("Bank and cheque number are required.");
  }

  const chequeCustomer = await validateOrgCustomer(ctx, args.orgId, args.customerId);
  // SCRUM-121A-PRE §3.3 — no NEW financial instrument against a withdrawn
  // payer. Registering a cheque creates a future claim on someone the
  // dealership has already removed, and `customers.softDelete` permits the
  // withdrawal while money is still owed.
  //
  // This lives in the shared core rather than the public `registerCheque`
  // wrapper on purpose: `applications.registerExpectedPayment` reaches this
  // same function under its own permission, so a guard placed in the wrapper
  // would leave that door open while looking closed.
  if (chequeCustomer.isDeleted) {
    throw new ConvexError("This customer has been removed and cannot have new cheques registered.");
  }
  await validateOptionalLinks(ctx, args.orgId, {
    vehicleId: args.vehicleId,
    saleId: args.saleId,
    applicationId: args.applicationId,
  });
  // SCRUM-571 R3 (D-20): a caller-supplied saleId is refused (finance-company
  // registration via applications.registerExpectedPayment passes none). No
  // write has happened yet.
  assertReceivableNotSaleLinked(null, args.saleId);
  // SCRUM-802: a customer cheque is customer money too — park nothing against an open sale invoice. A finance
  // company's cheque is the financier's money, not the customer's, so that drawer is exempt.
  if (args.drawerType !== "FINANCE_COMPANY") {
    await assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, args.orgId, {
      receivableId: args.receivableId,
      invoiceSaleId: args.invoiceSaleId,
      customerId: args.customerId,
    });
  }

  let receivable: Doc<"receivables"> | null = null;
  if (args.receivableId) {
    receivable = await ctx.db.get(args.receivableId);
    if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
    // SCRUM-571 R3 (D-20): nor may a cheque attach to a sale-linked receivable.
    assertReceivableNotSaleLinked(receivable);
    if (receivable.customerId !== args.customerId) throw new ConvexError("Cheque customer must match receivable customer.");
    // SCRUM-121A-PRE §3.3 — a settled or voided debt cannot be given a new
    // instrument. This door checked organization and customer but never status,
    // so a cheque could be registered against a PAID, CANCELLED or REFUNDED
    // receivable and then CLEARED — and clearing runs `applyPostedPayment`,
    // which reopens the closed row. That is a pre-funds REGISTRATION refusal
    // and moves no money: it prevents the instrument that would later resurrect
    // the debt, rather than refusing a cheque that has already cleared.
    if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
      throw new ConvexError("This receivable is closed and cannot accept a new cheque.");
    }
    // Forward guard, and labelled as one: no production WRITER sets
    // `isDeleted` on a receivable today, so this cannot be reached through the
    // real doors. It is here because the field exists on the row and the
    // calendar reader at :562 already honours it, so the first writer that
    // appears must not find the money paths silently accepting a withdrawn
    // target.
    //
    // Not unreachable by the SUITE, though: `D10` constructs the state directly
    // and exercises both this and its twin in recordPayment, so a mutation here
    // is killed rather than surviving as dead code.
    if (receivable.isDeleted) {
      throw new ConvexError("This receivable has been removed and cannot accept a new cheque.");
    }
    if (args.vehicleId && receivable.vehicleId && args.vehicleId !== receivable.vehicleId) {
      throw new ConvexError("Cheque vehicle does not match the receivable vehicle.");
    }
    if (args.saleId && receivable.saleId && args.saleId !== receivable.saleId) {
      throw new ConvexError("Cheque sale does not match the receivable sale.");
    }
  }

  const existingCheques = await ctx.db
    .query("postDatedCheques")
    .withIndex("by_org_bank_and_chequeNumber", (q) =>
      q.eq("orgId", args.orgId).eq("bank", args.bank.trim()).eq("chequeNumber", args.chequeNumber.trim())
    )
    .collect();
  const hasActiveDuplicate = existingCheques.some((c) => !c.isDeleted && c.status !== "CANCELLED");
  if (hasActiveDuplicate) {
    throw new ConvexError("A cheque with this bank and number already exists.");
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const now = Date.now();
  return await ctx.db.insert("postDatedCheques", {
    orgId: args.orgId,
    branchId: args.branchId,
    receivableId: receivable?._id,
    customerId: args.customerId,
    vehicleId: receivable?.vehicleId ?? args.vehicleId,
    saleId: receivable?.saleId ?? args.saleId,
    invoiceSaleId: args.invoiceSaleId,
    applicationId: args.applicationId,
    ...(args.amountMinor !== undefined ? { amountMinor: args.amountMinor, currency: args.currency } : {}),
    ...(args.drawerType !== undefined ? { drawerType: args.drawerType } : {}),
    ...(args.financeCompanyId !== undefined ? { financeCompanyId: args.financeCompanyId } : {}),
    ...(args.originApplicationId !== undefined ? { originApplicationId: args.originApplicationId } : {}),
    bank: args.bank.trim(),
    chequeNumber: args.chequeNumber.trim(),
    chequeDate: args.chequeDate,
    // A recorded face is rounded in ITS denomination, not the org's: the deal's
    // currency can carry more decimals than the org's (SCRUM-447).
    amount: roundMoney(args.amount, args.amountMinor !== undefined && args.currency ? args.currency : currency),
    status: "HELD",
    notes: args.notes,
    createdBy: args.actorId,
    createdAt: now,
    updatedAt: now,
  });
}

export async function registerChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId?: Id<"receivables">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    bank: string;
    chequeNumber: string;
    chequeDate: number;
    amount: number;
    notes?: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  return await registerChequeInTransaction(ctx, { ...args, actorId: user._id, branchId: membership.branchId });
}

/**
 * What a sale-invoice cheque's sale currently allows (SCRUM-724).
 *   NONE                  the cheque is not tied to a sale invoice
 *   LIVE                  the sale is COMPLETED and its open invoice covers the cheque
 *   CANCELLED_SALE_CREDIT the sale was cancelled after the cheque was presented:
 *                         clearing posts DR Bank / CR 2110 and nothing else
 *   OVER_COVERED_CREDIT   the cheque was presented, then the COMPLETED sale's
 *                         invoice was covered by other money (Sol 6 Q2=A):
 *                         clearing posts DR Bank / CR 2110 for the whole face,
 *                         unreserved, with cheque + sale lineage; the invoice,
 *                         revenue and sale state are untouched
 * A HELD cheque the invoice cannot cover is refused (CHEQUE_INVOICE_UNCOVERED_HELD).
 */
type ChequeInvoiceIntent = "NONE" | "LIVE" | "CANCELLED_SALE_CREDIT" | "OVER_COVERED_CREDIT";

export async function assertChequeInvoiceIntentLive(
  ctx: MutationCtx,
  cheque: Doc<"postDatedCheques">
): Promise<ChequeInvoiceIntent> {
  if (!cheque.invoiceSaleId) return "NONE";
  const sale = await requireOwnedRow(ctx, cheque.orgId, "sales", cheque.invoiceSaleId);
  const invoice = sale.canonicalReceivableDocumentId
    ? await requireOwnedRow(ctx, cheque.orgId, "receivableDocuments", sale.canonicalReceivableDocumentId) : null;
  const currency = await getOrgCurrency(ctx, cheque.orgId);
  // Identity that must hold in BOTH modes. The denomination is proven from the
  // sale's canonical invoice (a sale-invoice cheque stores no currency of its own).
  const identityHolds = sale.customerId === cheque.customerId &&
    !cheque.receivableId && !cheque.saleId && !isFcLineage(cheque) &&
    !!invoice && invoice.sourceType === "sales" && invoice.sourceId === String(sale._id) &&
    invoice.documentType === "INVOICE" && invoice.payerType === "CUSTOMER" &&
    invoice.customerId === sale.customerId && invoice.currency.toUpperCase() === currency.toUpperCase();
  if (sale.status === "CANCELLED" && identityHolds) {
    // Only a cheque already presented to the bank can still clear; an unpresented
    // one goes back to the customer (owner ruling Q-DA07).
    if (cheque.status !== "DEPOSITED") {
      throwAppError(
        AppErrorCode.CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER,
        RETAINED_CREDIT_MESSAGES.CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER
      );
    }
    return "CANCELLED_SALE_CREDIT";
  }
  if (sale.status !== "COMPLETED" || !identityHolds || !invoice) {
    throw new ConvexError("This sale's customer cheque can no longer be advanced.");
  }
  const [outstanding, reserved] = await Promise.all([
    getReceivableOutstandingMinor(ctx, invoice._id),
    pendingSaleInvoiceReceiptMinor(ctx, cheque.orgId, sale._id),
  ]);
  if (toMinorUnits(cheque.amount, currency) > outstanding - reserved) {
    // Sol 6 Q2=A. An UNPRESENTED cheque the invoice can no longer cover must not
    // be deposited: it would reach the bank with nowhere to land. Once the bank
    // has it (DEPOSITED) the money is real and must book, never strand.
    if (cheque.status === "HELD") {
      throwAppError(
        AppErrorCode.CHEQUE_INVOICE_UNCOVERED_HELD,
        RETAINED_CREDIT_MESSAGES.CHEQUE_INVOICE_UNCOVERED_HELD
      );
    }
    return "OVER_COVERED_CREDIT";
  }
  return "LIVE";
}

export async function depositChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    chequeId: Id<"postDatedCheques">;
    depositedDate?: number;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  const cheque = await ctx.db.get(args.chequeId);
  if (!cheque || cheque.orgId !== args.orgId || cheque.isDeleted) throw new ConvexError("Cheque not found.");
  if (cheque.status !== "HELD") throw new ConvexError("Only held cheques can be deposited.");
  await assertChequeInvoiceIntentLive(ctx, cheque);
  // SCRUM-571 R4 (D-20): a sale-linked customer cheque cannot advance toward a
  // clearing that is itself refused. Finance-company cheques are unaffected.
  await assertCustomerChequeNotSaleLinked(ctx, cheque);
  // SCRUM-447 D4: depositing the finance company's cheque is legitimate on a
  // live deal, but a cancelled deal has no instrument left to present.
  const lineageAppId = cheque.applicationId ?? cheque.originApplicationId;
  if (lineageAppId) {
    const app = await ctx.db.get(lineageAppId);
    if (!app || app.orgId !== args.orgId || app.status === "CANCELLED") {
      throw new ConvexError(
        "This cheque belongs to a cancelled finance deal and cannot be deposited."
      );
    }
  }
  await ctx.db.patch(args.chequeId, {
    status: "DEPOSITED",
    depositedDate: args.depositedDate ?? Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * Shared state-transition core for marking a cheque CLEARED — used both by
 * the ordinary `clearCheque` mutation (legacy collections/GL flow below) and
 * by `applications.confirmDisbursement` (canonical finance-company flow),
 * which needs to transition an application-linked cheque without any of the
 * legacy collectionPayments/GL posting clearCheque does afterward.
 */
export async function markChequeClearedInTransaction(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; chequeId: Id<"postDatedCheques">; clearedAt?: number; idempotencyKey?: string }
): Promise<Doc<"postDatedCheques">> {
  const cheque = await ctx.db.get(args.chequeId);
  if (!cheque || cheque.orgId !== args.orgId || cheque.isDeleted) throw new ConvexError("Cheque not found.");
  if (cheque.status !== "HELD" && cheque.status !== "DEPOSITED") {
    throw new ConvexError("Only held or deposited cheques can be cleared.");
  }
  await assertChequeInvoiceIntentLive(ctx, cheque);

  const clearedAt = args.clearedAt ?? Date.now();
  const patch: Partial<Doc<"postDatedCheques">> = {
    status: "CLEARED",
    clearedAt,
    depositedDate: cheque.depositedDate ?? clearedAt,
    updatedAt: Date.now(),
  };
  if (args.idempotencyKey !== undefined) patch.idempotencyKey = args.idempotencyKey;
  await ctx.db.patch(args.chequeId, patch);

  return { ...cheque, ...patch };
}

export async function returnChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    chequeId: Id<"postDatedCheques">;
    returnedAt?: number;
    returnReason?: string;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  const cheque = await ctx.db.get(args.chequeId);
  if (!cheque || cheque.orgId !== args.orgId) {
    throwAppError(AppErrorCode.CHEQUE_NOT_FOUND, FC_RETURN_MESSAGES.CHEQUE_NOT_FOUND);
  }
  // SCRUM-239: RETURNED is terminal for returning, whichever door recorded it
  // (this one, or the deal's "Cheque returned by bank"). A second return would
  // overwrite returnedAt/returnReason, re-notify managers and - for a customer
  // cheque - re-flag the receivable and queue another reminder.
  if (cheque.status === "RETURNED") {
    throwAppError(AppErrorCode.CHEQUE_ALREADY_RETURNED, FC_RETURN_MESSAGES.CHEQUE_ALREADY_RETURNED);
  }
  if (cheque.status === "CLEARED" || cheque.status === "REPLACED" || cheque.status === "CANCELLED") {
    throwAppError(AppErrorCode.CHEQUE_NOT_RETURNABLE, FC_RETURN_MESSAGES.CHEQUE_NOT_RETURNABLE);
  }

  await ctx.db.patch(args.chequeId, {
    status: "RETURNED",
    returnedAt: args.returnedAt ?? Date.now(),
    returnReason: args.returnReason,
    updatedAt: Date.now(),
  });

  // SCRUM-447 D5': a finance-company cheque bouncing is the finance company's
  // problem, not the customer's. Neither the customer's receivable nor the
  // customer's phone is touched; managers are still told below.
  if (cheque.receivableId && !isFcLineage(cheque)) {
    const receivable = await ctx.db.get(cheque.receivableId);
    if (receivable && receivable.status !== "PAID") {
      await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: Date.now() });
      await queueCustomerReminder(ctx, {
        orgId: args.orgId,
        customerId: cheque.customerId,
        receivableId: receivable._id,
        chequeId: cheque._id,
        messageType: "CHEQUE_RETURNED",
      });
    }
  }

  const actorName = await getActorName(ctx);
  await notifyManagers(ctx, args.orgId, "collection.cheque_returned", {
    actorName,
    amount: String(cheque.amount),
  }, { link: `/${args.orgId}/accounting` });
}
