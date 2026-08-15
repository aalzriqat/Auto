import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * SCRUM-56 — a completed sale's outstanding customer balance must be visible in,
 * and collectable from, the Collections work queue.
 *
 * The debt these tests care about is the CANONICAL receivable document that
 * `utils/saleCompletion.ts` creates on completion. Before this change the
 * Collections queries read only the legacy `receivables` table, so that debt was
 * invisible operationally and a human had to re-key it — creating a second
 * representation of the same money.
 *
 * The rule every test here enforces: the canonical document is the ONLY monetary
 * authority. Legacy rows may carry workflow metadata (assignment, reminders,
 * installment labels), never a second outstanding balance.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "register:vehicle_handover",
  "register:expected_payment",
];

const SALE_PRICE = 22000;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Collections Canonical Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "queue_user", email: "queue@test.com", name: "Queue User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "queue_approver", email: "queue.approver@test.com", name: "Queue Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "queue_user", clerkId: "queue_user" });
  const asApprover = t.withIdentity({ subject: "queue_approver", clerkId: "queue_approver" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A777777",
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 500,
      sellingPrice: SALE_PRICE,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, asUser, asApprover };
}

async function completeSale(
  asUser: any,
  orgId: any,
  customerId: any,
  vehicleId: any,
  options: { depositAmount?: number } = {}
) {
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: SALE_PRICE,
    downPayment: 0,
    termMonths: 0,
  });
  // A deposit is money actually received, so completion applies it to the sale
  // invoice. The quote's `downPayment` is only an intention and settles nothing.
  if (options.depositAmount) {
    await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: options.depositAmount,
    });
  }
  const saleIds = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });
  return (Array.isArray(saleIds) ? saleIds[0] : saleIds) as Id<"sales">;
}

