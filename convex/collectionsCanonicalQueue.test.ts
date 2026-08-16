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

    // Counted once, by the invoice that owns the debt. The hand-keyed row is
    // still listed for its workflow state but adds nothing to the total.
    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE);

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const counted = queue.items
      .filter((row: any) => !row.duplicateRepresentation)
      .reduce((sum: number, row: any) => sum + row.outstandingAmount, 0);
    expect(counted).toBe(SALE_PRICE);
  });

  test("hand-keyed rows worth more than the sale still owes never displace the invoice", async () => {
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
    // The invoice keeps its full balance and its place in the queue. An
    // over-keyed row used to delete it from all three views; now the row is
    // simply marked as the duplicate it is, and stays there to be corrected.
    const canonical = queue.items.filter((row: any) => row.origin === "CANONICAL");
    expect(canonical).toHaveLength(1);
    expect(canonical[0].outstandingAmount).toBe(SALE_PRICE);

    const legacy = queue.items.filter((row: any) => row.origin === "LEGACY");
    expect(legacy).toHaveLength(1);
    expect(legacy[0].duplicateRepresentation).toBe(true);

    // The stale figure never reaches the total, high or low.
    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE);
  });

  test("a hand-keyed row with no sale behind it is real money, never a duplicate", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    await completeSale(asUser, orgId, customerId, vehicleId);

    // No `saleId`: nothing else in the system represents this debt, so it is
    // money in its own right and must keep counting. The duplicate rule has to
    // be narrow enough not to swallow the manual receivables the ticket
    // explicitly requires to survive.
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Standalone installment",
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
    expect(queue.items.every((row: any) => !row.duplicateRepresentation)).toBe(true);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE + 8000);
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

/**
 * SCRUM-56 correction — a legacy balance is not a monetary authority.
 *
 * The first implementation deduped a sale's debt by arithmetic: it summed the
 * `outstandingAmount` of every open legacy row carrying the same `saleId` and
 * subtracted that from the sale invoice's derived outstanding. That let a
 * hand-keyed number change what the dealership believes it is owed, which is
 * precisely the authority the canonical document exists to hold.
 *
 * Two consequences, both reproduced below:
 *
 *  1. A stale legacy figure — lower, equal or higher than reality — moves the
 *     queue, the summary and the aging report, and a large enough one deletes
 *     the real debt from all three.
 *
 *  2. Worse, the arithmetic is not even self-consistent with the payment path.
 *     Paying a sale-linked legacy row allocates through
 *     `ensureCanonicalReceivableForLegacy`, which settles a SEPARATE
 *     `legacy_receivable` document keyed on the row — never the sale's invoice.
 *     So the payment lowers the legacy row, which shrinks the subtraction,
 *     which makes the sale invoice reappear at its ORIGINAL amount. The customer
 *     pays and the debt grows back.
 *
 * The rule these tests pin: `saleId` identifies a duplicate representation and
 * nothing more. It never computes money.
 */
