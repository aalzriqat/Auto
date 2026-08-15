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
 * A terminal receivable disposition is a business decision, not an arithmetic
 * result (SCRUM-51 review).
 *
 * `reverseAllocation` recomputes the receivable's status from its remaining
 * active allocations. That is correct while the document is live, but it used
 * to run unconditionally, so a document whose status had already been decided
 * — CANCELLED because the sale was cancelled or the deal voided — could be
 * relabelled by the arithmetic of an unrelated reversal.
 *
 * What that produced is worth stating precisely, because the reviews that
 * raised it predicted something else. `getReceivableOutstandingMinor` returns 0
 * for CANCELLED before the recompute reads it, and 0 maps to PAID — so a
 * cancelled receivable was relabelled **PAID**, not reopened. Nothing became
 * collectible again. WRITTEN_OFF and REVERSED would have landed on OPEN.
 *
 * These tests pin the WRITER, and reach it directly rather than through a
 * business flow, because no business flow reaches it: this is defense in depth
 * against an unreachable state, not a live bug. The reachability argument was
 * wrong when first made, and the correction is recorded in `subledger.ts` so it
 * is not re-derived — briefly, CANCEL_RECEIVABLE throws on `paidAmount > 0`
 * before it ever reads a cheque's status, `cancelSaleReceivableIfSafe` reverses
 * allocations before cancelling, and nothing writes WRITTEN_OFF or REVERSED at
 * all.
 *
 * That is exactly why the setup patches the status directly. Driving a real
 * mutation chain here would assert that the chain refuses — a different and
 * already-covered claim — and would leave the writer itself untested, which is
 * the thing consumers depend on.
 */
describe("terminal receivable dispositions survive allocation reversal", () => {
  test.each(["CANCELLED", "WRITTEN_OFF", "REVERSED"] as const)(
    "a %s receivable keeps its disposition when an allocation is reversed",
    async (terminalStatus) => {
      const { t, orgId, customerId, asManager } = await setupSubledgerOrg();
      const now = Date.now();

      const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
        orgId,
        documentType: "INVOICE",
        payerType: "CUSTOMER",
        customerId,
        sourceType: "manual_invoice",
        sourceId: `invoice-terminal-${terminalStatus}`,
        originalAmountMinor: 100_000,
        currency: "JOD",
        issueDate: now,
        dueDate: now + 7 * 24 * 60 * 60 * 1000,
      });
      const paymentId = await asManager.mutation(internal.subledger.recordPayment, {
        orgId,
        direction: "IN",
        customerId,
        method: "CHEQUE",
        amountMinor: 60_000,
        currency: "JOD",
        idempotencyKey: `subledger-terminal-${terminalStatus}`,
      });
      // The allocation is made while the document is still live — that is the
      // only order the real flows produce, and it is what leaves an ACTIVE
      // allocation attached to a document that is terminated afterwards.
      const allocationId = await asManager.mutation(internal.subledger.allocate, {
        orgId,
        paymentId,
        receivableDocumentId,
        amountMinor: 60_000,
      });
      await t.run((ctx) => ctx.db.patch(receivableDocumentId, { status: terminalStatus }));

      await asManager.mutation(internal.subledger.reverseAllocationMutation, { orgId, allocationId });

      const doc = await t.run((ctx) => ctx.db.get(receivableDocumentId));
      expect(doc?.status).toBe(terminalStatus);
    }
  );

  test("a live receivable still recomputes its status from the reversal", async () => {
    // The guard must refuse to overwrite a decision, not stop maintaining the
    // status at all — a fix that simply skipped the patch would satisfy the
    // three cases above while breaking every ordinary reversal.
    const { t, orgId, customerId, asManager } = await setupSubledgerOrg();
    const now = Date.now();

    const receivableDocumentId = await asManager.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "manual_invoice",
      sourceId: "invoice-live-reversal",
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
      amountMinor: 100_000,
      currency: "JOD",
      idempotencyKey: "subledger-live-reversal",
    });
    const allocationId = await asManager.mutation(internal.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 100_000,
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(receivableDocumentId))?.status)).toBe("PAID");

    await asManager.mutation(internal.subledger.reverseAllocationMutation, { orgId, allocationId });

    const doc = await t.run((ctx) => ctx.db.get(receivableDocumentId));
    expect(doc?.status).toBe("OPEN");
  });
});
