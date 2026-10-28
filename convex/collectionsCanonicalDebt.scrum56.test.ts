/**
 * SCRUM-56 / owner ruling SCRUM-760 c23812 #8 (2026-10-28): every enabled receivable is visible in Collections,
 * read from the canonical sale debt.
 *
 * A sale's customer debt is its canonical invoice (`receivableDocuments`, source `sales/<saleId>`). The legacy
 * `receivables` table the Collections tab used to read holds none of it for a pilot sale, so a financed customer
 * gap R sat on the books and nowhere in Collections. These suites drive deals through the real doors and assert that
 * `collections.listOpenSaleReceivables` lists exactly the canonical receivable that is still owed, once, to the
 * tenant that owns it, and that the legacy readers no longer repeat a sale-linked legacy row beside it.
 *
 * Expected figures are hand-worked literals (R = 500 JOD gap = 500,000 minor), never read back from the code under
 * test. The CASH switch is the real one (nothing mocks it off).
 *
 * Evidence boundary: convex-test only (the harness does not enforce Convex's one-paginated-query limit, OCC or
 * the 32,000-document scan limit), repository behaviour and not production data, and no rendered UI.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import {
  finalizeAsOwner, readyDeal, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const OWNER_PERMS = [
  "create:sales", "view:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "approve:requests", "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application", "manage:supplier_settlement", "cancel:closed_deal",
  "confirm:finance_disbursement", "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
  "manage:finance", "view:finance", "view:commissions", "manage:commissions", "view:reports", "manage:settings",
];

/** The customer gap R the showroom is owed on a financed deal: 500 JOD. */
const R = 500_000;
const FIRST_PAGE = { numItems: 50, cursor: null };

async function seed(tag: string, sourced = false) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S56", vinPrefix: "VIN56",
    actors: { viewer: ["view:sales"], finance: ["view:finance"] }, sourced,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** A financed deal with customer gap R, driven through the real doors to a finalized (CLOSED) sale. */
async function closeFinancedWithGap(s: Seeded, route?: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") {
  const { applicationId } = await readyDeal(s, { gapMinor: R, deposit: false, ...(route ? { route } : {}) });
  await finalizeAsOwner(s, applicationId);
  const app = await s.t.run((ctx) => ctx.db.get(applicationId));
  const saleId = app!.finalizedSaleId as Id<"sales">;
  const invoice = await s.t.run(async (ctx) =>
    (await ctx.db.query("receivableDocuments").withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "sales").eq("sourceId", saleId)).collect())
  );
  return { applicationId, saleId, invoice };
}

const list = (s: Seeded, as: Seeded["owner"]["as"] = s.owner.as, paginationOpts: { numItems: number; cursor: string | null } = FIRST_PAGE) =>
  as.query(api.collections.listOpenSaleReceivables, { orgId: s.orgId, paginationOpts });

