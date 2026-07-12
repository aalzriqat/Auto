import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { voidCanonicalPayment } from "./subledger";

const MODULES = import.meta.glob("./**/*.*s");

async function setupSubledgerOrg() {
  const t = convexTest(schema, MODULES);
  const now = Date.now();
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Subledger Dealer", createdAt: now })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "subledger_manager",
      email: "subledger-manager@example.com",
      name: "Subledger Manager",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Mira",
      lastName: "Haddad",
    })
  );
  const asManager = t.withIdentity({ subject: "subledger_manager" });

  return { t, orgId, userId, customerId, asManager };
}

describe("subledger balances", () => {
  test("payment_allocation_and_reversal_recompute_receivable_and_payment_balances", async () => {
    const { orgId, customerId, asManager } = await setupSubledgerOrg();
    const now = Date.now();

    const receivableDocumentId = await asManager.mutation(api.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "manual_invoice",
      sourceId: "invoice-001",
      originalAmountMinor: 100_000,
      currency: "jod",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    const paymentId = await asManager.mutation(api.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 60_000,
      currency: "JOD",
      idempotencyKey: "subledger-payment-1",
    });
    const allocationId = await asManager.mutation(api.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 60_000,
    });

    const partiallyPaid = await asManager.query(api.subledger.getReceivableBalance, {
      orgId,
      receivableDocumentId,
    });
    expect(partiallyPaid?.outstandingMinor).toBe(40_000);
    expect(partiallyPaid?.doc.status).toBe("PARTIALLY_PAID");

    const paymentBalance = await asManager.query(api.subledger.getPaymentBalance, { orgId, paymentId });
    expect(paymentBalance?.unappliedMinor).toBe(0);

    const allocationsByReceivable = await asManager.query(api.subledger.listAllocations, {
      orgId,
      receivableDocumentId,
    });
    expect(allocationsByReceivable).toHaveLength(1);
    expect(allocationsByReceivable[0]._id).toBe(allocationId);

    await asManager.mutation(api.subledger.reverseAllocationMutation, { orgId, allocationId });

    const reopened = await asManager.query(api.subledger.getReceivableBalance, {
      orgId,
      receivableDocumentId,
    });
    expect(reopened?.outstandingMinor).toBe(100_000);
    expect(reopened?.doc.status).toBe("OPEN");

    const allocationsByPayment = await asManager.query(api.subledger.listAllocations, { orgId, paymentId });
    expect(allocationsByPayment.map((allocation) => allocation.status).sort()).toEqual(["REVERSED", "REVERSED"]);
  });

  test("listReceivables_filters_by_customer_and_status", async () => {
    const { orgId, customerId, asManager } = await setupSubledgerOrg();
    const now = Date.now();
    const receivableDocumentId = await asManager.mutation(api.subledger.createReceivable, {
      orgId,
      documentType: "INSTALLMENT",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "installment",
      sourceId: "installment-001",
      originalAmountMinor: 75_000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 14 * 24 * 60 * 60 * 1000,
    });

    const byCustomer = await asManager.query(api.subledger.listReceivables, {
      orgId,
      customerId,
      limit: 10,
    });
    expect(byCustomer.map((doc) => doc._id)).toEqual([receivableDocumentId]);

    const byStatus = await asManager.query(api.subledger.listReceivables, {
      orgId,
      status: "OPEN",
      limit: 10,
    });
    expect(byStatus.map((doc) => doc._id)).toContain(receivableDocumentId);

    const defaultList = await asManager.query(api.subledger.listReceivables, { orgId, limit: 10 });
    expect(defaultList.map((doc) => doc._id)).toContain(receivableDocumentId);
  });

  test("allocation_rejects_amount_above_unapplied_payment_balance", async () => {
    const { orgId, customerId, asManager } = await setupSubledgerOrg();
    const now = Date.now();
    const receivableDocumentId = await asManager.mutation(api.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "manual_invoice",
      sourceId: "invoice-over-allocation",
      originalAmountMinor: 100_000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    const paymentId = await asManager.mutation(api.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 60_000,
      currency: "JOD",
      idempotencyKey: "subledger-over-allocation-payment",
    });
    await asManager.mutation(api.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 60_000,
    });

    await expect(
      asManager.mutation(api.subledger.allocate, {
        orgId,
        paymentId,
        receivableDocumentId,
        amountMinor: 1,
      })
    ).rejects.toThrow(/exceeds unapplied payment balance/i);
  });

  test("voidCanonicalPayment_rejects_active_allocations_and_listAllocations_allows_empty_filters", async () => {
    const { t, orgId, userId, customerId, asManager } = await setupSubledgerOrg();
    const now = Date.now();
    const receivableDocumentId = await asManager.mutation(api.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "manual_invoice",
      sourceId: "invoice-void-active-allocation",
      originalAmountMinor: 50_000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    const paymentId = await asManager.mutation(api.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 50_000,
      currency: "JOD",
      idempotencyKey: "subledger-void-active-allocation-payment",
    });
    await asManager.mutation(api.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 50_000,
    });

    await expect(
      t.run((ctx) => voidCanonicalPayment(ctx, { orgId, paymentId, actorId: userId }))
    ).rejects.toThrow(/active allocations/i);

    const noFilterAllocations = await asManager.query(api.subledger.listAllocations, { orgId });
    expect(noFilterAllocations).toEqual([]);
  });
});
