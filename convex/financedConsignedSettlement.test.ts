/**
 * A financed sale of a car that belongs to the supplier, settled directly with
 * him.
 *
 * The finance company sends the purchase amount in full, with no deduction,
 * made out to whoever owns the car. When that is the supplier, none of the money
 * passes through the dealership at all: it sold his car as his agent, issued no
 * invoice for it, and what it holds afterwards is a claim on him for its margin.
 *
 * That is the same shape `consignedSettlementRoute.test.ts` already pins for a
 * CASH deal. What this file covers is the half that only exists on a financed
 * deal — everything `finalizeDeal` does after the sale posts. Those steps all
 * describe money arriving at the dealership, and on this route it never does.
 *
 * Every assertion here reads the ledger or the stored row, never a mutation's
 * return value: the defects being pinned were all cases of a posting that looked
 * right in principle and landed against the wrong account.
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

const MODULES = import.meta.glob("./**/*.ts");

const PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
];

const VEHICLE_PRICE = 20_000;
const SUPPLIER_ENTITLEMENT = 15_000;
const MARGIN = VEHICLE_PRICE - SUPPLIER_ENTITLEMENT;
/** JOD is a three-decimal currency, so a major unit is 1,000 minor units. */
const SCALE = 1_000;

type Route = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

/**
 * A dealership with a live chart and an open period, one consigned car, and a
 * finance company. `sourceType: SOURCED` is what makes the car legally the
 * supplier's; `sourceCost` is his entitlement.
 */
async function seedDealership(tag: string, opts: { sourceType?: "STOCK" | "SOURCED" } = {}) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Financed ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Deal User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.appr@example.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  const asApprover = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const sourceType = opts.sourceType ?? "SOURCED";
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINFIN${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      ...(sourceType === "SOURCED"
        ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: SUPPLIER_ENTITLEMENT }
        : { sourceType: "STOCK" as const, purchasePrice: SUPPLIER_ENTITLEMENT }),
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true,
    })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, companyId, asUser, asApprover };
}

type Seeded = Awaited<ReturnType<typeof seedDealership>>;

/**
 * Walks a deal to APPROVED and, unless told otherwise, finalizes it.
 *
 * `downPayment` is the customer's own money in the deal; `totalFinancedAmount`
 * is the rest. Both are quote figures, and neither says who the finance company
 * pays — that is the route.
 */
async function runDeal(
  s: Seeded,
  opts: {
    route?: Route;
    downPayment?: number;
    finalize?: boolean;
  } = {}
) {
  const downPayment = opts.downPayment ?? 0;
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId,
    totalFinancedAmount: VEHICLE_PRICE - downPayment,
  });

  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  await s.asUser.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
  });
  await s.asApprover.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "APPROVED",
  });

  if (opts.route) {
    await s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route: opts.route,
    });
  }

  await s.asUser.mutation(api.applications.registerVehicleHandover, { orgId: s.orgId, applicationId });
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });

  if (opts.finalize === false) return { quoteId, applicationId, saleId: null };

  const saleId = await s.asUser.mutation(api.applications.finalizeDeal, {
    orgId: s.orgId, applicationId,
  });
  return { quoteId, applicationId, saleId };
}

/**
 * Net movement per system key across the org's ledger, counting an entry
 * exactly the way the application's own balances do.
 *
 * **`REVERSED` entries are included, and that is not an oversight.** Reversing
 * an entry does not retract it: the original is patched to `REVERSED` and a
 * separate reversing entry is `POSTED` beside it, so the pair nets to zero.
 * Counting only `POSTED` drops the original and keeps its reversal, which
 * reports every cancelled sale as a large balance in the opposite direction —
 * this helper did exactly that, and made a correctly-reversed cancellation look
 * like a 5,000 credit balance on Receivable from Suppliers.
 *
 * `accountingReports.ts` and `accounting/accountSnapshots.ts` both filter
 * `POSTED || REVERSED`. A test helper that defines a balance differently from
 * the code under test measures its own arithmetic, not the system's.
 */