describe("SCRUM-56: an open sale receivable is visible in Collections, read from the canonical debt", () => {
  test("a FINANCED deal with customer gap R=500 lists its canonical invoice once, at the canonical outstanding", async () => {
    const s = await seed("fin1");
    const { saleId, invoice } = await closeFinancedWithGap(s);

    // Precondition: the debt really is canonical, a single invoice for R, and no legacy row carries it.
    expect(invoice).toHaveLength(1);
    expect(invoice[0].originalAmountMinor).toBe(R);
    expect(await s.t.run((ctx) => ctx.db.query("receivables").collect())).toEqual([]);

    const page = await list(s);
    expect(page.page).toHaveLength(1);
    expect(page.page[0]).toMatchObject({
      receivableDocumentId: invoice[0]._id,
      saleId,
      customerId: s.customerId,
      originalAmountMinor: R,
      outstandingMinor: R,
      currency: "JOD",
      scale: 3,
    });
    expect(page.page[0].customerName).toBe(`Buyer ${"fin1"}`);
    expect(page.isDone).toBe(true);
  });

  test("a SOURCED (consigned) FINANCED deal settled direct to the supplier lists the customer's gap R, not the supplier's claim", async () => {
    const s = await seed("src1", true);
    const { saleId, invoice } = await closeFinancedWithGap(s, "DIRECT_TO_SUPPLIER");
    expect(invoice.map((d) => d.originalAmountMinor)).toEqual([R]);

    const page = await list(s);
    expect(page.page.map((row) => [row.saleId, row.outstandingMinor])).toEqual([[saleId, R]]);
  });

  test("the finance company's receivable is not customer debt: it is not listed here (it has its own Claims queue)", async () => {
    const s = await seed("fc1");
    await closeFinancedWithGap(s);

    const financeCompanyDocs = await s.t.run((ctx) =>
      ctx.db.query("receivableDocuments").withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "finance_application")).collect()
    );
    expect(financeCompanyDocs.length).toBeGreaterThan(0);

    const page = await list(s);
    const listed = page.page.map((row) => row.receivableDocumentId);
    for (const doc of financeCompanyDocs) expect(listed).not.toContain(doc._id);
    expect(page.page).toHaveLength(1);
  });

  test("a partial customer payment lowers the listed outstanding; the full payment drops the receivable out", async () => {
    const s = await seed("pay1");
    const { invoice } = await closeFinancedWithGap(s);
    const receivableId = invoice[0]._id;
    const userId = s.owner.userId;

    await s.t.run((ctx) => payInvoice(ctx, { orgId: s.orgId, userId, customerId: s.customerId, receivableId, amountMinor: 200_000 }));
    const partial = await list(s);
    expect(partial.page.map((row) => row.outstandingMinor)).toEqual([300_000]);

    await s.t.run((ctx) => payInvoice(ctx, { orgId: s.orgId, userId, customerId: s.customerId, receivableId, amountMinor: 300_000 }));
    const settled = await list(s);
    expect(settled.page).toEqual([]);
  });

  test("a financed deal with no customer gap leaves no customer receivable to list", async () => {
    const s = await seed("nogap1");
    const { applicationId } = await readyDeal(s, { deposit: false });
    await finalizeAsOwner(s, applicationId);

    const page = await list(s);
    expect(page.page).toEqual([]);
  });

  test("a CANCELLED sale invoice is not listed", async () => {
    const s = await seed("cxl1");
    const { invoice } = await closeFinancedWithGap(s);
    await s.t.run((ctx) => ctx.db.patch(invoice[0]._id, { status: "CANCELLED", cancelledAt: Date.now() }));

    expect((await list(s)).page).toEqual([]);
  });

  test("pagination walks every open receivable exactly once (page size 1)", async () => {
    const s = await seed("pg1");
    await closeFinancedWithGap(s);
    // A second open sale invoice for a second sale, seeded the way the fixtures seed invoices.
    const extra = await s.t.run(async (ctx) => {
      const saleId = await ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.owner.userId,
        salePrice: 1, saleDate: Date.now() - 1_000, status: "COMPLETED", financingType: "FINANCED",
      } as never);
      const now = Date.now() - 1_000;
      return await ctx.db.insert("receivableDocuments", {
        orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${saleId}`, payerType: "CUSTOMER", customerId: s.customerId,
        sourceType: "sales", sourceId: saleId, originalAmountMinor: 70_000, currency: "JOD", scale: 3, issueDate: now, dueDate: now,
        status: "OPEN", createdAt: now, createdBy: s.owner.userId,
      });
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const page: Awaited<ReturnType<typeof list>> = await list(s, s.owner.as, { numItems: 1, cursor });
      seen.push(...page.page.map((row) => String(row.receivableDocumentId)));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen).toContain(String(extra));
  });
});

describe("SCRUM-56: the pilot CASH sale never lists a receivable (paid in full, or refused)", () => {
  async function seedCash(tag: string) {
    const t = convexTestWithComponents(schema, MODULES);
    const now = Date.now();
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S56 cash ${tag}`, createdAt: now }));
    await t.run((ctx) => ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now }));
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@example.com`, name: tag }));
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMS }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
    const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
    await as.mutation(api.chartOfAccounts.initialize, { orgId });
    const fy = new Date().getUTCFullYear();
    await as.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(fy, 0, 1), endDate: Date.UTC(fy, 11, 31, 23, 59, 59, 999), fiscalYear: fy, periodNumber: 1,
    });
    const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
    await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Cash", lastName: "Buyer" }));
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN56${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 0, color: "White", fuelType: "Petrol",
        transmission: "Automatic", sellingPrice: 20000, status: "AVAILABLE", purchasePrice: 17000,
      } as never)
    );
    const quoteId = await as.mutation(api.quotes.saveQuote, {
      orgId, customerId, vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
    });
    return { t, orgId, as, quoteId };
  }
  const deposit = (c: Awaited<ReturnType<typeof seedCash>>, amount: number) =>
    c.as.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(), orgId: c.orgId, quoteId: c.quoteId, amount });
  const complete = (c: Awaited<ReturnType<typeof seedCash>>) =>
    c.as.mutation(api.sales.completeFromQuote, {
      orgId: c.orgId, quoteId: c.quoteId, idempotencyKey: crypto.randomUUID(), depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
    });
  const listCash = (c: Awaited<ReturnType<typeof seedCash>>) =>
    c.as.query(api.collections.listOpenSaleReceivables, { orgId: c.orgId, paginationOpts: FIRST_PAGE });

  test("a CASH sale with a PARTIAL deposit is refused (no invoice is created), so Collections lists nothing", async () => {
    const c = await seedCash("cashp");
    await deposit(c, 5_000);
    const refusal = await refusalDataOf(complete(c));
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");

    expect((await listCash(c)).page).toEqual([]);
  });

  test("a CASH sale paid in full is completed with a PAID invoice, which is not listed", async () => {
    const c = await seedCash("cashf");
    await deposit(c, 20_000);
    await complete(c);

    const invoices = await c.t.run((ctx) => ctx.db.query("receivableDocuments").collect());
    expect(invoices.filter((d) => d.sourceType === "sales")).toHaveLength(1);
    expect((await listCash(c)).page).toEqual([]);
  });
});

describe("SCRUM-56: no duplicate of a sale-linked legacy receivable beside its canonical invoice", () => {
  async function legacyRowFor(s: Seeded, saleId: Id<"sales">) {
    return await s.t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("receivables", {
        orgId: s.orgId, saleId, customerId: s.customerId, sourceType: "BANK_FINANCED_BALANCE", title: "Historical sale balance",
        originalAmount: 500, outstandingAmount: 500, dueDate: now + 86_400_000, status: "OPEN", createdBy: s.owner.userId,
        createdAt: now, updatedAt: now,
      });
    });
  }

  test("the legacy list, summary and aging exclude a sale-linked legacy row whose sale has a canonical invoice", async () => {
    const s = await seed("dup1");
    const { saleId } = await closeFinancedWithGap(s);
    await legacyRowFor(s, saleId);

    const legacy = await s.owner.as.query(api.collections.listReceivables, { orgId: s.orgId, paginationOpts: FIRST_PAGE });
    expect(legacy.page).toEqual([]);
    const summary = await s.owner.as.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.totalOutstanding).toBe(0);
    const aging = await s.owner.as.query(api.collections.agingReport, { orgId: s.orgId });
    expect(Object.values(aging).reduce((n, bucket) => n + bucket.count, 0)).toBe(0);

    // The debt is still shown, once, from the canonical side.
    const canonical = await list(s);
    expect(canonical.page.map((row) => row.outstandingMinor)).toEqual([R]);
  });

  test("a legacy row with no sale (a manual receivable) stays in the legacy list", async () => {
    const s = await seed("dup2");
    await s.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("receivables", {
        orgId: s.orgId, customerId: s.customerId, sourceType: "OTHER", title: "Manual", originalAmount: 40, outstandingAmount: 40,
        dueDate: now + 86_400_000, status: "OPEN", createdBy: s.owner.userId, createdAt: now, updatedAt: now,
      });
    });
    const legacy = await s.owner.as.query(api.collections.listReceivables, { orgId: s.orgId, paginationOpts: FIRST_PAGE });
    expect(legacy.page.map((row) => row.outstandingAmount)).toEqual([40]);
    expect((await s.owner.as.query(api.collections.summary, { orgId: s.orgId })).totalOutstanding).toBe(40);
  });
});

describe("SCRUM-56: tenancy and permission", () => {
  test("another organization never sees the debt, and cannot read this organization's list", async () => {
    const s = await seed("ten1");
    await closeFinancedWithGap(s);

    const other = await s.t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("organizations", { name: "Other dealer", createdAt: now });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now });
      const userId = await ctx.db.insert("users", { clerkId: "ten1_other", email: "ten1.other@example.com", name: "other" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "OTHER", permissions: ["view:finance"] });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return { orgId };
    });
    const asOther = s.t.withIdentity({ subject: "ten1_other", clerkId: "ten1_other" });

    // Their own list is empty.
    expect((await asOther.query(api.collections.listOpenSaleReceivables, { orgId: other.orgId, paginationOpts: FIRST_PAGE })).page).toEqual([]);
    // Naming this organization is refused: they are not a member of it.
    await expect(list(s, asOther)).rejects.toThrow();
    // The owner still sees exactly their one receivable.
    expect((await list(s)).page).toHaveLength(1);
  });

  test("the list needs view:finance: a sales-only member is refused, a finance member sees the debt", async () => {
    const s = await seed("perm1");
    await closeFinancedWithGap(s);

    await expect(list(s, s.actors.viewer.as)).rejects.toThrow();
    expect((await list(s, s.actors.finance.as)).page).toHaveLength(1);
  });
});
