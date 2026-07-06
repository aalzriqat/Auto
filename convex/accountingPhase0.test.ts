import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedPhase0Dealer() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase 0 Dealer", createdAt: Date.now() })
  );
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
  );

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "phase0_user",
      email: "phase0@example.com",
      name: "Phase 0 User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "phase0_approver",
      email: "phase0.approver@example.com",
      name: "Phase 0 Approver",
    })
  );

  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Phase 0 Finance",
      permissions: [
        "view:sales",
        "create:sales",
        "edit:sales",
        "edit:vehicles",
        "view:vehicles",
        "view:customers",
        "view:finance",
        "manage:finance",
        "approve:requests",
        "create:expenses",
        "view:expenses",
        "view:commissions",
        "manage:commissions",
        "view:finance_applications", "create:finance_application",
        "review:finance_application", "approve:finance_application",
        "finalize:financed_deal", "confirm:finance_disbursement",
        "verify:finance_documents",
        "register:vehicle_handover", "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "PHASE0VIN1",
      make: "Toyota",
      model: "Land Cruiser",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 32000,
      sellingPrice: 42000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Dana", lastName: "Saleh" })
  );

  return {
    t,
    orgId,
    otherOrgId,
    userId,
    approverId,
    vehicleId,
    customerId,
    asUser: t.withIdentity({ subject: "phase0_user", clerkId: "phase0_user" }),
    asApprover: t.withIdentity({ subject: "phase0_approver", clerkId: "phase0_approver" }),
  };
}

async function seedVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  vin: string
) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Hyundai",
      model: "Santa Fe",
      year: 2023,
      mileage: 500,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 21000,
      sellingPrice: 28000,
      status: "AVAILABLE",
    })
  );
}

