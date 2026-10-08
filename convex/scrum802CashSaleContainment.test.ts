/**
 * SCRUM-802 (owner ruling 2026-10-08, «إجراء + منع»): pilot cash-sale containment.
 *
 * Until the invoice receipt resolver (SCRUM-722) exists no door applies a customer's payment to a cash sale's
 * invoice, so (1) a CASH completion refuses when its invoice would stay outstanding after deposit and trade-in
 * allocation, and (2) collections.recordPayment WITHOUT a sale or receivable is refused while the customer owes a sale
 * invoice. These tests run with the switch ON (the suite-wide setup turns it off).
 * Evidence boundary: convex-test, not production.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { H, finalizeAsOwner, readyDeal, refusalMessageOf, seedFinancedDealership } from "../test-utils/financedDealFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));
// Opt back in to the REAL containment constant (vitest.setup.ts mocks it off for the rest of the suite).
vi.mock("./utils/saleDebtContainment", async (importOriginal) => await importOriginal());

const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const PERMS = [
  "view:sales", "create:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "manage:finance", "view:finance", "approve:requests", "confirm:finance_disbursement",
];

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S802 ${tag}`, createdAt: now }));
  await t.run((ctx) => ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: tag }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Cash", lastName: "Buyer" }));
  const mkVehicle = (vin: string, extra: Record<string, unknown> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 0, color: "White", fuelType: "Petrol",
        transmission: "Automatic", sellingPrice: 20000, status: "AVAILABLE", ...extra,
      } as never)
    );
  const vehicleId = await mkVehicle(`VIN802${tag}`, { purchasePrice: 17000 });
  return { t, orgId, userId, customerId, vehicleId, asUser, mkVehicle };
}
type Seeded = Awaited<ReturnType<typeof seedDealer>>;

async function quoteFor(s: Seeded) {
  return await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
}
const deposit = (s: Seeded, quoteId: Id<"quotes">, amount: number) =>
  s.asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, amount });
const complete = (s: Seeded, quoteId: Id<"quotes">) =>
  s.asUser.mutation(api.sales.completeFromQuote, {
    orgId: s.orgId, quoteId, idempotencyKey: crypto.randomUUID(), depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
  });

async function glNet(t: Seeded["t"]) {
  return await t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}
/** Everything a refused completion must leave untouched. */
async function footprint(s: Seeded) {
  return await s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").collect()).length,
    receivableDocs: (await ctx.db.query("receivableDocuments").collect()).length,
    allocations: (await ctx.db.query("paymentAllocations").collect()).length,
    vehicle: (await ctx.db.get(s.vehicleId))?.status,
    deposits: (await ctx.db.query("deposits").collect()).map((d) => ({ status: d.status, holdActive: d.holdActive })),
  }));
}

describe("SCRUM-802 switch", () => {
  test("the production constant is ON, so the pilot containment cannot silently ship disabled", async () => {
    const real = await vi.importActual<typeof import("./utils/saleDebtContainment")>("./utils/saleDebtContainment");
    expect(real.CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED).toBe(true);
  });
});

