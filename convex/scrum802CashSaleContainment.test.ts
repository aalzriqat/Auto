/**
 * SCRUM-802 (owner ruling 2026-10-08, «إجراء + منع»): pilot cash-sale containment.
 *
 * Until the invoice receipt resolver (SCRUM-722) exists no door applies a customer's payment to a cash sale's
 * invoice, so (1) a CASH completion refuses when its invoice would stay outstanding after DEPOSITS (a trade-in does not count, owner ruling
 * 2026-10-19), and (2) collections.recordPayment WITHOUT a sale or receivable is refused while the customer owes a sale
 * invoice. These tests run with the real switch ON (nothing mocks it off).
 * Evidence boundary: convex-test, not production.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { SALE_DEBT_CONTAINMENT_REFUSALS } from "./utils/saleDebtContainment";
import { assertNoOpenSaleInvoiceForUnlinkedReceipt } from "./utils/cashSalePilotGate";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { H, finalizeAsOwner, readyDeal, refusalDataOf, refusalMessageOf, seedFinancedDealership } from "../test-utils/financedDealFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));
// No opt-out here: this file runs with the REAL containment constant (nothing mocks it off; the census pins that).

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

    const refusal = await refusalDataOf(complete(s, quoteId));
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(refusal?.message).toBe(commonEn.ServerError_CASH_SALE_BALANCE_UNPAID_REFUSED);

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

  test("a trade-in does not count toward pay-in-full-first (owner: deposit only): a full-price trade-in and a smaller one are both refused", async () => {
    for (const [tag, value] of [["tradefull", 20_000], ["tradesmall", 5_000]] as const) {
      const s = await seedDealer(tag);
      const trade = await s.mkVehicle(`VINTRADE_${tag}`);
      const before = await footprint(s);
      await expect(
        s.asUser.mutation(api.sales.create, {
          idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
          salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH", tradeInVehicleId: trade, tradeInValue: value,
        })
      ).rejects.toThrow(/CASH_SALE_BALANCE_UNPAID_REFUSED/);
      expect(await footprint(s)).toEqual(before);
    }
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

    const refusal = await refusalDataOf(unlinked(s));
    expect(refusal?.code).toBe("UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED");
    expect(refusal?.message).toBe(commonEn.ServerError_UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED);

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
    expect(src).not.toMatch(/vi\.mock\([^)]*(saleDebtContainment|cashSalePilotGate)/);
    expect(src).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED");
    expect(src).not.toContain("legacy-cash-lifecycle" + " opt-out");
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

describe("SCRUM-802: the refusals are translated, in both languages, from the same code", () => {
  test.each(["CASH_SALE_BALANCE_UNPAID_REFUSED", "UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED"] as const)("%s", (code) => {
    const en = (commonEn as Record<string, string>)[`ServerError_${code}`];
    const ar = (commonAr as Record<string, string>)[`ServerError_${code}`];
    // The server text IS the English dictionary entry; the Arabic entry is Arabic and states that nothing changed.
    expect(SALE_DEBT_CONTAINMENT_REFUSALS[code]).toBe(en);
    expect(ar).toMatch(/[\u0600-\u06FF]/);
    expect(ar.endsWith("لم يتم تغيير أي شيء.")).toBe(true);
  });
});

describe("SCRUM-802: a quote with several cars completes whole or not at all", () => {
  test("one car fully funded and one short refuses the whole completion and leaves both cars unsold", async () => {
    const s = await seedDealer("multi");
    const second = await s.mkVehicle("VIN802multi2", { purchasePrice: 17000 });
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 40_000, downPayment: 0, termMonths: 0,
      vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 20_000 }, { vehicleId: second, unitPrice: 20_000 }],
    });
    // The first car is paid in full (20,000), the second only 5,000 of 20,000: its invoice would stay open.
    await deposit(s, quoteId, 25_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId,
      allocations: [{ vehicleId: s.vehicleId, amount: 20_000 }, { vehicleId: second, amount: 5_000 }],
    });
    const state = () =>
      s.t.run(async (ctx) => ({
        sales: (await ctx.db.query("sales").collect()).length,
        invoices: (await ctx.db.query("receivableDocuments").collect()).length,
        allocations: (await ctx.db.query("paymentAllocations").collect()).length,
        first: (await ctx.db.get(s.vehicleId))?.status,
        second: (await ctx.db.get(second))?.status,
        deposits: (await ctx.db.query("deposits").collect()).map((d) => ({ status: d.status, holdActive: d.holdActive })),
      }));
    const before = await state();
    const glBefore = await glNet(s.t);

    const refusal = await refusalDataOf(complete(s, quoteId));

    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    const after = await state();
    expect(after).toEqual(before);
    expect(after.sales).toBe(0);
    // Neither car is sold; each keeps the status the deposit hold gave it.
    expect(after.first).not.toBe("SOLD");
    expect(after.second).not.toBe("SOLD");
    expect(await glNet(s.t)).toEqual(glBefore);
  });
});

describe("SCRUM-802: a receipt or cheque that names a sale invoice is linked, never counted as unlinked", () => {
  async function seedOpenCashInvoice(s: Seeded) {
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

  test("the gate refuses an unlinked target and passes the same target once it names invoiceSaleId", async () => {
    const s = await seedDealer("gateinv");
    const saleId = await seedOpenCashInvoice(s);
    await expect(
      s.t.run((ctx) => assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, s.orgId, { customerId: s.customerId }))
    ).rejects.toThrow(/UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED/);
    await expect(
      s.t.run((ctx) => assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, s.orgId, { customerId: s.customerId, invoiceSaleId: saleId }))
    ).resolves.toBeNull();
  });

  test("recordPayment with invoiceSaleId is refused by the invoice-receipt door switch, not by the unlinked rule", async () => {
    const s = await seedDealer("rpinv");
    const saleId = await seedOpenCashInvoice(s);
    const refusal = await refusalDataOf(
      s.asUser.mutation(api.collections.recordPayment, {
        orgId: s.orgId, customerId: s.customerId, invoiceSaleId: saleId, amount: 100, method: "CASH", paymentDate: Date.now(),
        idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal?.code).toBe("SALE_INVOICE_RECEIPT_DOORS_DISABLED");
  });

  test("registerSaleInvoiceCheque reaches registerChequeCore without the unlinked refusal", async () => {
    const s = await seedDealer("chinv");
    const saleId = await seedOpenCashInvoice(s);
    const refusal = await refusalDataOf(
      s.asUser.mutation(api.collections.registerSaleInvoiceCheque, {
        orgId: s.orgId, saleId, bank: "Bank", chequeNumber: `CH-${crypto.randomUUID()}`, chequeDate: Date.now(), amount: 100,
      } as never)
    );
    expect(refusal?.code).not.toBe("UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED");
  });
});

describe("SCRUM-802: one definition of a cash sale invoice", () => {
  test("a sale governed by a financed plan is not a cash invoice even when its financingType says CASH", async () => {
    const f = await seedFinancedDealership("plan802", {
      modules: MODULES,
      ownerPerms: [...PERMS, "view:finance_applications", "create:finance_application", "review:finance_application", "approve:finance_application",
        "manage:supplier_settlement", "cancel:closed_deal", "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
        "view:commissions", "manage:commissions", "view:reports", "manage:settings"],
      actors: {}, label: "S802P", vinPrefix: "VIN802P",
    });
    const { applicationId } = await readyDeal(f);
    await finalizeAsOwner(f, applicationId);
    const { saleId, customerId, planVersion, financingType } = await f.t.run(async (ctx) => {
      const app = (await ctx.db.get(applicationId))!;
      const sale = (await ctx.db.query("sales").collect()).find((x) => x.applicationId === applicationId)!;
      return { saleId: sale._id, customerId: app.customerId, planVersion: app.financedSalePlanVersion, financingType: sale.financingType };
    });
    expect(planVersion).toBeTruthy();
    // A plan-governed sale is stored FINANCED, so the gate excludes it on financingType alone as well as on the marker.
    expect(financingType).toBe("FINANCED");
    // Strip the sale's own financing label and add a clearly open invoice: only the plan marker can keep it non-cash.
    await f.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { financingType: "CASH" });
      const now = Date.now();
      await ctx.db.insert("receivableDocuments", {
        orgId: f.orgId, documentType: "INVOICE", documentNumber: `INV-${crypto.randomUUID()}`, payerType: "CUSTOMER", customerId,
        sourceType: "sales", sourceId: String(saleId), originalAmountMinor: jod(2_000), currency: "JOD", scale: 3,
        issueDate: now, dueDate: now, status: "OPEN", createdAt: now, createdBy: f.owner.userId,
      });
    });
    await expect(
      f.t.run((ctx) => assertNoOpenSaleInvoiceForUnlinkedReceipt(ctx, f.orgId, { customerId }))
    ).resolves.toBeNull();
  });
});

describe("SCRUM-802: replaceCheque does not create an unlinked instrument against an open sale invoice", () => {
  test("a held unlinked cheque cannot be replaced once the customer owes a sale invoice; the held cheque is left as it was", async () => {
    const s = await seedDealer("repl");
    const chequeId = await s.asUser.mutation(api.collections.registerCheque, {
      orgId: s.orgId, customerId: s.customerId, bank: "Bank", chequeNumber: "CH-1", chequeDate: Date.now(), amount: 100,
    });
    const replace = (n: string) =>
      s.asUser.mutation(api.collections.replaceCheque, {
        orgId: s.orgId, chequeId, bank: "Bank", chequeNumber: n, chequeDate: Date.now(), amount: 100,
      });
    await s.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("receivableDocuments", {
        orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${crypto.randomUUID()}`, payerType: "CUSTOMER", customerId: s.customerId,
        sourceType: "sales", sourceId: `legacy-${crypto.randomUUID()}`, originalAmountMinor: jod(20_000), currency: "JOD", scale: 3,
        issueDate: now, dueDate: now, status: "OPEN", createdAt: now, createdBy: s.userId,
      });
    });
    const refusal = await refusalDataOf(replace("CH-2"));
    expect(refusal?.code).toBe("UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED");
    const cheques = await s.t.run(async (ctx) => (await ctx.db.query("postDatedCheques").collect()).map((c) => c.status));
    expect(cheques).toEqual(["HELD"]);
  });
});