describe("Phase 0 financial safety controls", () => {
  test("duplicate_sale_create_with_same_key_reuses_sale_and_single_legacy_transaction", async () => {
    const { t, orgId, userId, vehicleId, customerId, asUser } = await seedPhase0Dealer();

    const firstSaleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 42000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "sale-submit-1",
    });
    const secondSaleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 42000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "sale-submit-1",
    });

    expect(secondSaleId).toBe(firstSaleId);
    await t.run(async (ctx) => {
      const sales = await ctx.db.query("sales").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(sales).toHaveLength(1);
      expect(transactions.filter((tx) => tx.category === "VEHICLE_SALE")).toHaveLength(1);
    });
  });

  test("finance_finalization_uses_canonical_sale_completion_and_is_idempotent", async () => {
    const { t, orgId, userId, customerId, asUser, asApprover } = await seedPhase0Dealer();
    const vehicleId = await seedVehicle(t, orgId, "PHASE0VIN2");
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 28000,
      downPayment: 5000,
      termMonths: 36,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });

    const firstSaleId = await asUser.mutation(api.applications.finalizeDeal, {
      orgId,
      applicationId,
      idempotencyKey: "finalize-submit-1",
    });
    const secondSaleId = await asUser.mutation(api.applications.finalizeDeal, {
      orgId,
      applicationId,
      idempotencyKey: "finalize-submit-1",
    });

    expect(secondSaleId).toBe(firstSaleId);
    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      expect(app?.status).toBe("CLOSED");
      expect(app?.finalizedSaleId).toBe(firstSaleId);

      const sales = await ctx.db.query("sales").withIndex("by_quote", (q) => q.eq("quoteId", quoteId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(sales).toHaveLength(1);
      expect(sales[0]?.salespersonId).toBe(userId);
      expect(transactions.filter((tx) => tx.category === "VEHICLE_SALE")).toHaveLength(1);
    });
  });

  test("duplicate_deposit_key_reuses_deposit_payment_and_transaction", async () => {
    const { t, orgId, vehicleId, customerId, asUser } = await seedPhase0Dealer();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 42000,
      downPayment: 3000,
      termMonths: 0,
    });

    const firstDepositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 1000,
      idempotencyKey: "deposit-submit-1",
    });
    const secondDepositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 1000,
      idempotencyKey: "deposit-submit-1",
    });

    expect(secondDepositId).toBe(firstDepositId);
    await t.run(async (ctx) => {
      const deposits = await ctx.db.query("deposits").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const payments = await ctx.db.query("collectionPayments").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(deposits).toHaveLength(1);
      expect(payments.filter((payment) => payment.method === "CASH")).toHaveLength(1);
      expect(transactions.filter((tx) => tx.category === "DEPOSIT")).toHaveLength(1);
    });
  });

  test("duplicate_collection_payment_key_reduces_receivable_once", async () => {
    const { t, orgId, customerId, asUser } = await seedPhase0Dealer();
    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment",
      amount: 1000,
      dueDate: Date.now() + 86_400_000,
    });

    const firstPaymentId = await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
      idempotencyKey: "payment-submit-1",
    });
    const secondPaymentId = await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
      idempotencyKey: "payment-submit-1",
    });

    expect(secondPaymentId).toBe(firstPaymentId);
    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      const payments = await ctx.db.query("collectionPayments").withIndex("by_receivable", (q) => q.eq("receivableId", receivableId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(receivable?.outstandingAmount).toBe(700);
      expect(payments).toHaveLength(1);
      expect(transactions.filter((tx) => tx.category === "COLLECTION_PAYMENT")).toHaveLength(1);
    });
  });

  test("duplicate_cheque_clear_key_posts_cheque_payment_once", async () => {
    const { t, orgId, customerId, asUser } = await seedPhase0Dealer();
    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "CHEQUE",
      title: "Cheque receivable",
      amount: 800,
      dueDate: Date.now() + 86_400_000,
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "PHASE0-1",
      chequeDate: Date.now() + 86_400_000,
      amount: 800,
    });

    const firstPaymentId = await asUser.mutation(api.collections.clearCheque, {
      orgId,
      chequeId,
      idempotencyKey: "cheque-clear-1",
    });
    const secondPaymentId = await asUser.mutation(api.collections.clearCheque, {
      orgId,
      chequeId,
      idempotencyKey: "cheque-clear-1",
    });

    expect(secondPaymentId).toBe(firstPaymentId);
    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      const payments = await ctx.db.query("collectionPayments").withIndex("by_cheque", (q) => q.eq("chequeId", chequeId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(receivable?.outstandingAmount).toBe(0);
      expect(payments).toHaveLength(1);
      expect(transactions.filter((tx) => tx.category === "COLLECTION_PAYMENT")).toHaveLength(1);
    });
  });

  test("duplicate_expense_posting_key_creates_one_expense_transaction", async () => {
    const { t, orgId, asUser } = await seedPhase0Dealer();
    const expenseDate = Date.now();

    const firstExpenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Phase 0 Expense",
      amount: 150,
      date: expenseDate,
      category: "OTHER",
      idempotencyKey: "expense-post-1",
    });
    const secondExpenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Phase 0 Expense",
      amount: 150,
      date: expenseDate,
      category: "OTHER",
      idempotencyKey: "expense-post-1",
    });

    expect(secondExpenseId).toBe(firstExpenseId);
    await t.run(async (ctx) => {
      const expenses = await ctx.db.query("expenses").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const transactions = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(expenses).toHaveLength(1);
      expect(transactions.filter((tx) => tx.category === "EXPENSE")).toHaveLength(1);
    });
  });

  test("duplicate_commission_payment_key_marks_commission_paid_once", async () => {
    const { t, orgId, userId, vehicleId, customerId, asUser } = await seedPhase0Dealer();
    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 42000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "commission-sale-1",
    });
    await t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 500 }));

    const firstResult = await asUser.mutation(api.sales.markCommissionPaid, {
      orgId,
      saleId,
      idempotencyKey: "commission-paid-1",
    });
    const secondResult = await asUser.mutation(api.sales.markCommissionPaid, {
      orgId,
      saleId,
      idempotencyKey: "commission-paid-1",
    });

    expect(secondResult).toBe(firstResult);
    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.commissionPaidBy).toBe(userId);
      expect(sale?.commissionPaymentIdempotencyKey).toBe("commission-paid-1");
    });
  });

  test("salesperson_cannot_cancel_own_sale_but_separate_approver_can", async () => {
    const { t, orgId, userId, vehicleId, customerId, asUser, asApprover } = await seedPhase0Dealer();
    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 42000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "cancel-sale-source-1",
    });

    await expect(
      asUser.mutation(api.sales.update, {
        orgId,
        saleId,
        status: "CANCELLED",
      })
    ).rejects.toThrow(/salesperson cannot approve cancellation/i);

    await asApprover.mutation(api.sales.update, {
      orgId,
      saleId,
      status: "CANCELLED",
    });

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const vehicle = await ctx.db.get(vehicleId);
      expect(sale?.status).toBe("CANCELLED");
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });

  test("requester_cannot_approve_own_collection_refund", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await seedPhase0Dealer();
    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "RESERVATION_PAYMENT",
      title: "Reservation payment",
      amount: 500,
      dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 500,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const requestId = await asUser.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 100,
      disbursementMethod: "CASH",
      reason: "Duplicate customer payment",
    });

    await expect(
      asUser.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/requester cannot approve/i);

    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
        idempotencyKey: "refund-approval-1",
      })
    ).resolves.toBe(requestId);
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
        idempotencyKey: "refund-approval-1",
      })
    ).resolves.toBe(requestId);

    await t.run(async (ctx) => {
      const refundPayments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .collect();
      expect(refundPayments.filter((payment) => payment.direction === "OUT")).toHaveLength(1);
    });
  });

  test("cashier_cannot_approve_own_reconciliation", async () => {
    const { orgId, customerId, asUser, asApprover } = await seedPhase0Dealer();
    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cash payment",
      amount: 250,
      dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 250,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const reconciliationId = await asUser.mutation(api.collections.submitCashierReconciliation, {
      orgId,
      businessDate: Date.now(),
      countedCash: 250,
      idempotencyKey: "cashier-recon-1",
    });

    await expect(
      asUser.mutation(api.collections.reviewCashierReconciliation, {
        orgId,
        reconciliationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/cashier cannot approve/i);

    await expect(
      asApprover.mutation(api.collections.reviewCashierReconciliation, {
        orgId,
        reconciliationId,
        status: "APPROVED",
      })
    ).resolves.not.toThrow();
  });

  test("quote_creation_rejects_cross_org_financial_links", async () => {
    const { t, orgId, otherOrgId, vehicleId, customerId, asUser } = await seedPhase0Dealer();
    const foreignCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Foreign", lastName: "Customer" })
    );
    const foreignVehicleId = await seedVehicle(t, otherOrgId, "FOREIGNVIN1");

    await expect(
      asUser.mutation(api.quotes.saveQuote, {
        orgId,
        customerId: foreignCustomerId,
        vehicleId,
        vehiclePrice: 42000,
        downPayment: 0,
        termMonths: 0,
      })
    ).rejects.toThrow(/customer not found/i);

    await expect(
      asUser.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId: foreignVehicleId,
        vehiclePrice: 42000,
        downPayment: 0,
        termMonths: 0,
      })
    ).rejects.toThrow(/vehicle not found/i);
  });
});