describe("SCRUM-802 item 1: a CASH completion refuses while its invoice would stay outstanding", () => {
  test("completeFromQuote with NO deposit is refused with the AR/EN reason and nothing is written", async () => {
    const s = await seedDealer("nodep");
    const quoteId = await quoteFor(s);
    const before = await footprint(s);
    const glBefore = await glNet(s.t);

    await expect(complete(s, quoteId)).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);

    expect(await footprint(s)).toEqual(before);
    expect(await glNet(s.t)).toEqual(glBefore);
  });

  test("completeFromQuote with a PARTIAL deposit (5,000 of 20,000) is refused; the deposit stays HELD and unapplied", async () => {
    const s = await seedDealer("partial");
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 5_000);
    const before = await footprint(s);
    const glBefore = await glNet(s.t);

    await expect(complete(s, quoteId)).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);

    expect(await footprint(s)).toEqual(before);
    expect(before.deposits).toEqual([{ status: "HELD", holdActive: true }]);
    expect(await glNet(s.t)).toEqual(glBefore);
  });

  test("completeFromQuote with the FULL payment recorded as a deposit completes: invoice PAID, no unapplied residue, SETTLEMENT COMPLETE", async () => {
    const s = await seedDealer("full");
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);

    const saleIds = await complete(s, quoteId);
    const saleId = saleIds[0] as Id<"sales">;

    const invoice = await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      return await ctx.db.get(sale!.canonicalReceivableDocumentId!);
    });
    expect(invoice?.status).toBe("PAID");
    const gl = await glNet(s.t);
    expect(gl[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(0);
    expect(gl[SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY]).toBeUndefined();
    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    expect(deal?.stages.find((st) => st.key === "SETTLEMENT")?.state).toBe("COMPLETE");
  });

  test("sales.create (COMPLETED, CASH) with no payment is refused, and nothing is written", async () => {
    const s = await seedDealer("create");
    const before = await footprint(s);
    await expect(
      s.asUser.mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
        salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
      })
    ).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);
    expect(await footprint(s)).toEqual(before);
  });

  test("sales.completeDraft of a CASH draft with no payment is refused; the draft stays PENDING", async () => {
    const s = await seedDealer("draft");
    const draftId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 20_000, saleDate: Date.now(), financingType: "CASH", idempotencyKey: crypto.randomUUID(),
    } as never);
    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId: draftId, idempotencyKey: crypto.randomUUID() } as never)
    ).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(draftId))?.status)).toBe("PENDING");
  });

  test("a trade-in worth the full price pays the invoice and the sale completes; a smaller trade-in is refused", async () => {
    const full = await seedDealer("tradefull");
    const tradeFull = await full.mkVehicle("VINTRADE_FULL");
    const saleId = await full.asUser.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(), orgId: full.orgId, vehicleId: full.vehicleId, customerId: full.customerId, salespersonId: full.userId,
      salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH", tradeInVehicleId: tradeFull, tradeInValue: 20_000,
    });
    expect(saleId).toBeTruthy();

    const small = await seedDealer("tradesmall");
    const tradeSmall = await small.mkVehicle("VINTRADE_SMALL");
    const before = await footprint(small);
    await expect(
      small.asUser.mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: small.orgId, vehicleId: small.vehicleId, customerId: small.customerId, salespersonId: small.userId,
        salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH", tradeInVehicleId: tradeSmall, tradeInValue: 5_000,
      })
    ).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);
    expect(await footprint(small)).toEqual(before);
  });

  test("a FINANCED deal is NOT affected: finalizeDeal still completes with the finance company owing the balance", async () => {
    const f = await seedFinancedDealership("fin802", {
      modules: MODULES,
      ownerPerms: [...PERMS, "view:finance_applications", "create:finance_application", "review:finance_application", "approve:finance_application",
        "manage:supplier_settlement", "cancel:closed_deal", "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
        "view:commissions", "manage:commissions", "view:reports", "manage:settings"],
      actors: {}, label: "S802F", vinPrefix: "VIN802F",
    });
    const { applicationId } = await readyDeal(f);
    expect(await refusalMessageOf(finalizeAsOwner(f, applicationId))).toBeNull();
    const app = await f.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CLOSED");
    expect(H).toBeGreaterThan(0);
  });
});

