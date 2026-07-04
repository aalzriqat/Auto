/**
 * Phase 9 tests — fixes from the production re-audit:
 *  - general expenses post to GENERAL_EXPENSE (not COMMISSION_EXPENSE)
 *  - cheque clearing and return-after-clearing hit the GL
 *  - finance disbursement receipt hits the GL
 *  - the accounting outbox captures + re-drives events that cannot post yet
 *  - idempotency keys are bound to a request fingerprint
 *  - reversals write a REVERSE_EVENT financial audit entry
 *  - manual journals require a finance-authorized reviewer
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const FINANCE_PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:expenses", "create:expenses", "edit:expenses",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:customers", "create:customers",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents",
];

async function seedDealer(tag = "p9", openPeriod = true) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Phase9 ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: FINANCE_PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  let period: any = null;
  if (openPeriod) {
    const fiscalYear = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );

  return { t, orgId, userId, roleId, period, asUser, customerId };
}

/** Maps an event's journal lines to { accountCode -> { debit, credit } }. */
async function journalByCode(asUser: any, orgId: string, journalEntryId: string) {
  const je = await asUser.query(api.accountingLedger.getJournalEntry, { orgId, journalEntryId });
  const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
  const codeById = new Map(accounts.map((a: any) => [a._id, a.code]));
  const byCode: Record<string, { debit: number; credit: number }> = {};
  for (const l of je.lines) {
    const code = codeById.get(l.accountId) as string;
    byCode[code] = byCode[code] ?? { debit: 0, credit: 0 };
    byCode[code].debit += l.debitMinor;
    byCode[code].credit += l.creditMinor;
  }
  return byCode;
}

async function eventForSource(asUser: any, orgId: string, sourceType: string, sourceId: string) {
  const events = await asUser.query(api.accountingLedger.listAccountingEvents, { orgId, sourceType, sourceId });
  return events[0];
}

// ─── Expense classification ───────────────────────────────────────────────────

describe("Phase 9 — expense account mapping", () => {
  test("general expense posts to General Expenses (6300), not Commission Expense (6100)", async () => {
    const { orgId, asUser } = await seedDealer("exp");

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Marketing flyers", amount: 120, date: Date.now(),
      category: "MARKETING", status: "PAID",
    });

    const event = await eventForSource(asUser, orgId, "expenses", expenseId.toString());
    expect(event).toBeTruthy();
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);

    expect(byCode["6300"]?.debit).toBe(120000); // General Expenses, JOD scale 3
    expect(byCode["6100"]).toBeUndefined();      // NOT Commission Expense
  });

  test("bank-transfer expense stores method and credits Bank", async () => {
    const { t, orgId, asUser } = await seedDealer("exp_method");

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Bank paid repair",
      amount: 80,
      date: Date.now(),
      category: "REPAIR",
      status: "PAID",
      paymentMethod: "BANK_TRANSFER",
    });

    const event = await eventForSource(asUser, orgId, "expenses", expenseId.toString());
    expect((event.payload as { paymentMethod?: string }).paymentMethod).toBe("BANK_TRANSFER");
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);
    expect(byCode["6300"]?.debit).toBe(80_000);
    expect(byCode["1110"]?.credit).toBe(80_000);
    expect(byCode["1100"]).toBeUndefined();

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.paymentMethod).toBe("BANK_TRANSFER");
    });
  });
});

// ─── Supplier payable settlement method ──────────────────────────────────────

describe("Phase 9 — supplier payable payment method", () => {
  test("markPaid stores bank-transfer method and credits Bank", async () => {
    const { t, orgId, userId, asUser } = await seedDealer("supplier_method");
    const now = Date.now();
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN_SUPPLIER_METHOD",
        make: "Toyota",
        model: "Corolla",
        year: 2024,
        mileage: 0,
        color: "Silver",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 16_000,
        sourceType: "SOURCED",
        sourceCost: 12_000,
        status: "SOLD",
      })
    );
    const payableId = await t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId,
        vehicleId,
        sourcedFromName: "Partner Dealer",
        amountDue: 12_000,
        currency: "JOD",
        status: "PENDING",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );

    await asUser.mutation(api.sourcingPayables.markPaid, {
      orgId,
      payableId,
      paymentMethod: "BANK_TRANSFER",
      idempotencyKey: "supplier_bank_transfer_1",
    });

    const event = await eventForSource(asUser, orgId, "vehicleSupplierPayables", payableId.toString());
    expect((event.payload as { paymentMethod?: string }).paymentMethod).toBe("BANK_TRANSFER");
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);
    expect(byCode["2400"]?.debit).toBe(12_000_000);
    expect(byCode["1110"]?.credit).toBe(12_000_000);
    expect(byCode["1100"]).toBeUndefined();

    await t.run(async (ctx) => {
      const payable = await ctx.db.get(payableId);
      expect(payable?.paymentMethod).toBe("BANK_TRANSFER");
    });
  });
});

