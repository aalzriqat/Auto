import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { dbSnapshot } from "../test-utils/dbSnapshot";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** JOD is scale 3, so a major unit is 1000 minor. */
const jod = (major: number): number => Math.round(major * 1000);

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const now = Date.now();

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Tax Dealer ${tag}`, createdAt: now })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: [
        "view:sales", "create:sales", "edit:sales",
        "view:vehicles", "create:vehicles", "edit:vehicles",
        "view:customers", "create:customers",
        "manage:finance", "view:finance",
        "approve:requests", "confirm:finance_disbursement",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  // A second actor: cancelling a sale must be approved by someone other than its salesperson.
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_approver`, email: `${tag}.approver@example.com`, name: `${tag} Approver` })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  const asApprover = t.withIdentity({ subject: `${tag}_approver`, clerkId: `${tag}_approver` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Taxed", lastName: "Buyer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN_TAX_${tag}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 0,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      purchasePrice: 17000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );

  return { t, orgId, userId, customerId, vehicleId, asUser, asApprover };
}
/** Outstanding on the sale's canonical invoice: original less ACTIVE allocations (the subledger's own derivation). */
async function invoiceState(t: Awaited<ReturnType<typeof seedDealer>>["t"], saleId: unknown) {
  return await t.run(async (ctx) => {
    const sale = await ctx.db.get(saleId as never) as { canonicalReceivableDocumentId?: string } | null;
    const docId = sale?.canonicalReceivableDocumentId as never;
    const doc = docId ? await ctx.db.get(docId) as { originalAmountMinor: number; status: string } | null : null;
    const allocations = docId
      ? await ctx.db.query("paymentAllocations").collect()
      : [];
    const active = allocations.filter((a) => (a as { receivableDocumentId: string }).receivableDocumentId === (docId as string) && (a as { status: string }).status === "ACTIVE");
    const paid = active.reduce((sum, a) => sum + (a as { amountMinor: number }).amountMinor, 0);
    return doc ? { status: doc.status, original: doc.originalAmountMinor, paid, outstanding: doc.originalAmountMinor - paid } : null;
  });
}

/** Net debit-positive movement per system account across every journal line in the org. */
async function glNet(t: Awaited<ReturnType<typeof seedDealer>>["t"]) {
  return await t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}

/**
 * A completed cash sale, made the pilot way (SCRUM-802, owner ruling Option A): the full 20,000 is taken as a deposit
 * on the quote first, and the sale is then completed against it, so its invoice is PAID. An unpaid cash completion is
 * refused by the backend, so an OPEN cash invoice can no longer be produced through the product.
 */
async function cashSale(tag: string) {
  const seeded = await seedDealer(tag);
  const { orgId, userId, customerId, vehicleId, asUser } = seeded;
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  await asUser.mutation(api.deposits.create, {
    method: "CASH", idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 20_000,
  });
  const saleId = await asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, quoteId, vehicleId, customerId, salespersonId: userId,
    salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { ...seeded, saleId };
}

