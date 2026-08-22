/**
 * A taxed owned sale, from `sales.create` through to both books (SCRUM-22).
 *
 * The unit tests in `accounting/ownedSaleTaxPosting.test.ts` pin what
 * `ruleSaleCompleted` returns. They cannot catch the other half of the defect:
 * the canonical `receivableDocuments` row is sized by `customerBillableMinor`
 * in `utils/saleCompletion.ts`, a completely separate expression. Before this
 * change both omitted the tax, so they agreed with each other while both
 * understated what the customer owed — and after fixing only one of them they
 * would have disagreed by exactly the tax, which is worse.
 *
 * So the assertion that matters is not either number on its own. It is that the
 * GL's AR debit and the subledger document are the SAME number, and that the
 * number is what the invoice says.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";

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
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

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

  return { t, orgId, userId, customerId, vehicleId, asUser };
}

/** Net movement on one system account across the sale's journal entry. */
async function netOnAccount(
  t: Awaited<ReturnType<typeof seedDealer>>["t"],
  orgId: string,
  systemKey: string
): Promise<number> {
  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) =>
        q.eq("orgId", orgId as never).eq("systemKey", systemKey)
      )
      .unique();
    if (!account) throw new Error(`No account for ${systemKey}`);

    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) =>
        q.eq("orgId", orgId as never).eq("accountId", account._id)
      )
      .collect();
    return lines.reduce((sum, l) => sum + (l.debitMinor ?? 0) - (l.creditMinor ?? 0), 0);
  });
}

describe("a taxed owned sale reaches both books with the same amount", () => {
  test("the GL receivable, the subledger document and the invoice all agree", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("agree");

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      taxAmount: 3_200,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    // What the invoice says: SaleDialog bills salePrice + taxAmount.
    const invoiceMinor = jod(23_200);

    const arDebitMinor = await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS);
    expect(arDebitMinor).toBe(invoiceMinor);

    const receivable = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const id = sale?.canonicalReceivableDocumentId;
      return id ? await ctx.db.get(id) : null;
    });
    // ANTI-VACUITY: a missing document would make the comparison below pass for
    // the trivial reason.
    expect(receivable).toBeTruthy();
    expect(receivable!.originalAmountMinor).toBe(invoiceMinor);

    // Stated as its own assertion because this is the invariant, not the two
    // amounts: one customer, one bill, two books.
    expect(receivable!.originalAmountMinor).toBe(arDebitMinor);

    // And the tax never became revenue.
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
  });

  test("an untaxed sale is unchanged in both books", async () => {
    // The common case. A fix that shifted this would restate every sale ever
    // recorded, so it is pinned at the same level as the taxed one.
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("plain");

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const arDebitMinor = await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS);
    expect(arDebitMinor).toBe(jod(20_000));

    const receivable = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const id = sale?.canonicalReceivableDocumentId;
      return id ? await ctx.db.get(id) : null;
    });
    expect(receivable).toBeTruthy();
    expect(receivable!.originalAmountMinor).toBe(jod(20_000));
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
  });
});
