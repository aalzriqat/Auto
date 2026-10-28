// @vitest-environment node
/** SCRUM-760 c23812(11): shipped receipt/payout doors refuse without changing any app table.
 * Existing happy-path financial oracles are cited in route-matrix-11.md; do not duplicate them here.
 * Historical invoice/reservation/request rows are seeded deliberately: pilot containment must also
 * refuse commands against rows created before the switch was enabled. No business module is mocked.
 * Snapshots cover root schema tables and root scheduled functions; mounted component internals
 * (aggregates, rate limiter and workpool) are outside this snapshot. Harness evidence is not platform/OCC proof.
 */
import { describe, expect, test } from "vitest";
import { seedCashDealer } from "../test-utils/cashDealerFixture";
import { registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";
import { seedBank } from "../test-utils/bankFixture";
import { seedFinancedDealership, newApplication, insertReceiptBank } from "../test-utils/financedDealFixture";
import { registerHandover } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";

const MODULES = import.meta.glob("./**/*.ts");
const TABLES = Object.keys(schema.tables);

async function world(tag: string) {
  const w = await seedCashDealer(`rt11_${tag}`, MODULES);
  registerRateLimiter(w.t);
  const bankAccountId = await seedBank(w.t, w.orgId, "JOD");
  // The existing unbound receipt door remains supported: it creates posted 2110 credit.
  const paymentId = await w.asUser.mutation(api.collections.recordPayment, {
    orgId: w.orgId, customerId: w.customerId, amount: 100, method: "CASH",
    paymentDate: Date.now(), idempotencyKey: `fund-${tag}`,
  });
  const movement = await w.t.run(async ctx => {
    const rows = await ctx.db.query("receiptMovements").collect();
    return rows.find(row => row.collectionPaymentId === paymentId);
  });
  expect(movement, "fixture must have a real receipt movement before the refusal call").toBeDefined();
  const position = await w.t.run(ctx => ctx.db.query("receiptRetainedPositions")
    .withIndex("by_org_movement", q => q.eq("orgId", w.orgId).eq("receiptMovementId", movement!._id)).unique());
  expect(position?.remainingUnappliedMinor).toBe(100_000);
  const saleId = await w.t.run(async ctx => {
    const id = await ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: w.vehicleId, customerId: w.customerId,
      salespersonId: w.userId, salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED",
    });
    await seedSaleInvoice(ctx, {
      orgId: w.orgId, saleId: id, userId: w.userId, customerId: w.customerId,
      originalMinor: 20_000_000, openMinor: 20_000_000, posting: "POSTED",
    });
    return id;
  });
  return { ...w, bankAccountId, saleId, movement: movement!, position: position! };
}

