/**
 * SCRUM-571 slice 2a (D-43), CASH route: a cash sale must never read as settled while its canonical
 * customer invoice has a balance. `sales.create` issues the invoice for the full billable amount and
 * requires no payment, so a COMPLETED cash sale with an open invoice is a normal, reachable state
 * (saleCompletion.ts creates the invoice unconditionally and nothing gates completion on payment).
 *
 * The sale is created through the real mutation and read through the real `sales.dealCockpit`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { getReceivableOutstandingMinor } from "./subledger";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

interface CashSaleOpts {
  /** false: a Free/Starter organization that never initialized a chart of accounts. */
  chart?: boolean;
  /** false: a chart-ready organization with no open period covering the sale date. */
  openPeriod?: boolean;
}

async function seedCashSale(tag: string, opts: CashSaleOpts = {}) {
  const chart = opts.chart ?? true;
  const openPeriod = opts.openPeriod ?? true;
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S2 cash ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Cash User" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  if (chart) await as.mutation(api.chartOfAccounts.initialize, { orgId });
  if (chart && openPeriod) {
    const fiscalYear = new Date().getUTCFullYear();
    await as.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
    await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINCASH${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10, color: "Blue",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 13_000, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: 10_000,
    })
  );
  const saleId = await as.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { t, as, orgId, userId, customerId, saleId, tag };
}

async function payInFull(s: Awaited<ReturnType<typeof seedCashSale>>) {
  await s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(s.saleId))!;
    await payInvoice(ctx, {
      orgId: s.orgId, userId: s.userId, customerId: s.customerId,
      receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 13_000_000,
    });
  });
}

async function settlementStage(s: Awaited<ReturnType<typeof seedCashSale>>) {
  const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
  return deal!.stages.find((st) => st.key === "SETTLEMENT")!.state;
}

async function outstandingMinor(s: Awaited<ReturnType<typeof seedCashSale>>) {
  return await s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(s.saleId))!;
    return await getReceivableOutstandingMinor(ctx, sale.canonicalReceivableDocumentId!);
  });
}

describe("SCRUM-571 s2a: the cash cockpit judges the customer's invoice too", () => {
  test("a completed cash sale whose invoice is open is NOT settled", async () => {
    const s = await seedCashSale("open");
    // The premise: completion left the whole invoice outstanding.
    expect(await outstandingMinor(s)).toBe(13_000_000);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("control: the same sale reads settled once the customer has paid the invoice in full", async () => {
    const s = await seedCashSale("paid");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      await payInvoice(ctx, {
        orgId: s.orgId, userId: s.userId, customerId: s.customerId,
        receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 13_000_000,
      });
    });
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).toBe("COMPLETE");
  });
});

/**
 * SCRUM-571 D-48: the posting proof is required exactly when the sale was completed under a general
 * ledger. Free/Starter organizations have no chart, so their SALE_COMPLETED is only queued and can
 * never post; a fully paid sale there must still read settled.
 */
describe("SCRUM-571 D-48: the posting proof follows the chart state at completion", () => {
  test("a no-chart (Free/Starter) cash sale whose invoice is paid in full reads settled", async () => {
    const s = await seedCashSale("nochart_paid", { chart: false });
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      expect(sale.glPostingRequired).toBe(false);
    });
    await payInFull(s);
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).toBe("COMPLETE");
  });

  test("control: the same no-chart sale with an open invoice is NOT settled", async () => {
    const s = await seedCashSale("nochart_open", { chart: false });
    expect(await outstandingMinor(s)).toBe(13_000_000);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("control: a chart-ready org with no open period still requires the proof, so a paid sale is not settled until the event posts", async () => {
    const s = await seedCashSale("chart_noperiod", { openPeriod: false });
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      // The chart only, never the period: the books are owed this sale.
      expect(sale.glPostingRequired).toBe(true);
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", `sale_completed_${s.saleId}`))
        .first();
      expect(event?.status).not.toBe("POSTED");
    });
    await payInFull(s);
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("the upgrade case: initializing a chart AFTER a paid no-GL sale does not flip it to unproven", async () => {
    const s = await seedCashSale("upgrade", { chart: false });
    await payInFull(s);
    expect(await settlementStage(s)).toBe("COMPLETE");
    await s.as.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
    expect(await settlementStage(s)).toBe("COMPLETE");
  });

  test("a legacy sale with no glPostingRequired and no posted event fails closed", async () => {
    const s = await seedCashSale("legacy", { chart: false });
    await payInFull(s);
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { glPostingRequired: undefined }));
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });
});

/**
 * SCRUM-571 D-48 (F4): whenever the invoice is open the cockpit names that customer balance, behind
 * the existing view:finance projection. Users without it get the qualitative state only.
 */
describe("SCRUM-571 D-48: the cockpit names the customer's invoice balance", () => {
  async function asViewerWithoutFinance(s: Awaited<ReturnType<typeof seedCashSale>>) {
    const viewerId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${s.tag}_viewer`, email: `${s.tag}.v@e.com`, name: "Viewer" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.orgId, name: "SALES", permissions: ["view:sales"], isSystemOwnerRole: false })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: viewerId, roleId }));
    return s.t.withIdentity({ subject: `${s.tag}_viewer`, clerkId: `${s.tag}_viewer` });
  }

  test("an open invoice is named with its outstanding amount for a view:finance caller", async () => {
    const s = await seedCashSale("f4_open");
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.customerInvoiceState).toBe("OPEN");
    expect(deal!.money!.customerInvoice).toEqual({ state: "OPEN", outstandingMinor: 13_000_000, currency: "JOD" });
  });

  test("a part-paid invoice names the remaining balance, not the face value", async () => {
    const s = await seedCashSale("f4_part");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      await payInvoice(ctx, {
        orgId: s.orgId, userId: s.userId, customerId: s.customerId,
        receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 5_000_000,
      });
    });
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.money!.customerInvoice.outstandingMinor).toBe(8_000_000);
  });

  test("a paid invoice reads CLOSED with nothing outstanding", async () => {
    const s = await seedCashSale("f4_paid");
    await payInFull(s);
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.money!.customerInvoice).toEqual({ state: "CLOSED", outstandingMinor: 0, currency: "JOD" });
  });

  test("a caller without view:finance gets the qualitative state and no amount", async () => {
    const s = await seedCashSale("f4_redact");
    const viewer = await asViewerWithoutFinance(s);
    const deal = await viewer.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal).not.toBeNull();
    expect(deal!.customerInvoiceState).toBe("OPEN");
    expect(deal!.money).toBeNull();
  });
});