// ─── Accounting outbox (no silent skips) ──────────────────────────────────────

describe("Phase 9 — accounting outbox", () => {
  test("event with no open period is enqueued, then posts when a period opens", async () => {
    const { t, orgId, asUser } = await seedDealer("outbox", /* openPeriod */ false);

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Pre-period expense", amount: 75, date: Date.now(),
      category: "OFFICE", status: "PAID",
    });

    // Nothing posted, but the event is durably captured (not silently dropped).
    const before = await eventForSource(asUser, orgId, "expenses", expenseId.toString());
    expect(before).toBeUndefined();
    const pending = await asUser.query(api.accountingOutbox.listPending, { orgId, status: "PENDING" });
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceId).toBe(expenseId.toString());

    // Open a period and drain the outbox.
    const fiscalYear = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    const after = await eventForSource(asUser, orgId, "expenses", expenseId.toString());
    expect(after).toBeTruthy();
    expect(after.status).toBe("POSTED");
    const resolved = await asUser.query(api.accountingOutbox.listPending, { orgId, status: "POSTED" });
    expect(resolved).toHaveLength(1);
  });
});

// ─── Idempotency fingerprint ──────────────────────────────────────────────────

describe("Phase 9 — idempotency fingerprint", () => {
  test("reusing an idempotency key with a different payload is rejected", async () => {
    const { orgId, asUser, customerId } = await seedDealer("idem");

    await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, amountMinor: 1000, currency: "JOD", provider: "tap",
      idempotencyKey: "reused_key_1",
    });

    await expect(
      asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, amountMinor: 999999, currency: "JOD", provider: "tap",
        idempotencyKey: "reused_key_1",
      })
    ).rejects.toThrow(/different request content/i);
  });

  test("same key with identical payload still returns the prior result", async () => {
    const { orgId, asUser, customerId } = await seedDealer("idem2");
    const args = {
      orgId, customerId, amountMinor: 5000, currency: "JOD", provider: "tap",
      idempotencyKey: "stable_key_1",
    } as const;
    const a = await asUser.mutation(api.paymentIntents.create, args);
    const b = await asUser.mutation(api.paymentIntents.create, args);
    expect(b).toEqual(a);
  });
});

// ─── Reversal audit logging ───────────────────────────────────────────────────

describe("Phase 9 — reversal audit log", () => {
  test("reversing an event writes a REVERSE_EVENT audit entry", async () => {
    const { orgId, asUser } = await seedDealer("rev");

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Reversible expense", amount: 60, date: Date.now(),
      category: "OTHER", status: "PAID",
    });
    const event = await eventForSource(asUser, orgId, "expenses", expenseId.toString());

    await asUser.mutation(api.accountingLedger.reverse, {
      orgId, originalEventId: event._id, reversalDate: Date.now(),
      reason: "Audit re-audit reversal", idempotencyKey: `rev_${expenseId}`,
    });

    const logs = await asUser.query(api.financialAudit.listAuditLog, { orgId, actionType: "REVERSE_EVENT" });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].description).toMatch(/Reversed/i);
  });
});

// ─── Manual journal segregation of duties ─────────────────────────────────────

describe("Phase 9 — manual journal reviewer authority", () => {
  test("a reviewer without MANAGE_FINANCE cannot approve a draft", async () => {
    const { t, orgId, asUser } = await seedDealer("mj");

    // A low-privilege member who is NOT finance-authorized.
    const weakRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Sales", permissions: ["view:sales"] })
    );
    const weakReviewer = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "mj_weak", email: "weak@example.com", name: "Weak" })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: weakReviewer, roleId: weakRoleId }));
    const asWeakReviewer = t.withIdentity({ subject: "mj_weak", clerkId: "mj_weak" });

    const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
    const manual = accounts.filter((a: any) => a.allowManualPosting);

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId, memo: "Needs real approver",
      lines: [
        { accountId: manual[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: manual[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "mj_weak_review",
    });

    await expect(
      asWeakReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId })
    ).rejects.toThrow(/missing required permissions/i);
  });
});

// ─── Cheque clearing + return hit the GL ──────────────────────────────────────