describe("SCRUM-56 — completed sales enter the Collections queue", () => {
  test("a completed sale's canonical customer balance appears in the collection queue", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    // Precondition: sale completion really did create the canonical debt. If
    // this ever stops holding, the rest of the test would pass vacuously.
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale?.canonicalReceivableDocumentId ?? null;
    });
    expect(canonicalId).not.toBeNull();

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const item = queue.items.find((row: any) => row.receivableDocumentId === canonicalId);

    expect(item).toBeDefined();
    expect(item!.outstandingAmount).toBe(SALE_PRICE);
    expect(item!.customerName).toBe("Nora Khaled");
    expect(item!.origin).toBe("CANONICAL");
  });

  test("the sale balance is counted in the collections summary and the aging report", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    await completeSale(asUser, orgId, customerId, vehicleId);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE);

    const aging = await asUser.query(api.collections.agingReport, { orgId });
    const total =
      aging.current.amount +
      aging.days1To30.amount +
      aging.days31To60.amount +
      aging.days61To90.amount +
      aging.over90.amount;
    expect(total).toBe(SALE_PRICE);
  });

  test("collecting against the queued sale drives the canonical balance to zero", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });

    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableDocumentId: canonicalId,
      amount: SALE_PRICE,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items.find((row: any) => row.receivableDocumentId === canonicalId)).toBeUndefined();

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(0);
  });

  test("a sale already settled in full never becomes a false open collection item", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    // The whole price arrives as a deposit and is applied at completion, so the
    // customer owes nothing the moment the sale closes.
    await completeSale(asUser, orgId, customerId, vehicleId, { depositAmount: SALE_PRICE });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items.filter((row: any) => row.origin === "CANONICAL")).toHaveLength(0);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(0);
  });

  test("a manually re-keyed legacy receivable for the same sale does not double-count the debt", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    // Exactly the workaround the ticket describes: an operator re-keys part of
    // the sale debt into the legacy table so it can be chased. That row is a
    // sub-representation of the same money, not additional money.
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        saleId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Re-keyed installment",
        originalAmount: 8000,
        outstandingAmount: 8000,
        dueDate: now + 86_400_000,
        status: "OPEN",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE);

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const queued = queue.items.reduce((sum: number, row: any) => sum + row.outstandingAmount, 0);
    expect(queued).toBe(SALE_PRICE);
  });

  test("hand-keyed rows worth more than the sale still owes are flagged, never netted below zero", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        saleId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Over-keyed installment",
        originalAmount: SALE_PRICE + 5000,
        outstandingAmount: SALE_PRICE + 5000,
        dueDate: now + 86_400_000,
        status: "OPEN",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    // The invoice contributes nothing rather than a negative balance, and the
    // legacy row is still there to be worked — carrying the warning, because it
    // is the row an operator can actually correct.
    expect(queue.items.filter((row: any) => row.origin === "CANONICAL")).toHaveLength(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].outstandingAmount).toBe(SALE_PRICE + 5000);
    expect(queue.items[0].overRepresented).toBe(true);

    // And the total never goes negative, which a naive netting would produce.
    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE + 5000);
  });

  test("a correctly-sized hand-keyed row is not flagged as over-representing its sale", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        saleId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Right-sized installment",
        originalAmount: 8000,
        outstandingAmount: 8000,
        dueDate: now + 86_400_000,
        status: "OPEN",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items.every((row: any) => !row.overRepresented)).toBe(true);
  });

  test("a part payment against the sale invoice leaves exactly the remainder in the queue", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });

    // A sale invoice falls due on the sale date, so give this one a future due
    // date to isolate the part-paid state from the overdue state.
    await t.run((ctx) => ctx.db.patch(canonicalId, { dueDate: Date.now() + 7 * 86_400_000 }));

    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableDocumentId: canonicalId,
      amount: 9000,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const item = queue.items.find((row: any) => row.receivableDocumentId === canonicalId);
    expect(item).toBeDefined();
    expect(item!.outstandingAmount).toBe(SALE_PRICE - 9000);
    expect(item!.status).toBe("PARTIALLY_PAID");

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE - 9000);
  });

  test("an unpaid sale invoice is overdue from its due date, and the queue says so", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    await completeSale(asUser, orgId, customerId, vehicleId);

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const item = queue.items.find((row: any) => row.origin === "CANONICAL");
    expect(item!.status).toBe("OVERDUE");

    // And the status filter the Collections screen uses finds it there.
    const overdueOnly = await asUser.query(api.collections.listCollectionQueue, {
      orgId,
      status: "OVERDUE",
    });
    expect(overdueOnly.items).toHaveLength(1);
    const openOnly = await asUser.query(api.collections.listCollectionQueue, { orgId, status: "OPEN" });
    expect(openOnly.items).toHaveLength(0);
  });

  test("a payment larger than the sale invoice's remaining balance is refused", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });

    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId,
        receivableDocumentId: canonicalId,
        amount: SALE_PRICE + 1,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/cannot exceed the outstanding/i);
  });

  test("a settled sale invoice refuses further money", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });

    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableDocumentId: canonicalId,
      amount: SALE_PRICE,
      method: "CASH",
      paymentDate: Date.now(),
    });

    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId,
        receivableDocumentId: canonicalId,
        amount: 1,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/no longer accept payments/i);
  });

  test("a finance company's receivable cannot be collected through the customer queue", async () => {
    const { t, orgId, customerId, userId, asUser } = await setup();

    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Cairo Amman Bank",
        profitRate: 5.5,
        maxTermMonths: 72,
        gracePeriodMonths: 3,
        isActive: true,
      })
    );
    const financeDocId = await t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId,
        documentType: "INVOICE",
        documentNumber: "FIN-1",
        payerType: "FINANCE_COMPANY",
        financeCompanyId,
        customerId,
        sourceType: "finance_application",
        sourceId: "app-1",
        originalAmountMinor: 15_000_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: userId,
      })
    );

    // It is not customer debt, so it is not in the customer collection queue…
    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items).toHaveLength(0);

    // …and Collections cannot pay it down either, which would silently settle
    // finance-company AR through a screen that never shows it.
    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId,
        receivableDocumentId: financeDocId,
        amount: 100,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/not owed by a customer/i);
  });

  test("a payment cannot name a legacy row and a sale invoice at the same time", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });
    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Separate balance",
      amount: 500,
      dueDate: Date.now() + 86_400_000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // Two debts, one payment: whichever the server picked, the other would be
    // silently ignored and the operator would believe both were paid.
    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId,
        receivableId,
        receivableDocumentId: canonicalId,
        amount: 100,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/not both/i);
  });

  test("another organization's sale invoice is neither visible nor payable", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const canonicalId = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });

    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const otherUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "other_queue_user", email: "other@test.com", name: "Other User" })
    );
    const otherRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Admin", permissions: PERMISSIONS })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId })
    );
    const asOther = t.withIdentity({ subject: "other_queue_user", clerkId: "other_queue_user" });

    const queue = await asOther.query(api.collections.listCollectionQueue, { orgId: otherOrgId });
    expect(queue.items).toHaveLength(0);

    // The exact message matters: any customer-side check would also throw a
    // "not found", so a loose pattern here would pass with the tenancy check on
    // the document itself removed.
    await expect(
      asOther.mutation(api.collections.recordPayment, {
        orgId: otherOrgId,
        receivableDocumentId: canonicalId,
        amount: 100,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/Receivable not found/);

    // Nothing was allocated against the other organization's invoice.
    await t.run(async (ctx) => {
      const allocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", canonicalId))
        .collect();
      expect(allocations).toHaveLength(0);
    });
  });

  test("a legacy receivable lifted into the canonical subledger is counted once, not twice", async () => {
    const { orgId, customerId, asUser } = await setup();

    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Standalone installment",
      amount: 1000,
      dueDate: Date.now() + 7 * 86_400_000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // Paying it creates the canonical twin via ensureCanonicalReceivableForLegacy.
    // That twin is the same debt seen from the accounting side and must not
    // appear in the queue as a second item.
    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 400,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].origin).toBe("LEGACY");
    expect(queue.items[0].outstandingAmount).toBe(600);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(600);
  });

  test("completing the sale raises exactly one canonical invoice, so the queue cannot list it twice", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    const saleDocs = await t.run(async (ctx) =>
      (await ctx.db.query("receivableDocuments").collect()).filter(
        (doc) => doc.sourceType === "sales" && doc.sourceId === String(saleId)
      )
    );
    expect(saleDocs).toHaveLength(1);

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items.filter((row: any) => row.saleId === saleId)).toHaveLength(1);
  });

  test("a legacy receivable with no sale behaves exactly as it did before", async () => {
    const { orgId, customerId, asUser } = await setup();
    const dueDate = Date.now() + 7 * 86_400_000;

    await asUser.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Untouched installment",
      amount: 1500,
      dueDate,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      origin: "LEGACY",
      title: "Untouched installment",
      outstandingAmount: 1500,
      status: "OPEN",
      customerName: "Nora Khaled",
    });
    expect(queue.items[0].receivableId).toBeDefined();
  });

  test("a cancelled sale stops being chased", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    expect(queue.items.filter((row: any) => row.origin === "CANONICAL")).toHaveLength(0);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(0);

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.status).toBe("CANCELLED");
    });
  });
});