describe("SCRUM-56 correction — legacy balances never compute canonical debt", () => {
  const LEGACY_DUE_OFFSET = 86_400_000;

  async function addSaleLinkedLegacyRow(
    t: any,
    orgId: any,
    customerId: any,
    userId: any,
    saleId: any,
    outstandingAmount: number
  ) {
    const now = Date.now();
    return await t.run((ctx: any) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        saleId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Hand-keyed representation",
        originalAmount: outstandingAmount,
        outstandingAmount,
        dueDate: now + LEGACY_DUE_OFFSET,
        status: "OPEN",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  async function canonicalSaleItem(asUser: any, orgId: any, saleId: any) {
    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    return queue.items.find(
      (row: any) => row.origin === "CANONICAL" && String(row.saleId) === String(saleId)
    );
  }

  // A stale hand-keyed figure is the normal case, not an edge case: it is a
  // human's copy of a number that keeps moving. Lower, equal and higher all have
  // to leave the authoritative debt untouched.
  for (const [label, legacyOutstanding] of [
    ["lower than", 8000],
    ["equal to", SALE_PRICE],
    ["higher than", SALE_PRICE + 5000],
  ] as const) {
    test(`a legacy row ${label} the sale invoice cannot change the canonical debt`, async () => {
      const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
      const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
      await addSaleLinkedLegacyRow(t, orgId, customerId, userId, saleId, legacyOutstanding);

      // The invoice still owes what the subledger says it owes, whatever the
      // hand-keyed row claims — and it is still listed, so it can still be paid.
      const item = await canonicalSaleItem(asUser, orgId, saleId);
      expect(item).toBeDefined();
      expect(item!.outstandingAmount).toBe(SALE_PRICE);

      // And the duplicate representation does not inflate the totals either:
      // one debt is counted once, by its canonical authority.
      const summary = await asUser.query(api.collections.summary, { orgId });
      expect(summary.totalOutstanding).toBe(SALE_PRICE);

      const aging = await asUser.query(api.collections.agingReport, { orgId });
      const agedTotal =
        aging.current.amount +
        aging.days1To30.amount +
        aging.days31To60.amount +
        aging.days61To90.amount +
        aging.over90.amount;
      expect(agedTotal).toBe(SALE_PRICE);
    });
  }

  test("the hand-keyed row stays visible and workable, marked as a duplicate representation", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const receivableId = await addSaleLinkedLegacyRow(t, orgId, customerId, userId, saleId, 8000);

    const queue = await asUser.query(api.collections.listCollectionQueue, { orgId });
    const legacy = queue.items.find((row: any) => String(row.receivableId) === String(receivableId));

    // Withdrawing it from the list would take its assignment, reminders and
    // installment label with it. It stays — it just stops being money.
    expect(legacy).toBeDefined();
    expect(legacy!.duplicateRepresentation).toBe(true);
  });

  /**
   * The monetary target is single; the non-monetary side effects are not.
   *
   * Redirecting the payment allocation to the sale's invoice without redirecting
   * the REFUND left the refund unwinding a document that had never received
   * anything — a workflow dead end, with `CANCEL_RECEIVABLE` blocked behind it
   * (`paidAmount > 0` demands a refund first), so an operator had no way out.
   *
   * The opposite error is just as easy and worse: rescheduling or cancelling a
   * hand-keyed row must NOT reach the sale invoice. One sub-representation may
   * not move the due date of the whole sale debt, and may certainly not cancel
   * it. Those two tests pass before this change as well as after — they exist to
   * stop the resolver being applied where money is not what is moving.
   */
  async function saleInvoiceState(t: any, saleId: any) {
    return await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      const doc = await ctx.db.get(sale!.canonicalReceivableDocumentId!);
      return { status: doc!.status, dueDate: doc!.dueDate };
    });
  }

  async function payThenRequest(
    t: any,
    asUser: any,
    orgId: any,
    customerId: any,
    userId: any,
    saleId: any,
    opts: { pay: number; requestType: "REFUND" | "CANCEL_RECEIVABLE" | "RESCHEDULE"; amount?: number; dueDate?: number }
  ) {
    const receivableId = await addSaleLinkedLegacyRow(t, orgId, customerId, userId, saleId, 8000);
    if (opts.pay > 0) {
      await asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId, amount: opts.pay, method: "CASH", paymentDate: Date.now(),
      });
    }
    const requestId = await asUser.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: opts.requestType,
      requestedAmount: opts.amount,
      requestedDueDate: opts.dueDate,
      reason: "test",
      ...(opts.requestType === "REFUND" ? { disbursementMethod: "CASH" as const } : {}),
    });
    return { receivableId, requestId };
  }

  test("refunding a payment taken on the hand-keyed row unwinds it on the sale's invoice", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const { requestId } = await payThenRequest(t, asUser, orgId, customerId, userId, saleId, {
      pay: 8000, requestType: "REFUND", amount: 3000,
    });

    // Before the fix this threw "Canonical allocations cover only 0 of the
    // requested refund" — the money was on the sale invoice, the reversal was
    // looking at the row's own twin.
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId, requestId, status: "APPROVED",
    });

    // The sale's debt reopens by exactly the refunded amount.
    const item = await canonicalSaleItem(asUser, orgId, saleId);
    expect(item!.outstandingAmount).toBe(SALE_PRICE - 8000 + 3000);
  });

  test("cancelling a hand-keyed row does not cancel the sale it was keyed against", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const { requestId } = await payThenRequest(t, asUser, orgId, customerId, userId, saleId, {
      pay: 0, requestType: "CANCEL_RECEIVABLE",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId, requestId, status: "APPROVED",
    });

    // The operator deleted a redundant copy, not the customer's debt.
    const invoice = await saleInvoiceState(t, saleId);
    expect(invoice.status).not.toBe("CANCELLED");
    const item = await canonicalSaleItem(asUser, orgId, saleId);
    expect(item!.outstandingAmount).toBe(SALE_PRICE);
  });

  test("rescheduling a hand-keyed row does not move the sale invoice's due date", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const before = await saleInvoiceState(t, saleId);

    const { requestId } = await payThenRequest(t, asUser, orgId, customerId, userId, saleId, {
      pay: 0, requestType: "RESCHEDULE", dueDate: Date.now() + 90 * 86_400_000,
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId, requestId, status: "APPROVED",
    });

    const after = await saleInvoiceState(t, saleId);
    expect(after.dueDate).toBe(before.dueDate);
  });

  test("a cheque worth more than the sale still owes is refused in the operator's language", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const receivableId = await addSaleLinkedLegacyRow(t, orgId, customerId, userId, saleId, 8000);

    // Settle the sale down to 3,000 directly, leaving the hand-keyed row's own
    // stored balance stale at 8,000.
    const canonicalId = await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      return sale!.canonicalReceivableDocumentId!;
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableDocumentId: canonicalId, amount: SALE_PRICE - 3000,
      method: "CASH", paymentDate: Date.now(),
    });

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId, customerId, bank: "ABC", chequeNumber: "1001",
      chequeDate: Date.now(), amount: 8000,
    });

    // The stale row would accept 8,000; the sale only owes 3,000. It must refuse
    // the way the recordPayment path does, not in minor units.
    await expect(
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId })
    ).rejects.toThrow(/larger than the sale still owes/);
  });

  test("paying the hand-keyed representation pays down the sale's own invoice", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const receivableId = await addSaleLinkedLegacyRow(t, orgId, customerId, userId, saleId, 8000);

    const before = await canonicalSaleItem(asUser, orgId, saleId);
    expect(before!.outstandingAmount).toBe(SALE_PRICE);

    await asUser.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 8000,
      method: "CASH",
      paymentDate: Date.now(),
    });

    // The money reached the sale's canonical invoice, not a twin document
    // raised from the legacy row. Under the netting model this came back as
    // the full SALE_PRICE — the customer paid and the debt grew back.
    const after = await canonicalSaleItem(asUser, orgId, saleId);
    expect(after).toBeDefined();
    expect(after!.outstandingAmount).toBe(SALE_PRICE - 8000);

    const summary = await asUser.query(api.collections.summary, { orgId });
    expect(summary.totalOutstanding).toBe(SALE_PRICE - 8000);

    // And it settled the sale invoice itself, not a `legacy_receivable`
    // document standing in for it.
    await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      const allocations = await ctx.db
        .query("paymentAllocations")
        .filter((q: any) => q.eq(q.field("receivableDocumentId"), sale!.canonicalReceivableDocumentId))
        .collect();
      const allocated = allocations
        .filter((a: any) => a.status === "ACTIVE")
        .reduce((sum: number, a: any) => sum + a.amountMinor, 0);
      expect(allocated).toBe(8000 * 1000);
    });
  });
});
