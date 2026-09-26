import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { voidCanonicalPayment } from "./subledger";

const MODULES = import.meta.glob("./**/*.*s");

async function setupSubledgerOrg() {
  const t = convexTestWithComponents(schema, MODULES);
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

    const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
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
    const paymentId = await asManager.mutation(internal.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 60_000,
      currency: "JOD",
      idempotencyKey: "subledger-payment-1",
    });
    const allocationId = await asManager.mutation(internal.subledger.allocate, {
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

    await asManager.mutation(internal.subledger.reverseAllocationMutation, { orgId, allocationId });

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
    const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
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
    const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
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
    const paymentId = await asManager.mutation(internal.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 60_000,
      currency: "JOD",
      idempotencyKey: "subledger-over-allocation-payment",
    });
    await asManager.mutation(internal.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 60_000,
    });

    await expect(
      asManager.mutation(internal.subledger.allocate, {
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
    const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
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
    const paymentId = await asManager.mutation(internal.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 50_000,
      currency: "JOD",
      idempotencyKey: "subledger-void-active-allocation-payment",
    });
    await asManager.mutation(internal.subledger.allocate, {
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

/**
 * SCRUM-261: listAllocations authorised the org it was TOLD about, then read
 * the allocations of whatever parent id it was handed. A member of one
 * dealership holding another's receivable or payment id could read that
 * dealership's allocation amounts. The parent must be proven to belong to the
 * caller's org before any child row is read, and only same-org children leave.
 */
describe("SCRUM-261 listAllocations tenant boundary", () => {
  async function seedForeignAllocation(t: Awaited<ReturnType<typeof setupSubledgerOrg>>["t"]) {
    const now = Date.now();
    const foreignOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Foreign Dealer", createdAt: now }),
    );
    const foreignUserId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "foreign_owner",
        email: "foreign-owner@example.com",
        name: "Foreign Owner",
      }),
    );
    const foreignRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: foreignOrgId,
        name: "OWNER",
        permissions: ALL_PERMISSIONS,
        isSystemOwnerRole: true,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: foreignOrgId, userId: foreignUserId, roleId: foreignRoleId }),
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: foreignOrgId,
        plan: "professional",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const foreignCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: foreignOrgId, firstName: "Rana", lastName: "Saleh" }),
    );
    const asForeignOwner = t.withIdentity({ subject: "foreign_owner" });
    const foreignReceivableId = await asForeignOwner.mutation(internal.subledger.createReceivable, {
      orgId: foreignOrgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId: foreignCustomerId,
      sourceType: "manual_invoice",
      sourceId: "foreign-invoice-001",
      originalAmountMinor: 900_000,
      currency: "jod",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    const foreignPaymentId = await asForeignOwner.mutation(internal.subledger.recordPayment, {
      orgId: foreignOrgId,
      direction: "IN",
      customerId: foreignCustomerId,
      method: "CASH",
      amountMinor: 450_000,
      currency: "JOD",
      idempotencyKey: "foreign-payment-1",
    });
    const foreignAllocationId = await asForeignOwner.mutation(internal.subledger.allocate, {
      orgId: foreignOrgId,
      paymentId: foreignPaymentId,
      receivableDocumentId: foreignReceivableId,
      amountMinor: 450_000,
    });
    return { foreignOrgId, foreignReceivableId, foreignPaymentId, foreignAllocationId, asForeignOwner };
  }

  test("a foreign receivable id returns nothing to another org's member", async () => {
    const { t, orgId, asManager } = await setupSubledgerOrg();
    const { foreignReceivableId } = await seedForeignAllocation(t);

    const leaked = await asManager.query(api.subledger.listAllocations, {
      orgId,
      receivableDocumentId: foreignReceivableId,
    });
    expect(leaked).toEqual([]);
  });

  test("a foreign payment id returns nothing to another org's member", async () => {
    const { t, orgId, asManager } = await setupSubledgerOrg();
    const { foreignPaymentId } = await seedForeignAllocation(t);

    const leaked = await asManager.query(api.subledger.listAllocations, { orgId, paymentId: foreignPaymentId });
    expect(leaked).toEqual([]);
  });

  test("control: the owning org still reads its allocations by receivable and by payment", async () => {
    const { t } = await setupSubledgerOrg();
    const { foreignOrgId, foreignReceivableId, foreignPaymentId, foreignAllocationId, asForeignOwner } =
      await seedForeignAllocation(t);

    const byReceivable = await asForeignOwner.query(api.subledger.listAllocations, {
      orgId: foreignOrgId,
      receivableDocumentId: foreignReceivableId,
    });
    expect(byReceivable.map((row) => row._id)).toEqual([foreignAllocationId]);
    const byPayment = await asForeignOwner.query(api.subledger.listAllocations, {
      orgId: foreignOrgId,
      paymentId: foreignPaymentId,
    });
    expect(byPayment.map((row) => row._id)).toEqual([foreignAllocationId]);
  });

  test("an allocation row stamped with another org is never returned under an owned parent", async () => {
    // Defence in depth: the parent check alone would trust every child of an
    // owned parent. A child carrying another org's id must still not leave.
    const { t, orgId, userId, customerId, asManager } = await setupSubledgerOrg();
    const { foreignOrgId, foreignPaymentId } = await seedForeignAllocation(t);
    const now = Date.now();
    const ownReceivableId = await asManager.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "manual_invoice",
      sourceId: "own-invoice-001",
      originalAmountMinor: 100_000,
      currency: "jod",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    await t.run((ctx) =>
      ctx.db.insert("paymentAllocations", {
        orgId: foreignOrgId,
        paymentId: foreignPaymentId,
        receivableDocumentId: ownReceivableId,
        amountMinor: 1,
        currency: "JOD",
        scale: 3,
        allocationDate: now,
        status: "ACTIVE",
        createdBy: userId,
        createdAt: now,
      }),
    );

    const rows = await asManager.query(api.subledger.listAllocations, { orgId, receivableDocumentId: ownReceivableId });
    expect(rows).toEqual([]);
  });

  test("a foreign parent is refused even when its child carries the caller's org id", async () => {
    // The mirror of the case above: only the PARENT check can refuse this, so
    // each guard is proven on its own rather than one masking the other.
    const { t, orgId, userId, asManager } = await setupSubledgerOrg();
    const { foreignReceivableId, foreignPaymentId } = await seedForeignAllocation(t);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("paymentAllocations", {
        orgId,
        paymentId: foreignPaymentId,
        receivableDocumentId: foreignReceivableId,
        amountMinor: 1,
        currency: "JOD",
        scale: 3,
        allocationDate: now,
        status: "ACTIVE",
        createdBy: userId,
        createdAt: now,
      }),
    );

    expect(
      await asManager.query(api.subledger.listAllocations, { orgId, receivableDocumentId: foreignReceivableId }),
    ).toEqual([]);
    expect(await asManager.query(api.subledger.listAllocations, { orgId, paymentId: foreignPaymentId })).toEqual([]);
  });
});
