import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { pendingSaleInvoiceReceiptMinor, reservePendingInvoiceReceipt } from "../accounting/invoiceReceiptReservation";
import { RETAINED_CREDIT_SYSTEM_KEY, sealReceiptMovement } from "../accounting/receiptMovement";
import { directCollectionReceipt } from "../accounting/receiptOccurrence";
import { getOrgCurrency, postReceiptOccurrence } from "../accounting/workflowHooks";
import { assertValidAccountingDate } from "../utils/accountingDate";
import { getReceivableOutstandingMinor } from "../utils/subledgerAllocations";
import { listEligibleBanks, requireActiveBankInCurrency } from "../utils/bankAccountGuards";
import { assertNoOpenSaleInvoiceForUnlinkedReceipt } from "../utils/cashSalePilotGate";
import { assertSaleInvoiceReceiptDoorsAllowed } from "../utils/customerCreditPayoutContainment";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { runWithIdempotency } from "../utils/idempotency";
import { toMinorUnits } from "../utils/money";
import { getActorName, notifyManagers } from "../utils/notifications";
import { paymentDateKindOfCalendarInput } from "../utils/orgBusinessDay";
import { PERMISSIONS } from "../utils/permissions";
import { assertReceiptTargetNotSaleLinked } from "../utils/saleDebtContainment";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import { insertLedgerTransaction, mirrorCollectionPaymentToCanonical } from "./canonicalReceivables";
import { validateOptionalLinks, validateOrgCustomer } from "./collectionLinks";
import { applyPostedPayment, assertOpeningReceivableDate } from "./receivableState";
import type { paymentMethodValidator } from "./validators";

export async function listReceiptBankOptionsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    currency?: string;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  return await listEligibleBanks(ctx, args.orgId,
    args.currency?.trim().toUpperCase() || await getOrgCurrency(ctx, args.orgId));
}