type World = Awaited<ReturnType<typeof world>>;
async function refuses(w: Pick<World, "t">, call: () => Promise<unknown>, code: string) {
  const before = await dbSnapshot(w.t, TABLES);
  const scheduledBefore = await w.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  await expect(call()).rejects.toMatchObject({ data: { code } });
  expect(await dbSnapshot(w.t, TABLES)).toEqual(before);
  expect(await w.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
}

describe("ruling 11: shipped sale-invoice receipt doors", () => {
  test.each(["cheque", "reserve", "activate", "recordPayment"] as const)(
    "%s refuses with zero writes, including existing journal lines and scheduled work", async door => {
      const w = await world(door);
      const common = { orgId: w.orgId, saleId: w.saleId, receiptMovementId: w.movement._id,
        amountMinor: 1_000, idempotencyKey: `refused-${door}` };
      const invoice = await w.t.run(ctx => ctx.db.get(w.saleId));
      expect(invoice?.canonicalReceivableDocumentId).toBeDefined();
      const reservationId = await w.t.run(ctx => ctx.db.insert("invoiceReceiptApplications", {
        orgId: w.orgId, saleId: w.saleId, receiptMovementId: w.movement._id,
        receivableDocumentId: invoice!.canonicalReceivableDocumentId!,
        customerId: w.customerId, currency: "JOD", amountMinor: 1_000,
        status: "PENDING", createdBy: w.userId, createdAt: Date.now(),
      }));
      const calls = {
        cheque: () => w.asUser.mutation(api.collections.registerSaleInvoiceCheque, {
          orgId: w.orgId, saleId: w.saleId, bank: "Customer bank", chequeNumber: "RT11",
          chequeDate: Date.now(), amountMinor: 1_000,
        }),
        reserve: () => w.asUser.mutation(api.collections.reserveSaleInvoiceReceipt, common),
        activate: () => w.asUser.mutation(api.collections.activateSaleInvoiceReceipt, {
          orgId: w.orgId, applicationId: reservationId, amountMinor: 1_000, idempotencyKey: "activate",
        }),
        recordPayment: () => w.asUser.mutation(api.collections.recordPayment, {
          orgId: w.orgId, invoiceSaleId: w.saleId, customerId: w.customerId,
          amount: 1, method: "CASH", paymentDate: Date.now(), idempotencyKey: "invoice-receipt",
        }),
      };
      await refuses(w, calls[door], "SALE_INVOICE_RECEIPT_DOORS_DISABLED");
    }, 30_000,
  );
});

describe("ruling 11: shipped customer-credit payout doors", () => {
  test.each(["request", "approve", "execute"] as const)(
    "%s refuses with zero writes to the retained position, payment, ledger and all other app tables", async door => {
      const w = await world(door);
      const requestId = await w.t.run(async ctx => {
        const requester = await ctx.db.insert("users", { clerkId: `historical-${door}`, email: "history@example.test" });
        return ctx.db.insert("retainedCreditRefundRequests", {
          orgId: w.orgId, receiptMovementId: w.movement._id, positionId: w.position._id,
          customerId: w.customerId, currency: "JOD", amountMinor: 1_000, method: "BANK_TRANSFER",
          reason: "Historical request", status: door === "execute" ? "APPROVED" : "PENDING",
          requestedBy: requester, createdAt: Date.now(), updatedAt: Date.now(),
        });
      });
      const calls = {
        request: () => w.asUser.mutation(api.retainedCreditRefunds.requestRetainedCreditRefund, {
          orgId: w.orgId, receiptMovementId: w.movement._id, amountMinor: 1_000,
          method: "BANK_TRANSFER", reason: "Customer asks for credit back",
        }),
        approve: () => w.asUser.mutation(api.retainedCreditRefunds.respondToRetainedCreditRefund, {
          orgId: w.orgId, requestId, status: "APPROVED", idempotencyKey: "approve-credit",
        }),
        execute: () => w.asUser.mutation(api.retainedCreditRefunds.executeRetainedCreditRefund, {
          orgId: w.orgId, requestId, bankAccountId: w.bankAccountId, reference: "RT11",
          paidAt: Date.now(), idempotencyKey: "execute-credit",
        }),
      };
      await refuses(w, calls[door], "CUSTOMER_CREDIT_PAYOUT_DISABLED");
    }, 30_000,
  );
});

describe("ruling 11: competing post-completion receipt doors", () => {
  test.each(["newDebt", "installments", "directPayment", "legacyPayment", "credit", "registerCheque", "depositCheque", "clearCheque", "replaceCheque"] as const)(
    "%s cannot use legacy sale debt and changes no app table", async door => {
      const w = await world(door);
      // A pre-containment debt and instrument: seed the historical linkage after creating
      // a legitimate standalone debt. The door under test must refuse that linkage too.
      const receivableId = await w.asUser.mutation(api.collections.createReceivable, {
        orgId: w.orgId, customerId: w.customerId, sourceType: "OTHER", title: "Historical debt",
        amount: 100, dueDate: Date.now(), creditSystemKey: "MISCELLANEOUS_INCOME", idempotencyKey: `debt-${door}`,
      });
      const chequeId = await w.asUser.mutation(api.collections.registerCheque, {
        orgId: w.orgId, customerId: w.customerId, receivableId, bank: "Customer bank", chequeNumber: door,
        chequeDate: Date.now(), amount: 1,
      });
      await w.t.run(async ctx => {
        await ctx.db.patch(receivableId, { saleId: w.saleId });
        await ctx.db.patch(chequeId, { saleId: w.saleId });
      });
      const target = { orgId: w.orgId, customerId: w.customerId, saleId: w.saleId };
      const payment = { orgId: w.orgId, customerId: w.customerId, amount: 1,
        method: "CASH" as const, paymentDate: Date.now(), idempotencyKey: door };
      const calls = {
        newDebt: () => w.asUser.mutation(api.collections.createReceivable, {
          ...target, sourceType: "OTHER", title: "Duplicate sale debt", amount: 100,
          dueDate: Date.now(), creditSystemKey: "MISCELLANEOUS_INCOME", idempotencyKey: "new-sale-debt",
        }),
        installments: () => w.asUser.mutation(api.collections.createInstallmentPlan, {
          ...target, title: "Duplicate sale installments", totalAmount: 100, installmentCount: 2,
          firstDueDate: Date.now(), creditSystemKey: "MISCELLANEOUS_INCOME", idempotencyKey: "new-sale-plan",
        }),
        directPayment: () => w.asUser.mutation(api.collections.recordPayment, { ...payment, saleId: w.saleId }),
        legacyPayment: () => w.asUser.mutation(api.collections.recordPayment, { ...payment, receivableId }),
        credit: () => w.asUser.mutation(api.collections.applyRetainedCredit, {
          orgId: w.orgId, receivableId, receiptMovementId: w.movement._id, requestedAmount: 1, idempotencyKey: "credit",
        }),
        registerCheque: () => w.asUser.mutation(api.collections.registerCheque, {
          ...target, bank: "Customer bank", chequeNumber: "new-sale-cheque", chequeDate: Date.now(), amount: 1,
        }),
        depositCheque: () => w.asUser.mutation(api.collections.depositCheque, { orgId: w.orgId, chequeId }),
        clearCheque: () => w.asUser.mutation(api.collections.clearCheque, {
          orgId: w.orgId, chequeId, bankAccountId: w.bankAccountId, idempotencyKey: "clear-legacy-sale",
        }),
        replaceCheque: () => w.asUser.mutation(api.collections.replaceCheque, {
          orgId: w.orgId, chequeId, bank: "Customer bank", chequeNumber: "replacement", chequeDate: Date.now(), amount: 1,
        }),
      };
      await refuses(w, calls[door], door === "newDebt" || door === "installments"
        ? "SALE_DEBT_COMPETING_RECEIVABLE_REFUSED" : "SALE_DEBT_RECEIPT_REFUSED");
    }, 30_000,
  );
  test.each(["create", "settle"] as const)("payment link %s is dark with no state change", async door => {
    const w = await world(`link-${door}`);
    const intentId = await w.t.run(ctx => ctx.db.insert("paymentIntents", {
      orgId: w.orgId, customerId: w.customerId, amountMinor: 1_000, currency: "JOD", provider: "tap",
      status: "PENDING", idempotencyKey: "historical-link", createdBy: w.userId, createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await refuses(w, () => door === "create" ? w.asUser.mutation(api.paymentIntents.create, {
      orgId: w.orgId, customerId: w.customerId, saleId: w.saleId,
      amountMinor: 1_000, currency: "JOD", provider: "tap", idempotencyKey: "new-link",
    }) : w.asUser.mutation(api.paymentIntents.markSettled, {
      orgId: w.orgId, intentId, idempotencyKey: "settle-link",
    }), "PAYMENT_LINKS_DISABLED");
  }, 30_000);
});

test.each(["add", "update", "remove"] as const)("retired manual cashbook %s refuses with every app table unchanged", async door => {
  const w = await world(`cashbook-${door}`);
  const transactionId = await w.t.run(ctx => ctx.db.insert("transactions", {
    orgId: w.orgId, type: "IN", amount: 100, date: Date.now(), category: "OTHER", description: "Historical cashbook row",
  }));
  const before = await dbSnapshot(w.t, TABLES);
  const scheduledBefore = await w.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  const calls = {
    add: () => w.asUser.mutation(api.transactions.add, {
      orgId: w.orgId, type: "OUT", amount: 1, date: Date.now(), category: "OTHER", description: "Manual correction",
    }),
    update: () => w.asUser.mutation(api.transactions.update, { orgId: w.orgId, transactionId, amount: 1 }),
    remove: () => w.asUser.mutation(api.transactions.remove, { orgId: w.orgId, transactionId }),
  };
  await expect(calls[door]()).rejects.toThrow(/view only and is not the General Ledger/);
  expect(await dbSnapshot(w.t, TABLES)).toEqual(before);
  expect(await w.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
}, 30_000);

/** Owner 2026-10-19: FC-cheque recovery stays enabled, unlike customer cleared-cheque return.
 * Same 12,500 JOD / zero-deposit opening as the four SCRUM-486 finance-cheque certification rows.
 */
async function financeCheque(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: [], label: "Ruling 11 FC cheque", vinPrefix: "RT11FC",
    actors: { viewOnly: ["view:finance"], confirmOnly: ["confirm:finance_disbursement"] },
  });
  registerRateLimiter(s.t);
  const { applicationId } = await newApplication(s);
  const args = { orgId: s.orgId, applicationId };
  await s.owner.as.mutation(api.applications.updateStatus, { ...args, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { ...args, status: "APPROVED" });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...args, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...args, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Ruling 11 worked amount",
  });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    ...args, method: "CHEQUE", expectedDate: Date.now(), faceAmount: "12500",
    chequeDetails: { bank: "Finance bank", chequeNumber: tag },
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    ...args, expectedCurrency: "JOD", idempotencyKey: `${tag}-fee`, feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing fee",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Zero fee", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  await s.owner.as.mutation(api.applications.finalizeDeal, { ...args, idempotencyKey: `${tag}-close` });
  const bankAccountId = await insertReceiptBank(s);
  await s.t.run(ctx => ctx.db.patch(bankAccountId, { isReconciliationTarget: true }));
  await s.owner.as.mutation(api.applications.confirmDisbursement, {
    ...args, bankAccountId, disbursedAmountMinor: 12_500_000, idempotencyKey: `${tag}-receipt`,
  });
  const cheques = await s.t.run(ctx => ctx.db.query("postDatedCheques")
    .withIndex("by_application", q => q.eq("applicationId", applicationId)).collect());
  expect(cheques).toHaveLength(1);
  expect(cheques[0].status).toBe("CLEARED");
  return { ...s, applicationId, returnArgs: { ...args, chequeId: cheques[0]._id,
    returnReason: "Bank returned the cleared cheque", idempotencyKey: `${tag}-return` } };
}

test("enabled FC-cheque return restores bank zero and financier debt, voids payment and reverses allocations", async () => {
  const s = await financeCheque("rt11-fc-enabled");
  const invoice = await s.t.run(ctx => ctx.db.query("receivableDocuments").withIndex("by_org_source", q =>
    q.eq("orgId", s.orgId).eq("sourceType", "finance_application").eq("sourceId", s.applicationId)).unique());
  expect(invoice).toMatchObject({ status: "PAID", originalAmountMinor: 12_500_000, payerType: "FINANCE_COMPANY" });
  if (!invoice) throw new Error("Missing financier invoice");
  const debt = () => s.owner.as.query(api.subledger.getReceivableBalance, { orgId: s.orgId, receivableDocumentId: invoice._id });
  const allocations = () => s.owner.as.query(api.subledger.listAllocations, { orgId: s.orgId, receivableDocumentId: invoice._id });
  const paid = await allocations();
  expect(paid).toHaveLength(1);
  expect(paid[0]).toMatchObject({ status: "ACTIVE", amountMinor: 12_500_000 });
  expect((await debt())?.outstandingMinor).toBe(0);
  expect(await s.owner.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({ status: "OK", balanceMinor: 12_500_000 });
  await s.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, s.returnArgs);
  expect(await s.owner.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId })).toMatchObject({ status: "OK", balanceMinor: 0 });
  expect(await debt()).toMatchObject({ outstandingMinor: 12_500_000, doc: { status: "OPEN", payerType: "FINANCE_COMPANY", financeCompanyId: s.companyId } });
  const reversed = await allocations();
  expect(reversed).toHaveLength(2);
  expect(reversed).toEqual(expect.arrayContaining([
    expect.objectContaining({ _id: paid[0]._id, status: "REVERSED", amountMinor: 12_500_000 }),
    expect.objectContaining({ reversalOfAllocationId: paid[0]._id, status: "REVERSED", amountMinor: 12_500_000 }),
  ]));
  expect(await s.owner.as.query(api.subledger.getPaymentBalance, { orgId: s.orgId, paymentId: paid[0].paymentId }))
    .toMatchObject({ payment: { status: "VOIDED", amountMinor: 12_500_000 } });
  expect(await s.t.run(ctx => ctx.db.get(s.applicationId))).toMatchObject({ status: "CLOSED", settlementStatus: "EXPECTED", disbursementVersion: 2 });
  const after = await dbSnapshot(s.t, TABLES);
  await s.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, s.returnArgs);
  expect(await dbSnapshot(s.t, TABLES)).toEqual(after);
}, 60_000);

