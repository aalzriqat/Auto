import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

async function seedPhase3Dealer() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase 3 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p3_user", email: "p3@example.com", name: "P3 User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Subledger", lastName: "Test" })
  );
  const asUser = t.withIdentity({ subject: "p3_user", clerkId: "p3_user" });
  return { t, orgId, userId, customerId, asUser };
}

describe("Phase 3 — receivable documents", () => {
  test("can create a receivable invoice", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "sales",
      sourceId: "sale_sub_001",
      originalAmountMinor: 65000000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 30 * 86400_000,
    });
    expect(recId).toBeTruthy();
  });

  test("receivable balance starts at full original amount", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "sales",
      sourceId: "sale_sub_002",
      originalAmountMinor: 10000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 30 * 86400_000,
    });

    const balance = await asUser.query(api.subledger.getReceivableBalance, {
      orgId,
      receivableDocumentId: recId,
    });
    expect(balance?.outstandingMinor).toBe(10000);
    expect(balance?.doc.status).toBe("OPEN");
  });
});

describe("Phase 3 — payments", () => {
  test("recording same idempotency key twice returns same payment", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();

    const first = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_idem_001",
    });
    const second = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_idem_001",
    });
    expect(second).toBe(first);
  });

  test("payment unapplied balance equals full amount before any allocation", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();

    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 8000, currency: "JOD", idempotencyKey: "pay_bal_001",
    });

    const balance = await asUser.query(api.subledger.getPaymentBalance, { orgId, paymentId: payId });
    expect(balance?.unappliedMinor).toBe(8000);
  });
});

describe("Phase 3 — payment allocations", () => {
  test("allocating full amount marks receivable PAID", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_alloc_001",
      originalAmountMinor: 5000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_alloc_001",
    });

    await asUser.mutation(internal.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 5000,
    });

    const balance = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: recId });
    expect(balance?.outstandingMinor).toBe(0);
    expect(balance?.doc.status).toBe("PAID");
  });

  test("partial allocation leaves PARTIALLY_PAID status", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_partial_001",
      originalAmountMinor: 10000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 4000, currency: "JOD", idempotencyKey: "pay_partial_001",
    });

    await asUser.mutation(internal.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 4000,
    });

    const balance = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: recId });
    expect(balance?.outstandingMinor).toBe(6000);
    expect(balance?.doc.status).toBe("PARTIALLY_PAID");
  });

  test("one payment can settle multiple receivables", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const rec1 = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INSTALLMENT", payerType: "CUSTOMER", customerId,
      sourceType: "installments", sourceId: "inst_001",
      originalAmountMinor: 3000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const rec2 = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INSTALLMENT", payerType: "CUSTOMER", customerId,
      sourceType: "installments", sourceId: "inst_002",
      originalAmountMinor: 3000, currency: "JOD",
      issueDate: now, dueDate: now + 60 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 6000, currency: "JOD", idempotencyKey: "pay_multi_rec",
    });

    await asUser.mutation(internal.subledger.allocate, { orgId, paymentId: payId, receivableDocumentId: rec1, amountMinor: 3000 });
    await asUser.mutation(internal.subledger.allocate, { orgId, paymentId: payId, receivableDocumentId: rec2, amountMinor: 3000 });

    const b1 = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: rec1 });
    const b2 = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: rec2 });
    expect(b1?.doc.status).toBe("PAID");
    expect(b2?.doc.status).toBe("PAID");

    const payBal = await asUser.query(api.subledger.getPaymentBalance, { orgId, paymentId: payId });
    expect(payBal?.unappliedMinor).toBe(0);
  });

  test("over-allocation is rejected", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_over_001",
      originalAmountMinor: 2000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_over_001",
    });

    await expect(
      asUser.mutation(internal.subledger.allocate, {
        orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 3000,
      })
    ).rejects.toThrow(/exceeds receivable outstanding/i);
  });

  test("allocation reversal restores receivable to OPEN", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_rev_001",
      originalAmountMinor: 4000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 4000, currency: "JOD", idempotencyKey: "pay_rev_001",
    });

    const allocId = await asUser.mutation(internal.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 4000,
    });

    // Verify PAID before reversal
    const before = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: recId });
    expect(before?.doc.status).toBe("PAID");

    await asUser.mutation(internal.subledger.reverseAllocationMutation, { orgId, allocationId: allocId });

    const after = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: recId });
    expect(after?.outstandingMinor).toBe(4000);
    expect(after?.doc.status).toBe("OPEN");
  });

  test("multiple payments can settle one receivable", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_multi_pay",
      originalAmountMinor: 9000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const pay1 = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 4000, currency: "JOD", idempotencyKey: "multi_pay_1",
    });
    const pay2 = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "BANK_TRANSFER",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "multi_pay_2",
    });

    await asUser.mutation(internal.subledger.allocate, { orgId, paymentId: pay1, receivableDocumentId: recId, amountMinor: 4000 });
    await asUser.mutation(internal.subledger.allocate, { orgId, paymentId: pay2, receivableDocumentId: recId, amountMinor: 5000 });

    const balance = await asUser.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: recId });
    expect(balance?.outstandingMinor).toBe(0);
    expect(balance?.doc.status).toBe("PAID");
  });

  test("currency mismatch between payment and receivable is rejected", async () => {
    const { orgId, customerId, asUser } = await seedPhase3Dealer();
    const now = Date.now();

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_curr_mismatch",
      originalAmountMinor: 5000, currency: "JOD",
      issueDate: now, dueDate: now + 30 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "USD", idempotencyKey: "pay_curr_mismatch",
    });

    await expect(
      asUser.mutation(internal.subledger.allocate, {
        orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 5000,
      })
    ).rejects.toThrow(/Currency mismatch/i);
  });
});