describe("SCRUM-802 item 2: an UNLINKED customer receipt is refused while the customer owes a sale invoice", () => {
  /** A customer sale invoice with `openMinor` outstanding, written raw (a completion can no longer leave one open). */
  async function openInvoice(s: Seeded, openMinor: number, status: "OPEN" | "CANCELLED" = "OPEN", customerId = s.customerId) {
    return await s.t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("receivableDocuments", {
        orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${crypto.randomUUID()}`, payerType: "CUSTOMER", customerId,
        sourceType: "sales", sourceId: `legacy-${crypto.randomUUID()}`, originalAmountMinor: jod(20_000), currency: "JOD", scale: 3,
        issueDate: now, dueDate: now, status, createdAt: now, createdBy: s.userId,
      });
      if (jod(20_000) - openMinor > 0) await payInvoice(ctx, { orgId: s.orgId, userId: s.userId, receivableId: id, amountMinor: jod(20_000) - openMinor });
      return id;
    });
  }
  const unlinked = (s: Seeded, customerId = s.customerId) =>
    s.asUser.mutation(api.collections.recordPayment, {
      orgId: s.orgId, customerId, vehicleId: s.vehicleId, amount: 100, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
    });

  test("refused with the AR/EN reason while the customer's sale invoice has a balance, and nothing is written", async () => {
    const s = await seedDealer("rpopen");
    await openInvoice(s, jod(15_000));
    const payments = () => s.t.run(async (ctx) => (await ctx.db.query("collectionPayments").collect()).length);
    const glBefore = await glNet(s.t);

    await expect(unlinked(s)).rejects.toThrow(/UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED/);

    expect(await payments()).toBe(0);
    expect(await glNet(s.t)).toEqual(glBefore);
  });

  test("allowed once the invoice is paid in full, when it is cancelled, for a customer with no sale invoice, and for another customer", async () => {
    const paid = await seedDealer("rppaid");
    await openInvoice(paid, 0);
    await expect(unlinked(paid)).resolves.toBeDefined();

    const cancelled = await seedDealer("rpcancel");
    await openInvoice(cancelled, jod(20_000), "CANCELLED");
    await expect(unlinked(cancelled)).resolves.toBeDefined();

    const none = await seedDealer("rpnone");
    await expect(unlinked(none)).resolves.toBeDefined();

    const other = await seedDealer("rpother");
    const otherCustomer = await other.t.run((ctx) => ctx.db.insert("customers", { orgId: other.orgId, firstName: "Other", lastName: "Buyer" }));
    await openInvoice(other, jod(20_000));
    await expect(unlinked(other, otherCustomer)).resolves.toBeDefined();
  });

  test("a FINANCED sale's open gap invoice does NOT block an unlinked receipt (the cash must stay recordable)", async () => {
    const s = await seedDealer("rpfin");
    await s.t.run(async (ctx) => {
      const now = Date.now();
      const saleId = await ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: now,
        status: "COMPLETED", financingType: "FINANCED",
      } as never);
      await ctx.db.insert("receivableDocuments", {
        orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${crypto.randomUUID()}`, payerType: "CUSTOMER", customerId: s.customerId,
        sourceType: "sales", sourceId: String(saleId), originalAmountMinor: jod(2_000), currency: "JOD", scale: 3,
        issueDate: now, dueDate: now, status: "OPEN", createdAt: now, createdBy: s.userId,
      });
    });
    await expect(unlinked(s)).resolves.toBeDefined();
  });

  test("the release rehearsal keeps the real switch (certification files must not run with the containment off)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("convex/accountingReleaseRehearsal.test.ts", "utf8");
    expect(src).toContain('vi.mock("./utils/saleDebtContainment", async (importOriginal) => await importOriginal())');
  });

  const cheque = (s: Seeded) =>
    s.asUser.mutation(api.collections.registerCheque, {
      orgId: s.orgId, customerId: s.customerId, bank: "Bank", chequeNumber: `CH-${crypto.randomUUID()}`, chequeDate: Date.now(), amount: 100,
    });

  test("a customer cheque is refused while the customer's sale invoice has a balance, and allowed once it is paid or for a customer with none", async () => {
    const open = await seedDealer("chopen");
    await openInvoice(open, jod(15_000));
    await expect(cheque(open)).rejects.toThrow(/UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED/);
    expect(await open.t.run(async (ctx) => (await ctx.db.query("postDatedCheques").take(5)).length)).toBe(0);

    const paid = await seedDealer("chpaid");
    await openInvoice(paid, 0);
    await expect(cheque(paid)).resolves.toBeDefined();

    const none = await seedDealer("chnone");
    await expect(cheque(none)).resolves.toBeDefined();
  });

  test("a payment that names the sale is still refused by the SCRUM-571 containment, not by this rule", async () => {
    const s = await seedDealer("rpnamed");
    const saleId = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: Date.now(), status: "PENDING",
      } as never);
      return id;
    });
    await expect(
      s.asUser.mutation(api.collections.recordPayment, {
        orgId: s.orgId, saleId, customerId: s.customerId, amount: 100, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/SALE_DEBT_RECEIPT_REFUSED/);
  });
});