export async function recordPaymentHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId?: Id<"receivables">;
    customerId?: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    invoiceSaleId?: Id<"sales">;
    amount: number;
    method: Infer<typeof paymentMethodValidator>;
    bankAccountId?: Id<"bankAccounts">;
    paymentDate: number;
    reference?: string;
    notes?: string;
    idempotencyKey: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  assertValidAccountingDate(args.paymentDate, "Payment date");
  await assertOpeningReceivableDate(ctx, args.orgId, args.receivableId, args.paymentDate);
  const receiptReachesBank = args.method === "BANK_TRANSFER" || args.method === "CARD";
  if (args.bankAccountId && !receiptReachesBank) {
    throw new ConvexError("A bank account applies only to bank transfer or card receipts.");
  }
  // SCRUM-724 Sol 6 Q1: a receipt bound to a sale invoice is a new claim on
  // 2110 credit. Refused before anything else and before the idempotency
  // wrapper; a plain receipt (no invoiceSaleId) is the existing door.
  if (args.invoiceSaleId) assertSaleInvoiceReceiptDoorsAllowed();
  // SCRUM-263: this is a receipt door, so it records only money that arrives.
  // A deposit application moves deposit liability already held; recorded here
  // it posted through the cash-on-hand default and invented cash, leaving the
  // real deposit free to be applied again. Refused BEFORE the idempotency
  // wrapper, because a replay of a call completed before this guard existed
  // returns its stored result without ever reaching the body (Sol D1).
  if (args.method === "DEPOSIT_APPLIED") {
    throw new ConvexError("A deposit is applied from the deal, not recorded as a new payment.");
  }
  // SCRUM-571 S1 (c21732): payment-link money arrives only through
  // `paymentIntents` settlement. A manually recorded PAYMENT_LINK receipt
  // posts through the wrong door and credits customer AR with no intent to
  // tie it to. Refused BEFORE the idempotency wrapper for the same reason as
  // the guard above: a replay of a call completed before this guard existed
  // returns its stored result without reaching the body.
  if (args.method === "PAYMENT_LINK") {
    throwAppError(
      AppErrorCode.PAYMENT_LINK_RECEIPT_MANUAL_REFUSED,
      "A payment-link receipt cannot be recorded manually. It is recorded automatically when the payment link is settled. Nothing has been changed."
    );
  }
  // SCRUM-571 R1 (D-20): a sale's debt is its sale invoice, so a receipt may
  // neither target a legacy receivable that carries a saleId nor carry a
  // caller-supplied saleId (that attribution would be silently wrong or
  // dropped until the invoice receipt resolver exists). Refused BEFORE the
  // idempotency wrapper for the same replay reason as the guards above.
  await assertReceiptTargetNotSaleLinked(ctx, args.orgId, {
    receivableId: args.receivableId,
    saleId: args.saleId,
  });
  // SCRUM-802: an UNLINKED receipt (no receivable, no sale) from a customer who
  // owes a sale invoice would park as unapplied while the invoice stays open;
  // the pilot procedure is a deposit. Same pre-wrapper placement as above.
  await assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, args.orgId, {
    receivableId: args.receivableId,
    invoiceSaleId: args.invoiceSaleId,
    customerId: args.customerId,
  });
  const validateInvoiceIntent = async () => {
    if (args.invoiceSaleId) {
      const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.invoiceSaleId);
      const invoice = sale.canonicalReceivableDocumentId
        ? await requireOwnedRow(ctx, args.orgId, "receivableDocuments", sale.canonicalReceivableDocumentId) : null;
      if (args.receivableId || args.saleId || !args.customerId || sale.customerId !== args.customerId ||
        sale.status !== "COMPLETED" || !invoice || invoice.sourceType !== "sales" ||
        invoice.sourceId !== String(sale._id) || invoice.documentType !== "INVOICE" ||
        invoice.payerType !== "CUSTOMER" || invoice.customerId !== sale.customerId ||
        invoice.currency.toUpperCase() !== (await getOrgCurrency(ctx, args.orgId)).toUpperCase()) {
        throw new ConvexError("This sale has no eligible customer invoice for this receipt.");
      }
      const [outstanding, reserved] = await Promise.all([
        getReceivableOutstandingMinor(ctx, invoice._id),
        pendingSaleInvoiceReceiptMinor(ctx, args.orgId, sale._id),
      ]);
      const amountMinor = toMinorUnits(args.amount, invoice.currency);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > outstanding - reserved) {
        throw new ConvexError("The receipt exceeds the available customer invoice amount.");
      }
    }
  };
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.recordPayment",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // Amount, counterparty, source and effective date, plus the identifiers
      // that decide WHICH debt the money lands on — changing any of them is a
      // different economic instruction, never a retry of this one.
      fingerprint: JSON.stringify({
        receivableId: args.receivableId ?? null,
        customerId: args.customerId ?? null,
        vehicleId: args.vehicleId ?? null,
        saleId: args.saleId ?? null,
        invoiceSaleId: args.invoiceSaleId ?? null,
        amount: args.amount,
        method: args.method,
        ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
        paymentDate: args.paymentDate,
        reference: args.reference?.trim() || null,
      }),
    },
    async () => {
      assertPositiveAmount(args.amount);
      if (args.method === "REFUND") throw new ConvexError("Refunds require manager approval.");
      if (args.method === "OTHER") {
        throw new ConvexError("Select a specific payment method — OTHER is not accepted for recording a payment.");
      }
      await validateInvoiceIntent();

      let receivable: Doc<"receivables"> | null = null;
      if (args.receivableId) {
        receivable = await ctx.db.get(args.receivableId);
        if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
        if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
          throw new ConvexError("This receivable can no longer accept payments.");
        }
        if (args.amount > receivable.outstandingAmount) {
          throw new ConvexError("Payment amount cannot exceed the outstanding receivable amount.");
        }
        // SCRUM-121A-PRE §3.1 — a contradictory caller identity is refused,
        // not silently discarded.
        //
        // The derivation below reads `receivable?.x ?? args.x`, so when the
        // caller named a DIFFERENT customer, vehicle or sale than the
        // receivable carries, the row quietly won and the caller's identity
        // vanished. `validateOptionalLinks` never closed this: it proves each
        // link exists and belongs to the org independently, and never that two
        // links describe the same debt. `registerChequeInTransaction` already refuses
        // the same contradiction for the customer, so one file held both
        // answers.
        //
        // Only a genuine conflict refuses. A value the receivable does not
        // carry is not a contradiction, so caller-supplied links still fill
        // gaps exactly as before.
        if (args.customerId && args.customerId !== receivable.customerId) {
          throw new ConvexError("Payment customer does not match the receivable customer.");
        }
        if (args.vehicleId && receivable.vehicleId && args.vehicleId !== receivable.vehicleId) {
          throw new ConvexError("Payment vehicle does not match the receivable vehicle.");
        }
        if (args.saleId && receivable.saleId && args.saleId !== receivable.saleId) {
          throw new ConvexError("Payment sale does not match the receivable sale.");
        }
        // Forward guard (§3.3), unreachable today — see the identical note in
        // registerChequeInTransaction. No production writer soft-deletes a receivable.
        if (receivable.isDeleted) {
          throw new ConvexError("This receivable has been removed and can no longer accept payments.");
        }
      }

      const customerId = receivable?.customerId ?? args.customerId;
      if (!customerId) throw new ConvexError("Customer is required when no receivable is selected.");
      await validateOrgCustomer(ctx, args.orgId, customerId);

      const vehicleId = receivable?.vehicleId ?? args.vehicleId;
      const saleId = receivable?.saleId ?? args.saleId;
      await validateOptionalLinks(ctx, args.orgId, { vehicleId, saleId });

      // SCRUM-121A-PRE §3.1 — a link the CALLER filled in may not contradict
      // what the selected debt already implies.
      //
      // Two shapes reach this. The no-receivable one is supported and tested,
      // and nothing correlated its links: customer A plus a sale belonging to
      // customer B stored cleanly, attributing the canonical payment to A
      // while every operational reader showed B's deal.
      //
      // The second was the cross-family seat's finding, and it is the same
      // defect one level indirect. The contradiction checks above compare
      // LIKE-NAMED fields, so they see nothing when the receivable carries no
      // sale of its own: the caller's sale contradicts no field, is derived,
      // and attaches another customer's deal to this debt. Same hole one field
      // over for a caller-filled vehicle against the sale the receivable does
      // name.
      //
      // A sale names both a customer and a vehicle, so it is the identifier
      // that can prove the others. Vehicle-only and customer-only ad-hoc
      // payments stay unconstrained — a vehicle does not imply a customer, and
      // requiring one would refuse legitimate counter takings.
      //
      // Deliberately NOT applied to a pair that came entirely FROM the
      // receivable row. `createReceivable` never correlated its own customer,
      // sale and vehicle either, so a row can already hold an inconsistent
      // triple; refusing there would block collection on rows that exist
      // today. That is a pre-existing defect at the creation door, and fixing
      // it is not this change's to make.
      const callerFilledSale = !receivable?.saleId && args.saleId !== undefined;
      const callerFilledVehicle = !receivable?.vehicleId && args.vehicleId !== undefined;
      if (saleId && (!receivable || callerFilledSale || callerFilledVehicle)) {
        const sale = await ctx.db.get(saleId);
        if (sale) {
          if (sale.customerId !== customerId) {
            throw new ConvexError("Payment sale belongs to a different customer.");
          }
          if (vehicleId && sale.vehicleId !== vehicleId) {
            throw new ConvexError("Payment sale is for a different vehicle.");
          }
        }
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      // SCRUM-54: a receipt that reaches a bank names it; checked before the first write.
      const bankAccountId = receiptReachesBank
        ? await requireActiveBankInCurrency(ctx, {
            orgId: args.orgId,
            bankAccountId: args.bankAccountId,
            currency,
            missingMessage: "Select the bank account this payment was received into.",
            currencySubject: "organization",
          })
        : undefined;
      const now = Date.now();
      const paymentId = await ctx.db.insert("collectionPayments", {
        orgId: args.orgId,
        branchId: membership.branchId,
        receivableId: receivable?._id,
        customerId,
        vehicleId,
        saleId,
        direction: "IN",
        method: args.method,
        amount: roundMoney(args.amount, currency),
        paymentDate: args.paymentDate,
        paymentDateKind: paymentDateKindOfCalendarInput(args.paymentDate),
        status: "POSTED",
        idempotencyKey: args.idempotencyKey,
        reference: args.reference,
        cashierId: user._id,
        notes: args.notes,
        createdAt: now,
      });

      if (receivable) {
        await applyPostedPayment(ctx, receivable, args.amount, args.paymentDate, currency);
      }

      await insertLedgerTransaction(ctx, {
        orgId: args.orgId,
        direction: "IN",
        amount: roundMoney(args.amount, currency),
        date: args.paymentDate,
        description: `Collection payment${receivable ? ` for ${receivable.title}` : ""}`,
        vehicleId,
        userId: user._id,
        category: "COLLECTION_PAYMENT",
        idempotencyKey: args.idempotencyKey,
      });

      const payment = await ctx.db.get(paymentId);
      // Refuses rather than skips (SCRUM-218-C). The row was inserted a few
      // statements above in this same transaction, so this is unreachable —
      // but the previous `if (payment)` shape meant an absent row silently
      // produced a receipt with no canonical payment and therefore no movement
      // to seal, which is precisely the "operationally final, accounting
      // missing" state this ticket exists to make impossible.
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

      // SCRUM-236 — the single forward producer of this receipt occurrence.
      //
      // The identity is constructed HERE, inside this invocation, from this
      // invocation's own arguments, and is never held anywhere else. The
      // trust registry backing `directCollectionReceipt` is a module-private
      // WeakSet whose lifetime is the MODULE, not the mutation, so a cached
      // identity would stay trusted across later invocations in the same
      // isolate and let one of them address an occurrence it never earned
      // (owner-proxy c17641 requirement 1).
      //
      // ⚠️ NOTHING MAY CATCH THIS CALL. `paymentId` is the occurrence's own
      // `sourceId`, so the identity cannot exist before the insert above —
      // "refuse before writes" is structurally unavailable on the forward
      // path, and the guarantee is the other one c17641 requirement 3
      // allows: the refusal ESCAPES the mutation and Convex rolls the whole
      // attempt back. In Convex a CAUGHT exception commits the writes made
      // before it, so wrapping this in a try/catch would leave the payment
      // row, the ledger transaction and the canonical mirror committed while
      // the accounting refused — and report the refusal as handled.
      const receiptIdentity = directCollectionReceipt({ orgId: args.orgId, paymentId });

      // SCRUM-218-C — seal what this receipt WAS before anything posts.
      //
      // The split is derived inside `sealReceiptMovement` from the canonical
      // payment row and the exact allocation this transaction created, not
      // from `args.amount`. On this path over-receipt is refused above, so the
      // outcome is one of exactly two shapes: a receivable was named and fully
      // absorbed the money, or none was and the whole receipt is retained
      // customer credit.
      const { movementId, split } = await sealReceiptMovement(ctx, {
        identity: receiptIdentity,
        orgId: args.orgId,
        collectionPaymentId: paymentId,
        canonicalPaymentId: mirrored.canonicalPaymentId,
        customerId,
        currency,
        allocationIds: mirrored.paymentAllocationId ? [mirrored.paymentAllocationId] : [],
        actorId: user._id,
      });

      await postReceiptOccurrence(ctx, {
        identity: receiptIdentity,
        currency,
        occurredAt: args.paymentDate,
        actorId: user._id,
        // Only demanded when there is actually a residue to credit. A receipt
        // that fully discharges a receivable must not become unpostable just
        // because an org has no 2110 — it never needed one.
        requiredSystemKeys: split.unappliedMinor > 0 ? [RETAINED_CREDIT_SYSTEM_KEY] : [],
        payload: {
          paymentId: paymentId.toString(),
          receivedMinor: split.receivedMinor,
          appliedMinor: split.appliedMinor,
          unappliedMinor: split.unappliedMinor,
          currency,
          customerId: customerId.toString(),
          paymentMethod: args.method,
          ...(bankAccountId ? { bankAccountId: bankAccountId.toString() } : {}),
        },
      });

      if (args.invoiceSaleId) {
        await reservePendingInvoiceReceipt(ctx, {
          orgId: args.orgId, saleId: args.invoiceSaleId,
          receiptMovementId: movementId, amountMinor: split.unappliedMinor,
          actorId: user._id,
        });
      }

      const actorName = await getActorName(ctx);
      await notifyManagers(ctx, args.orgId, "collection.payment_recorded", {
        actorName,
        amount: String(roundMoney(args.amount, currency)),
      }, { link: `/${args.orgId}/accounting` });

      return paymentId;
    }
  );
}
