import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertNoOpenSaleInvoiceForUnlinkedReceipt } from "../utils/cashSalePilotGate";
import { assertNoActiveDealUnwind } from "../utils/dealUnwindGuard";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { dealChequeCurrency, FC_CHEQUE_DEAL_NEXT_STEP, isFcLineage, parseFaceAmountMinor } from "../utils/fcCheque";
import { fromMinorUnits } from "../utils/money";
import { PERMISSIONS } from "../utils/permissions";
import { RETAINED_CREDIT_MESSAGES } from "../utils/retainedCreditMessages";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import { assertCustomerChequeNotSaleLinked } from "./collectionLinks";
import { ConvexError } from "convex/values";

export async function replaceChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    chequeId: Id<"postDatedCheques">;
    bank: string;
    chequeNumber: string;
    chequeDate: number;
    amount?: number;
    faceAmount?: string;
    notes?: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  const oldCheque = await ctx.db.get(args.chequeId);
  if (!oldCheque || oldCheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
  // SCRUM-447 D9a: REPLACED is terminal for replacement, whatever the lineage.
  // A second replacement of the same row would fork the chain, and a pre-447
  // row lost its applicationId when it was replaced, so its lineage cannot be
  // re-established from the row itself.
  if (oldCheque.status === "REPLACED") {
    throw new ConvexError("This cheque was already replaced — act on its replacement instead.");
  }
  if (oldCheque.status === "CLEARED" || oldCheque.status === "CANCELLED") {
    throw new ConvexError("Cleared or cancelled cheques cannot be replaced.");
  }
  // SCRUM-571 R4 (D-20): the replacement would copy `saleId` onto a new HELD
  // instrument whose clearing is refused. Finance-company cheques unaffected.
  await assertCustomerChequeNotSaleLinked(ctx, oldCheque);

  // SCRUM-724: a sale-invoice cheque's replacement keeps that link (it was
  // silently dropped, orphaning the replacement from the sale and from the
  // credit lineage). The link is re-validated, and a cancelled sale's cheque
  // is not replaced: the instrument goes back to the customer.
  let replacementInvoiceSaleId: Id<"sales"> | undefined;
  if (oldCheque.invoiceSaleId) {
    const linkedSale = await requireOwnedRow(ctx, args.orgId, "sales", oldCheque.invoiceSaleId);
    if (linkedSale.customerId !== oldCheque.customerId) {
      throw new ConvexError("This sale's customer cheque can no longer be advanced.");
    }
    if (linkedSale.status === "CANCELLED") {
      throwAppError(
        AppErrorCode.CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER,
        RETAINED_CREDIT_MESSAGES.CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER
      );
    }
    replacementInvoiceSaleId = linkedSale._id;
  }

  const fcLineage = isFcLineage(oldCheque);
  let amount: number;
  let faceFields: { amountMinor: number; currency: string } | null = null;
  let lineageFields: {
    applicationId: Id<"financeApplications">;
    originApplicationId: Id<"financeApplications">;
    drawerType?: "FINANCE_COMPANY";
    financeCompanyId?: Id<"financeCompanies">;
  } | null = null;

  if (fcLineage) {
    // SCRUM-447 D9: a finance-company cheque is replaced only while its deal is
    // live AND it is the live instrument of a still-registered CHEQUE payment.
    // Anything else is re-registered on the deal.
    if (!oldCheque.applicationId) {
      throw new ConvexError(`${FC_CHEQUE_DEAL_NEXT_STEP} It is no longer linked to a live deal, so it cannot be replaced.`);
    }
    const app = await ctx.db.get(oldCheque.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");
    if (app.status === "CANCELLED") {
      throw new ConvexError("This cheque belongs to a cancelled finance deal and cannot be replaced.");
    }
    // SCRUM-693: an unwind clears disbursedAt mid-flight; it alone owns the deal then.
    await assertNoActiveDealUnwind(ctx, args.orgId, app._id);
    if (app.disbursedAt) {
      throw new ConvexError("This deal's disbursement is already confirmed, so its cheque cannot be replaced.");
    }
    if (oldCheque.status === "DEPOSITED") {
      throw new ConvexError(
        "This finance-company cheque is deposited. Record its return first, then correct the expected payment on the deal."
      );
    }
    if (oldCheque.status !== "HELD" || app.expectedPaymentMethod !== "CHEQUE") {
      throw new ConvexError(
        "This finance-company cheque is no longer the deal's registered payment. Correct the expected payment and register a new cheque from the deal."
      );
    }
    const currency = await dealChequeCurrency(ctx, app, await getOrgCurrency(ctx, args.orgId));
    const amountMinor = parseFaceAmountMinor(args.faceAmount, currency);
    amount = fromMinorUnits(amountMinor, currency);
    faceFields = { amountMinor, currency };
    lineageFields = {
      applicationId: oldCheque.applicationId,
      originApplicationId: oldCheque.originApplicationId ?? oldCheque.applicationId,
      // A legacy row whose drawer history cannot be proven stays UNVERIFIED.
      drawerType: oldCheque.drawerType,
      financeCompanyId: oldCheque.financeCompanyId,
    };
  } else {
    if (args.amount === undefined) throw new ConvexError("Cheque amount is required.");
    assertPositiveAmount(args.amount);
    amount = args.amount;
  }

  // SCRUM-802: the replacement is a NEW customer instrument; an unlinked one would park customer money against an
  // open sale invoice exactly like a new registration, so it takes the same gate. A finance-company cheque is
  // the financier's money and is exempt, as in registerChequeInTransaction. Refusing strands nothing: the held cheque stays
  // as it is and the customer's payment is recorded as a deposit (the pilot procedure).
  if (!fcLineage) {
    await assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, args.orgId, {
      receivableId: oldCheque.receivableId,
      invoiceSaleId: replacementInvoiceSaleId,
      customerId: oldCheque.customerId,
    });
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const now = Date.now();
  const newChequeId = await ctx.db.insert("postDatedCheques", {
    orgId: args.orgId,
    branchId: membership.branchId,
    receivableId: oldCheque.receivableId,
    customerId: oldCheque.customerId,
    vehicleId: oldCheque.vehicleId,
    saleId: oldCheque.saleId,
    ...(replacementInvoiceSaleId ? { invoiceSaleId: replacementInvoiceSaleId } : {}),
    // SCRUM-447 D0: lineage is COPIED, never transferred. The old row keeps
    // its applicationId; "the application's live cheque" is a status
    // predicate (liveChequesForApplication), so exactly one HELD/DEPOSITED
    // row remains after this transaction.
    ...(lineageFields ?? {}),
    ...(faceFields ?? {}),
    bank: args.bank.trim(),
    chequeNumber: args.chequeNumber.trim(),
    chequeDate: args.chequeDate,
    // The face is rounded in its own denomination when one was recorded.
    amount: roundMoney(amount, faceFields?.currency ?? currency),
    status: "HELD",
    notes: args.notes,
    createdBy: user._id,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(args.chequeId, {
    status: "REPLACED",
    replacementChequeId: newChequeId,
    ...(lineageFields ? { originApplicationId: lineageFields.originApplicationId } : {}),
    updatedAt: now,
  });

  return newChequeId;
}