test.each(["viewOnly", "confirmOnly", "foreign"] as const)("enabled FC-cheque return refuses %s authority with zero root/scheduler writes", async actor => {
  const s = await financeCheque(`rt11-fc-${actor}`);
  if (actor !== "foreign") {
    await refuses(s, () => s.actors[actor].as.mutation(api.applications.returnFinanceDisbursementCheque, s.returnArgs), "FORBIDDEN");
    return;
  }
  // Foreign owner in the SAME harness avoids cross-instance document-id collisions.
  const orgId = await s.t.run(async ctx => {
    const id = await ctx.db.insert("organizations", { name: "Foreign FC tenant", createdAt: Date.now() });
    const roleId = await ctx.db.insert("roles", { orgId: id, name: "OWNER", permissions: [], isSystemOwnerRole: true });
    const userId = await ctx.db.insert("users", { clerkId: "rt11-fc-foreign-owner", email: "foreign@qa.example.test" });
    await ctx.db.insert("memberships", { orgId: id, roleId, userId });
    return id;
  });
  await refuses(s, () => s.t.withIdentity({ subject: "rt11-fc-foreign-owner" }).mutation(
    api.applications.returnFinanceDisbursementCheque, { ...s.returnArgs, orgId }), "FINANCE_RETURN_NOT_FOUND");
}, 60_000);