/** A legacy-shaped OPEN cash invoice (written raw: completion can no longer leave one open). */
async function openCashInvoice(s: Awaited<ReturnType<typeof seedDealer>>) {
  return await s.t.run(async (ctx) => {
    const now = Date.now();
    const saleId = await ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: now,
      status: "COMPLETED", financingType: "CASH",
    } as never);
    await ctx.db.insert("receivableDocuments", {
      orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${crypto.randomUUID()}`, payerType: "CUSTOMER", customerId: s.customerId,
      sourceType: "sales", sourceId: String(saleId), originalAmountMinor: jod(20_000), currency: "JOD", scale: 3,
      issueDate: now, dueDate: now, status: "OPEN", createdAt: now, createdBy: s.userId,
    });
    return saleId;
  });
}

const ALL_TABLES = Object.keys(schema.tables);

/**
 * SCRUM-761 pilot-path finding (SCRUM-571): the cash sale's customer invoice has no product door that applies a
 * receipt to it. These tests pin what the doors do TODAY so the gap is a visible, executed fact rather than a code
 * reading. They are CHARACTERIZATION tests, not an endorsement: when the invoice receipt resolver ships they must be
 * rewritten to assert that the receipt reduces the invoice's outstanding.
 */
describe("SCRUM-571 gap: no product door applies a customer's payment to a cash sale's invoice", () => {
  test("recordPayment naming the sale is refused with SALE_DEBT_RECEIPT_REFUSED, and nothing is written", async () => {
    const { t, orgId, customerId, saleId, asUser } = await cashSale("bySale");
    const before = await glNet(t);
    const snapshotBefore = await dbSnapshot(t, ALL_TABLES);

    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId, saleId, customerId, amount: 20_000, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/SALE_DEBT_RECEIPT_REFUSED/);

    expect(await glNet(t)).toEqual(before);
    expect(await dbSnapshot(t, ALL_TABLES)).toEqual(snapshotBefore);
    expect(await invoiceState(t, saleId)).toMatchObject({ status: "PAID", paid: jod(20_000), outstanding: 0 });
  });

  test("recordPayment without the sale is REFUSED while the customer owes a cash sale invoice (SCRUM-802): nothing parks as unapplied", async () => {
    const s = await seedDealer("unapplied");
    const saleId = await openCashInvoice(s);
    const { t, orgId, customerId, vehicleId, asUser } = s;
    const snapshotBefore = await dbSnapshot(t, ALL_TABLES);

    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId, customerId, vehicleId, amount: 20_000, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED/);

    // Full-table snapshot: no payment, no journal, no allocation, no idempotency row, and the invoice never moved.
    expect(await dbSnapshot(t, ALL_TABLES)).toEqual(snapshotBefore);
    const doc = await t.run(async (ctx) => (await ctx.db.query("receivableDocuments").collect())[0]);
    expect(doc).toMatchObject({ status: "OPEN", originalAmountMinor: jod(20_000) });
    expect(saleId).toBeTruthy();
  });

  test("for a customer with no open cash invoice an unlinked receipt is still accepted and parks as unapplied (the cash stays recordable)", async () => {
    const { t, orgId, customerId, vehicleId, saleId, asUser } = await cashSale("parked");
    expect(await invoiceState(t, saleId)).toMatchObject({ status: "PAID", outstanding: 0 });

    await asUser.mutation(api.collections.recordPayment, {
      orgId, customerId, vehicleId, amount: 5_000, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
    });

    const net = await glNet(t);
    // The extra cash is real, held as a liability to the customer; the paid invoice never moved.
    expect(net[SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY]).toBe(-jod(5_000));
    expect(await invoiceState(t, saleId)).toMatchObject({ status: "PAID", paid: jod(20_000), outstanding: 0 });
  });
});

async function depositFlow(tag: string, depositMajor: number) {
  const s = await seedDealer(tag);
  const { t, orgId, customerId, vehicleId, asUser, asApprover } = s;
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  const out: Record<string, unknown> = {};
  const depositId = await asUser.mutation(api.deposits.create, {
    method: "CASH", idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: depositMajor,
  });
  out.glAfterDeposit = await glNet(t);
  let saleIds: unknown;
  try {
    saleIds = await asUser.mutation(api.sales.completeFromQuote, {
      orgId, quoteId, idempotencyKey: crypto.randomUUID(),
      depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
    });
  } catch (e) { out.completeError = String(e).slice(0, 400); }
  out.saleIds = saleIds;
  const saleId = (Array.isArray(saleIds) ? saleIds[0] : saleIds) as never;
  if (saleId) {
    out.invoice = await invoiceState(t, saleId);
    out.glAfterComplete = await glNet(t);
    const deal = await asUser.query(api.sales.dealCockpit, { orgId, saleId });
    out.settlement = deal?.stages.find((st) => st.key === "SETTLEMENT")?.state;
    out.deposit = await t.run(async (ctx) => { const d = await ctx.db.get(depositId); return { status: d?.status, holdActive: d?.holdActive }; });
    try {
      await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });
      out.cancel = "ACCEPTED";
    } catch (e) { out.cancel = String(e).slice(0, 400); }
    out.invoiceAfterCancel = await invoiceState(t, saleId);
    out.glAfterCancel = await glNet(t);
    out.depositAfterCancel = await t.run(async (ctx) => { const d = await ctx.db.get(depositId); return { status: d?.status, holdActive: d?.holdActive }; });
    out.saleAfterCancel = await t.run(async (ctx) => (await ctx.db.get(saleId) as { status?: string } | null)?.status);
    out.vehicleAfterCancel = await t.run(async (ctx) => (await ctx.db.get(vehicleId))?.status);
    try {
      await asApprover.mutation(api.deposits.release, {
        orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH", idempotencyKey: crypto.randomUUID(),
      });
      out.refund = "ACCEPTED";
    } catch (e) { out.refund = String(e).slice(0, 400); }
    out.glAfterRefund = await glNet(t);
    out.depositAfterRefund = await t.run(async (ctx) => { const d = await ctx.db.get(depositId); return { status: d?.status, holdActive: d?.holdActive }; });
    out.vehicleAfterRefund = await t.run(async (ctx) => (await ctx.db.get(vehicleId))?.status);
  }
  return out;
}

/**
 * The candidate pilot workaround for the gap above: take the customer's cash as a DEPOSIT, then complete the sale from
 * the quote applying it. Characterization of what that does TODAY (SCRUM-722, the invoice receipt resolver, is not
 * built; SCRUM-723, the cancel/unwind exit, is not built). Evidence boundary: convex-test, not production.
 */
describe("SCRUM-571 workaround: the customer's cash taken as a deposit, then applied at completion", () => {
  test("a FULL deposit settles the cash sale: invoice PAID, no unapplied residue, cockpit SETTLEMENT COMPLETE", async () => {
    const r = await depositFlow("full", 20_000);

    expect(r.completeError).toBeUndefined();
    expect(r.invoice).toMatchObject({ status: "PAID", paid: jod(20_000), outstanding: 0 });
    const gl = r.glAfterComplete as Record<string, number>;
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND]).toBe(jod(20_000));
    expect(gl[SYSTEM_KEYS.SALES_REVENUE]).toBe(-jod(20_000));
    expect(gl[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(0);
    expect(gl[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(0);
    expect(gl[SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY]).toBeUndefined();
    expect(r.deposit).toEqual({ status: "APPLIED", holdActive: false });
    expect(r.settlement).toBe("COMPLETE");
  });

  test("a PARTIAL deposit (5,000 of 20,000) is REFUSED at completion (SCRUM-802): nothing is sold, the deposit stays held", async () => {
    const s = await seedDealer("part");
    const { t, orgId, customerId, vehicleId, asUser } = s;
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId, customerId, vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, {
      method: "CASH", idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5_000,
    });
    const snapshotBefore = await dbSnapshot(t, ALL_TABLES);

    await expect(
      asUser.mutation(api.sales.completeFromQuote, {
        orgId, quoteId, idempotencyKey: crypto.randomUUID(),
        depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
      })
    ).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);

    // No sale, no invoice, no application: every table is exactly as it was after the deposit.
    expect(await dbSnapshot(t, ALL_TABLES)).toEqual(snapshotBefore);
    expect(await t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(0);
    // The 15,000 balance is therefore never left "owed that no door can collect": it must be paid in as a deposit first.
  });

  test("cancelling the deposit-paid sale is ACCEPTED: revenue and cost reverse, the deposit returns to HELD as a 20,000 liability, and a refund through deposits.release clears it", async () => {
    const r = await depositFlow("cancel", 20_000);

    expect(r.cancel).toBe("ACCEPTED");
    expect(r.saleAfterCancel).toBe("CANCELLED");
    const afterCancel = r.glAfterCancel as Record<string, number>;
    expect(afterCancel[SYSTEM_KEYS.SALES_REVENUE]).toBe(0);
    expect(afterCancel[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD]).toBe(0);
    expect(afterCancel[SYSTEM_KEYS.VEHICLE_INVENTORY]).toBe(0);
    // The customer's money is still in the till and still owed back: a liability, not revenue.
    expect(afterCancel[SYSTEM_KEYS.CASH_ON_HAND]).toBe(jod(20_000));
    expect(afterCancel[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(-jod(20_000));
    expect(r.depositAfterCancel).toEqual({ status: "HELD", holdActive: true });
    // The car stays locked until somebody decides the deposit (SCRUM-712).
    expect(r.vehicleAfterCancel).toBe("RESERVED");

    // The refund door works: cash goes out, the liability clears, the car is released.
    expect(r.refund).toBe("ACCEPTED");
    const afterRefund = r.glAfterRefund as Record<string, number>;
    expect(afterRefund[SYSTEM_KEYS.CASH_ON_HAND]).toBe(0);
    expect(afterRefund[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(0);
    expect(r.depositAfterRefund).toEqual({ status: "REFUNDED", holdActive: false });
    expect(r.vehicleAfterRefund).toBe("AVAILABLE");
  });
});