async function ledgerBySystemKey(s: Seeded): Promise<Record<string, number>> {
  return await s.t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === s.orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === s.orgId);
    const totals: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
      const lines = (await ctx.db.query("journalLines").collect())
        .filter((l) => l.journalEntryId === entry._id);
      for (const l of lines) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

const financeReceivableOf = (s: Seeded, applicationId: string) =>
  s.t.run((ctx) =>
    ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", s.orgId).eq("sourceType", "finance_application").eq("sourceId", applicationId as never)
      )
      .unique()
  );

const supplierClaimsOf = (s: Seeded) =>
  s.t.run((ctx) =>
    ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
      .collect()
  );

describe("recording which way a financed consigned deal settles", () => {
  test("the route is refused on dealership stock, which has no supplier to settle with", async () => {
    const s = await seedDealership("stock1", { sourceType: "STOCK" });
    const { applicationId } = await runDeal(s, { finalize: false });

    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/dealership stock/i);
  });

  test("it cannot be changed after the deal is finalized and the ledger has committed", async () => {
    const s = await seedDealership("lock1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    ).rejects.toThrow(/already finalized/i);
  });

  test("the recorded route reaches the sale, rather than defaulting under it", async () => {
    const s = await seedDealership("carry1");
    const { saleId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as never)) as {
      supplierSettlementRoute?: string;
    };
    // Before the route was carried through, finalizeDeal passed none at all and
    // an absent route reads as THROUGH_DEALERSHIP — so the deal posted the
    // opposite way from the one that was agreed, silently.
    expect(sale.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
  });
});

describe("DIRECT_TO_SUPPLIER on a financed deal — the company paid the supplier", () => {
  test("no finance-company receivable is opened, because the company owes the dealership nothing", async () => {
    const s = await seedDealership("dts1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    // A receivable here is a claim no payment can ever settle: the company's
    // cheque went to the supplier. It would sit open forever beside the real
    // claim, which runs the other way and is against the supplier.
    expect(await financeReceivableOf(s, applicationId)).toBeNull();
  });

  test("the ledger holds the margin as a claim on the supplier, and nothing gross", async () => {
    const s = await seedDealership("dts2");
    await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    const posted = await ledgerBySystemKey(s);

    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(MARGIN * SCALE);
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);

    // The defect this pins: `hookFinanceDisbursed` posts DR AR-Finance /
    // CR AR-Customers for the whole principal. On this route the customer's AR
    // was never debited with the car, so that credit drove AR-Customers to a
    // large negative balance for a buyer who owes the dealership nothing, and
    // invented an asset against the finance company at the same time.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS] ?? 0).toBe(0);

    // Never the dealership's car, so never its revenue, cost or inventory.
    expect(posted[SYSTEM_KEYS.SALES_REVENUE] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.VEHICLE_INVENTORY] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS] ?? 0).toBe(0);
  });

  test("the supplier margin claim is opened and is the dealership's only asset on the deal", async () => {
    const s = await seedDealership("dts3");
    const { saleId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    const claims = await supplierClaimsOf(s);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.amountDue).toBe(MARGIN);
    expect(claims[0]!.saleId).toBe(saleId);
    expect(claims[0]!.status).toBe("OPEN");
  });

  test("a customer down payment does not become a dealership receivable", async () => {
    const s = await seedDealership("dts4");
    const { saleId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", downPayment: 3_000 });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as never)) as {
      canonicalReceivableDocumentId?: string;
    };
    const receivable = await s.t.run((ctx) =>
      ctx.db.get(sale.canonicalReceivableDocumentId as never)
    ) as { originalAmountMinor: number } | null;

    // `transferFinancedAmountFromCustomerReceivable` rewrites the customer's
    // receivable to `salePrice − financed`, which is the down payment. On this
    // route the dealership billed the customer nothing for the car — the
    // supplier invoiced him — and the down payment goes to the financing, not
    // to the dealership. Writing it here would show the customer owing money
    // nobody billed, with no GL debit behind it.
    expect(receivable?.originalAmountMinor ?? 0).toBe(0);

    const posted = await ledgerBySystemKey(s);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS] ?? 0).toBe(0);
  });
});

