import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { reservePendingInvoiceReceipt } from "../accounting/invoiceReceiptReservation";
import { RETAINED_CREDIT_SYSTEM_KEY, sealReceiptMovement } from "../accounting/receiptMovement";
import { directCollectionReceipt } from "../accounting/receiptOccurrence";
import { getOrgCurrency, postReceiptOccurrence } from "../accounting/workflowHooks";
import { assertValidAccountingDate } from "../utils/accountingDate";
import { requireActiveBankInCurrency } from "../utils/bankAccountGuards";
import { areSaleInvoiceReceiptDoorsDisabled } from "../utils/customerCreditPayoutContainment";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { isFcLineage } from "../utils/fcCheque";
import { runWithIdempotency } from "../utils/idempotency";
import { PERMISSIONS } from "../utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { insertLedgerTransaction, mirrorCollectionPaymentToCanonical } from "./canonicalReceivables";
import { assertChequeInvoiceIntentLive, markChequeClearedInTransaction } from "./chequeLifecycle";
import { assertCustomerChequeNotSaleLinked } from "./collectionLinks";
import { applyPostedPayment, assertOpeningReceivableDate } from "./receivableState";

export async function clearChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    chequeId: Id<"postDatedCheques">;
    bankAccountId?: Id<"bankAccounts">;
    clearedAt?: number;
    idempotencyKey: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  // SCRUM-571 R3 (D-20): clearing a sale-linked customer cheque would post a
  // receipt against sale lineage. Refused BEFORE the idempotency wrapper so a
  // stored replay is refused too. A missing/foreign cheque falls through to the
  // body's own "Cheque not found."
  const chequeToClear = await requireOwnedRow(ctx, args.orgId, "postDatedCheques", args.chequeId, "Cheque not found.");
  if (chequeToClear.isDeleted) throw new ConvexError("Cheque not found.");
  const effectiveDate = args.clearedAt ?? Date.now();
  assertValidAccountingDate(effectiveDate, "Clearance date");
  await assertOpeningReceivableDate(ctx, args.orgId, chequeToClear.receivableId, effectiveDate);
  await assertCustomerChequeNotSaleLinked(ctx, chequeToClear);
  if (chequeToClear.status === "HELD" || chequeToClear.status === "DEPOSITED") {
    await assertChequeInvoiceIntentLive(ctx, chequeToClear);
  }
  if (isFcLineage(chequeToClear)) {
    throw new ConvexError("This finance-company cheque cannot be cleared from customer collections — confirm disbursement from the Applications page instead.");
  }
  // Also refuse an old unbanked idempotency replay: a prior completion without
  // physical-bank evidence cannot become a valid banked clearance by replay.
  if (!args.bankAccountId) {
    throwAppError(AppErrorCode.CHEQUE_CLEAR_BANK_INVALID, "Select the bank account this cheque was cleared into.");
  }
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.clearCheque",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify({
        chequeId: args.chequeId,
        clearedAt: args.clearedAt ?? null,
        bankAccountId: args.bankAccountId,
      }),
    },
    async () => {
      const currency = await getOrgCurrency(ctx, args.orgId);
      const bankAccountId = await requireActiveBankInCurrency(ctx, {
        orgId: args.orgId,
        bankAccountId: args.bankAccountId,
        currency,
        missingMessage: "Select the bank account this cheque was cleared into.",
        currencySubject: "organization",
        errorCode: AppErrorCode.CHEQUE_CLEAR_BANK_INVALID,
      });
      const existingCheque = await ctx.db.get(args.chequeId);
      if (!existingCheque || existingCheque.orgId !== args.orgId || existingCheque.isDeleted) {
        throw new ConvexError("Cheque not found.");
      }
      // SCRUM-447 D9: keyed on FC LINEAGE, not on applicationId presence. A
      // cheque whose applicationId was cleared by the pre-447 replaceCheque, or
      // that carries only originApplicationId / drawerType, is still the
      // finance company's instrument and must not settle a customer receivable.
      if (isFcLineage(existingCheque)) {
        throw new ConvexError(
          `This finance-company cheque${
            existingCheque.applicationId ? ` (finance application ${existingCheque.applicationId})` : ""
          } cannot be cleared from customer collections — confirm disbursement from the Applications page instead.`
        );
      }

      // SCRUM-724: decided BEFORE the cheque moves. A cheque presented before
      // its sale was cancelled still clears; the money is then customer credit
      // (2110) that nothing reserves, never a payment on the cancelled sale.
      const invoiceIntent = await assertChequeInvoiceIntentLive(ctx, existingCheque);
      const cheque = await markChequeClearedInTransaction(ctx, {
        orgId: args.orgId,
        chequeId: args.chequeId,
        clearedAt: args.clearedAt,
        idempotencyKey: args.idempotencyKey,
      });
      const clearedAt = cheque.clearedAt!;

      let receivable: Doc<"receivables"> | null = null;
      if (cheque.receivableId) {
        receivable = await ctx.db.get(cheque.receivableId);
        if (receivable && cheque.amount > receivable.outstandingAmount) {
          throw new ConvexError("Cheque amount cannot exceed the outstanding receivable amount.");
        }
      }

      const paymentId = await ctx.db.insert("collectionPayments", {
        orgId: args.orgId,
        branchId: membership.branchId,
        receivableId: cheque.receivableId,
        customerId: cheque.customerId,
        vehicleId: cheque.vehicleId,
        saleId: cheque.saleId,
        chequeId: args.chequeId,
        direction: "IN",
        method: "CHEQUE",
        amount: cheque.amount,
        paymentDate: clearedAt,
        paymentDateKind: "instant",
        status: "POSTED",
        idempotencyKey: args.idempotencyKey,
        reference: `${cheque.bank} #${cheque.chequeNumber}`,
        cashierId: user._id,
        createdAt: Date.now(),
      });

      if (receivable) {
        await applyPostedPayment(ctx, receivable, cheque.amount, clearedAt, currency);
      }

      await insertLedgerTransaction(ctx, {
        orgId: args.orgId,
        direction: "IN",
        amount: cheque.amount,
        date: clearedAt,
        description: `Cleared cheque ${cheque.bank} #${cheque.chequeNumber}`,
        vehicleId: cheque.vehicleId,
        userId: user._id,
        category: "COLLECTION_PAYMENT",
        idempotencyKey: args.idempotencyKey,
      });

      // Post to the GL: a cleared cheque deposits funds into the bank, and
      // that money either settles a receivable or becomes retained customer
      // credit (DR Bank / CR AR and/or CR 2110 — SCRUM-218-C). Booked as a
      // COLLECTION_PAYMENT so the return-after-clearing flow can reverse it by
      // its source event. Posts now, or enqueues to the outbox if the chart /
      // period is not yet set up.
      //
      // A cheque may carry no receivable — `cheque.receivableId` is optional
      // and guarded everywhere in this file — so this path reaches the
      // no-receivable shape exactly as `recordPayment` does.
      const payment = await ctx.db.get(paymentId);
      if (!payment) {
        throw new ConvexError("Collection payment could not be re-read within its own transaction.");
      }
      const mirrored = await mirrorCollectionPaymentToCanonical(ctx, {
        paymentId,
        payment,
        receivable,
        actorId: user._id,
        currency,
      });

      // SCRUM-236 — same single forward producer as `recordPayment`. See the
      // note there: identity built inside this invocation, never cached, and
      // this call must not be caught, because its refusal is only safe if it
      // escapes the mutation and rolls back the writes above.
      //
      // `paymentMethod: "BANK_TRANSFER"` is carried over unchanged from the
      // retired hook call. A cleared cheque deposits into the bank, so the
      // posting rule must resolve the bank account and not the cash account;
      // this is the existing production behavior and SCRUM-236 does not
      // change it.
      const receiptIdentity = directCollectionReceipt({ orgId: args.orgId, paymentId });

      // SCRUM-218-C — identical sealing to `recordPayment`; see the note there.
      const { movementId, split } = await sealReceiptMovement(ctx, {
        identity: receiptIdentity,
        orgId: args.orgId,
        collectionPaymentId: paymentId,
        canonicalPaymentId: mirrored.canonicalPaymentId,
        customerId: cheque.customerId,
        currency,
        allocationIds: mirrored.paymentAllocationId ? [mirrored.paymentAllocationId] : [],
        actorId: user._id,
        // SCRUM-724: immutable cheque + originating-sale lineage, for both a
        // clear before and a clear after the sale's cancellation.
        ...(cheque.invoiceSaleId
          ? { lineage: { sourceChequeId: cheque._id, originatingSaleId: cheque.invoiceSaleId } }
          : {}),
      });

      await postReceiptOccurrence(ctx, {
        identity: receiptIdentity,
        currency,
        occurredAt: clearedAt,
        actorId: user._id,
        requiredSystemKeys: split.unappliedMinor > 0 ? [RETAINED_CREDIT_SYSTEM_KEY] : [],
        payload: {
          paymentId: paymentId.toString(),
          receivedMinor: split.receivedMinor,
          appliedMinor: split.appliedMinor,
          unappliedMinor: split.unappliedMinor,
          currency,
          customerId: cheque.customerId.toString(),
          paymentMethod: "BANK_TRANSFER",
          bankAccountId: bankAccountId.toString(),
        },
      });

      // Reservation is a new claim on 2110 credit: only a LIVE intent, and
      // only while the pilot invoice-door switch is off. Otherwise the whole
      // face stays unreserved credit (SCRUM-724 Sol 6 Q1/Q2).
      if (cheque.invoiceSaleId && invoiceIntent === "LIVE" && !areSaleInvoiceReceiptDoorsDisabled()) {
        await reservePendingInvoiceReceipt(ctx, {
          orgId: args.orgId, saleId: cheque.invoiceSaleId,
          receiptMovementId: movementId, amountMinor: split.unappliedMinor,
          actorId: user._id,
        });
      }

      return paymentId;
    }
  );
}