describe("Phase 9 — cheque GL posting", () => {
  test("clearing a cheque posts DR Bank / CR AR, and return-after-clearing reverses it", async () => {
    const { orgId, asUser, customerId } = await seedDealer("chq");

    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CHEQUE", title: "Cheque receivable",
      amount: 1000, dueDate: Date.now() + 86_400_000,
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId, customerId, bank: "ABC Bank", chequeNumber: "CHQ-001",
      chequeDate: Date.now(), amount: 1000,
    });

    const paymentId = await asUser.mutation(api.collections.clearCheque, {
      orgId, chequeId, idempotencyKey: `clear_${chequeId}`,
    });

    // Clearing posted a COLLECTION_PAYMENT to the GL (DR Bank 1110 / CR AR 1200).
    const clearEvent = await eventForSource(asUser, orgId, "collectionPayments", paymentId.toString());
    expect(clearEvent).toBeTruthy();
    const clearByCode = await journalByCode(asUser, orgId, clearEvent.journalEntryId);
    expect(clearByCode["1110"]?.debit).toBe(1000000); // Bank debited
    expect(clearByCode["1200"]?.credit).toBe(1000000); // AR credited

    // Return after clearing reverses the clearing event and posts the bank fee.
    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "NSF", bankFeeMinor: 5000,
      idempotencyKey: `return_${chequeId}`,
    });

    const reloaded = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId, sourceType: "collectionPayments", sourceId: paymentId.toString(),
    });
    expect(reloaded[0].status).toBe("REVERSED");
  });
});

// ─── Finance disbursement receipt hits the GL ─────────────────────────────────

describe("Phase 9 — finance disbursement receipt", () => {
  test("confirmDisbursement posts DR Bank / CR Finance-company AR", async () => {
    const { t, orgId, asUser, customerId, userId } = await seedDealer("disb");

    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Test Bank", isActive: true,
        profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 2,
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_DISB_9", make: "Toyota", model: "Corolla", year: 2022,
        mileage: 0, color: "White", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE",
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000,
        totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      })
    );
    const appId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId, status: "CLOSED",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    await asUser.mutation(api.applications.confirmDisbursement, {
      orgId, applicationId: appId, disbursedAmountMinor: 10_000_000,
      idempotencyKey: "disb_gl_1",
    });

    const event = await eventForSource(asUser, orgId, "financeApplications", `disbursement_${appId}`);
    expect(event).toBeTruthy();
    expect(event.eventType).toBe("FINANCE_CASH_RECEIVED");
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);
    expect(byCode["1110"]?.debit).toBe(10_000_000); // Bank debited
    expect(byCode["1210"]?.credit).toBe(10_000_000); // Finance-company AR credited
  });
});

// ─── Commission payment hits the GL payable ──────────────────────────────────

describe("Phase 9 — commission payment GL posting", () => {
  test("markCommissionPaid posts DR Commission Payable / CR Cash exactly once", async () => {
    const { t, orgId, asUser, customerId, userId } = await seedDealer("comm");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN_COMM_9",
        make: "Toyota",
        model: "Camry",
        year: 2023,
        mileage: 0,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        purchasePrice: 12_000,
        sellingPrice: 18_000,
        status: "AVAILABLE",
      })
    );

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 18_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "comm_sale_1",
    });
    await t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 500 }));

    await asUser.mutation(api.sales.markCommissionPaid, {
      orgId,
      saleId,
      idempotencyKey: "comm_paid_1",
    });
    await asUser.mutation(api.sales.markCommissionPaid, {
      orgId,
      saleId,
      idempotencyKey: "comm_paid_1",
    });

    const event = await eventForSource(asUser, orgId, "sales", `commission_paid_${saleId}`);
    expect(event).toBeTruthy();
    expect(event.eventType).toBe("COMMISSION_PAID");
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);
    expect(byCode["2300"]?.debit).toBe(500_000); // Commission Payable settled
    expect(byCode["1100"]?.credit).toBe(500_000); // Cash paid

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId,
      sourceType: "sales",
      sourceId: `commission_paid_${saleId}`,
    });
    expect(events.filter((row) => row.eventType === "COMMISSION_PAID")).toHaveLength(1);
  });

  test("markCommissionPaid stores bank-transfer method and credits Bank", async () => {
    const { t, orgId, asUser, customerId, userId } = await seedDealer("comm_method");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN_COMM_METHOD_9",
        make: "Toyota",
        model: "Camry",
        year: 2023,
        mileage: 0,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        purchasePrice: 12_000,
        sellingPrice: 18_000,
        status: "AVAILABLE",
      })
    );

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 18_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      idempotencyKey: "comm_method_sale_1",
    });
    await t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 700 }));

    await asUser.mutation(api.sales.markCommissionPaid, {
      orgId,
      saleId,
      paymentMethod: "BANK_TRANSFER",
      idempotencyKey: "comm_method_paid_1",
    });

    const event = await eventForSource(asUser, orgId, "sales", `commission_paid_${saleId}`);
    expect((event.payload as { paymentMethod?: string }).paymentMethod).toBe("BANK_TRANSFER");
    const byCode = await journalByCode(asUser, orgId, event.journalEntryId);
    expect(byCode["2300"]?.debit).toBe(700_000);
    expect(byCode["1110"]?.credit).toBe(700_000);
    expect(byCode["1100"]).toBeUndefined();

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.commissionPaymentMethod).toBe("BANK_TRANSFER");
    });
  });
});