describe("confirming the money, on each route", () => {
  test("confirmDisbursement is refused: that money never reaches the dealership's account", async () => {
    const s = await seedDealership("cfm1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    // It books DR Bank / CR AR-Finance Companies. Here there is no bank receipt
    // and no receivable, so it would create cash out of nothing.
    await expect(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
      })
    ).rejects.toThrow(/directly with the supplier/i);
  });

  test("the supplier confirmation records the advice and posts no journal at all", async () => {
    const s = await seedDealership("cfm2");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    const before = await ledgerBySystemKey(s);

    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
      reference: "CHQ-99812",
    });

    // The dealership's books are untouched: this is somebody else being paid.
    expect(await ledgerBySystemKey(s)).toEqual(before);

    const app = await s.t.run((ctx) => ctx.db.get(applicationId as never)) as {
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementReference?: string;
      supplierDisbursementConfirmedAt?: number;
      disbursedAt?: number;
    };
    expect(app.supplierDisbursedAmountMinor).toBe(VEHICLE_PRICE * SCALE);
    expect(app.supplierDisbursementReference).toBe("CHQ-99812");
    // Kept apart from the dealership's own disbursement field. Sharing it would
    // let a payment the dealership never received satisfy a check for one it did.
    expect(app.disbursedAt).toBeUndefined();
  });

  test("it does not settle the supplier's claim — he has been paid, the dealership has not", async () => {
    const s = await seedDealership("cfm3");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const claims = await supplierClaimsOf(s);
    expect(claims[0]!.status).toBe("OPEN");
    expect(claims[0]!.amountReceived ?? 0).toBe(0);
  });

  test("a second advice is refused rather than overwriting the first", async () => {
    const s = await seedDealership("cfm4");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    const once = { orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE };
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, once);
    await expect(
      s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
        ...once, disbursedAmountMinor: 1 * SCALE,
      })
    ).rejects.toThrow(/already been recorded/i);
  });

  test("the supplier confirmation is refused on a deal that settles through the dealership", async () => {
    const s = await seedDealership("cfm5");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP" });

    await expect(
      s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
        orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
      })
    ).rejects.toThrow(/through the dealership/i);
  });
});

describe("THROUGH_DEALERSHIP is unchanged by any of this", () => {
  test("it still opens the finance-company receivable for the financed principal", async () => {
    const s = await seedDealership("thd1");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", downPayment: 3_000 });

    const receivable = await financeReceivableOf(s, applicationId);
    expect(receivable?.payerType).toBe("FINANCE_COMPANY");
    expect(receivable?.originalAmountMinor).toBe((VEHICLE_PRICE - 3_000) * SCALE);
  });

  test("recording no route at all posts identically to naming THROUGH_DEALERSHIP", async () => {
    const named = await seedDealership("thd2");
    await runDeal(named, { route: "THROUGH_DEALERSHIP" });
    const omitted = await seedDealership("thd3");
    await runDeal(omitted, {});

    // Every financed consigned deal finalized before the route existed took the
    // absent path. If the two ever diverge, this change restated them.
    expect(await ledgerBySystemKey(omitted)).toEqual(await ledgerBySystemKey(named));
  });

  test("it still owes the supplier his entitlement out of the gross it collected", async () => {
    const s = await seedDealership("thd4");
    await runDeal(s, { route: "THROUGH_DEALERSHIP" });
    const posted = await ledgerBySystemKey(s);

    expect(posted[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-SUPPLIER_ENTITLEMENT * SCALE);
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
    expect(await supplierClaimsOf(s)).toHaveLength(0);
  });
});

describe("cancelling a direct-settled financed deal", () => {
  test("cancels the supplier's claim and reverses nothing that was never posted", async () => {
    const s = await seedDealership("can1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    await s.asUser.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew",
    });

    const claims = await supplierClaimsOf(s);
    expect(claims[0]!.status).toBe("CANCELLED");

    // The whole deal nets to nothing: the margin claim and the commission
    // revenue that opened it are both reversed out.
    const posted = await ledgerBySystemKey(s);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES] ?? 0).toBe(0);
  });
});
