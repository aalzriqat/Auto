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
    /** A reservation deposit (عربون) held on the quote before the deal closes. */
    deposit?: number;
    /** A deposit taken AFTER the route was chosen — the ordering the route-time guard cannot see. */
    depositAfterRoute?: number;
    /**
     * Every mode but CONFIGURED_FINANCE_COMPANY is refused a `companyId` by
     * `quotes.saveQuote`, so these are the shapes where "is there an external
     * financier?" cannot be answered by looking at that field.
     */
    mode?:
      | "CONFIGURED_FINANCE_COMPANY"
      | "INTERNAL_INSTALLMENT"
      | "MANUAL_FINANCE_COMPANY"
      | "LEASE";
    /** The manual financier's name, which is the only identity that mode has. */
    manualProviderName?: string;
    /**
     * The legacy shape: `mode` is optional on both the quote and the
     * application, and `saveQuote` explicitly permits a `companyId` without
     * one. Rows written before the field existed look exactly like this.
     */
    omitMode?: boolean;
    depositResolution?: {
      treatment: "APPLY_TO_DEALER_AMOUNT" | "APPLY_TO_TRANSACTION_SETTLEMENT" | "REFUND_TO_CUSTOMER" | "FORFEITED" | "OTHER";
      reason?: string;
    };
  } = {}
) {
  const downPayment = opts.downPayment ?? 0;
  const mode = opts.mode ?? "CONFIGURED_FINANCE_COMPANY";
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment,
    termMonths: 48,
    ...(opts.omitMode ? {} : { mode }),
    ...(mode === "CONFIGURED_FINANCE_COMPANY" ? { companyId: s.companyId } : {}),
    ...(mode === "MANUAL_FINANCE_COMPANY" && opts.manualProviderName !== undefined
      ? { manualProviderName: opts.manualProviderName }
      : {}),
    totalFinancedAmount: VEHICLE_PRICE - downPayment,
  });

  if (opts.deposit) {
    await s.asUser.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: opts.deposit,
    });
  }

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

  if (opts.depositAfterRoute) {
    await s.asUser.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: opts.depositAfterRoute,
    });
  }

  await s.asUser.mutation(api.applications.registerVehicleHandover, { orgId: s.orgId, applicationId });
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });

  if (opts.finalize === false) return { quoteId, applicationId, saleId: null };

  const saleId = await s.asUser.mutation(api.applications.finalizeDeal, {
    orgId: s.orgId,
    applicationId,
    ...(opts.depositResolution ? { depositResolution: opts.depositResolution } : {}),
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

  test("a new consigned financed deal cannot be finalized without choosing a route", async () => {
    const s = await seedDealership("thd2");
    const { applicationId } = await runDeal(s, { finalize: false });

    // Absent still READS as THROUGH_DEALERSHIP — that is what every deal
    // finalized before the field existed actually posted, and
    // `consignedSettlementRoute.test.ts` pins that reading so history is never
    // restated. But it is a dangerous DEFAULT for a new deal: the two routes
    // produce opposite balance sheets from the same sale, and simply forgetting
    // would post one of them silently. So the question is asked once, here.
    await expect(
      s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId })
    ).rejects.toThrow(/settlement route/i);
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

/**
 * Findings from the adversarial review of this PR, each pinned by the behaviour
 * that was wrong rather than by the shape of its fix.
 */
describe("a reservation deposit on the direct route", () => {
  test("the route is refused while the deposit is unresolved, at the point of choosing", async () => {
    const s = await seedDealership("dep0");
    const { applicationId } = await runDeal(s, { deposit: 3_000, finalize: false });

    // Refused HERE rather than at finalization. On this route the dealership
    // bills the customer nothing for the car, so the deposit always exceeds
    // what it billed — and the treatments available are genuinely constrained:
    // applying it to the settlement is refused once it exceeds the margin
    // (ordinary, since deposits run 5-10% of price and consignment margins are
    // often smaller), and refunding needs a method, the deposit permission and
    // a different approver from whoever took it.
    //
    // Failing closed where the operator is choosing leaves them somewhere to
    // go. Failing at finalization left them holding a deal they could neither
    // complete nor unwind — which is what an earlier version of this PR did.
    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/reservation deposit/i);

    // The other route is unaffected: the customer is billed the gross there, so
    // the deposit is simply absorbed by what they owe.
    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    ).resolves.toBeDefined();
  });

  test("a deposit taken AFTER the route was chosen is refused at finalization, in the same terms", async () => {
    const s = await seedDealership("dep2");

    // The route-time guard cannot see this ordering: at the moment the route was
    // chosen there was no deposit to refuse. `deposits.create` needs only
    // VIEW_SALES and the vehicle is RESERVED rather than SOLD, so nothing stops
    // one being taken afterwards.
    //
    // Without the matching guard at finalization the operator hit
    // `resolveReservationDeposits`, whose message names five treatments — and
    // this PR deleted the only UI that could supply any of them. That is exactly
    // the stranding the route-time refusal exists to prevent, reached by the
    // other door.
    await expect(
      runDeal(s, { route: "DIRECT_TO_SUPPLIER", depositAfterRoute: 3_000 })
      // Pinned to wording unique to the FINALIZATION refusal. Two looser
      // regexes both pass for the wrong reason: `/reservation deposit/i` also
      // matches the pre-existing `resolveReservationDeposits` message, so it
      // passes without the guard at all; and `/resolve the deposit/i` also
      // matches the route-time refusal, so it would pass if this test's
      // deposit were ever created before the route instead of after.
    ).rejects.toThrow(/then finalize/i);
  });

  test("a deposit deal still finalizes through the dealership, exactly as before", async () => {
    const s = await seedDealership("dep1");

    // The descope's guarantee: nothing about deposits changes on the route that
    // already handled them. The customer is billed the gross, so the عربون is
    // absorbed by what they owe and no treatment has to be stated.
    const { saleId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", deposit: 3_000, downPayment: 3_000 });
    expect(saleId).toBeTruthy();

    const deposits = await s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(deposits.some((d) => d.status === "HELD")).toBe(false);
  });
});

describe("a deal with no external financier", () => {
  test("the direct route is refused — nobody outside the dealership pays the supplier", async () => {
    const s = await seedDealership("noco1");
    const { applicationId } = await runDeal(s, { mode: "INTERNAL_INSTALLMENT", finalize: false });

    // INTERNAL_INSTALLMENT means the DEALERSHIP finances the buyer, so the
    // customer pays it over time and it owes the supplier. "The buyer's money
    // went straight to the supplier" is incoherent — and accepting it zeroed
    // the customer's vehicle receivable, erasing the record of instalments the
    // customer genuinely owes.
    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      })
    // "No outside financier" rather than "no finance company": the refusal is
    // about the quote MODE, not about whether a `companyId` happens to be set.
    ).rejects.toThrow(/no outside financier/i);
  });
});

describe("cancelling after the finance company has paid the supplier", () => {
  test("is refused, the way it is once the dealership itself has been paid", async () => {
    const s = await seedDealership("canc2");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    // The mirror of the `disbursedAt` refusal. Real money moved between the
    // company and the supplier, and the customer has the car — handover is a
    // precondition of finalization. Cancelling would restore a financed,
    // paid-for, delivered car to sellable inventory and write off a margin the
    // dealership is still owed.
    await expect(
      s.asUser.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew",
      })
    ).rejects.toThrow(/already paid/i);

    const app = await s.t.run((ctx) => ctx.db.get(applicationId as never)) as { status: string };
    expect(app.status).toBe("CLOSED");
  });
});

describe("cancelling by the other door, after the supplier was paid", () => {
  test("sales.update cannot cancel a deal the finance company has already paid the supplier for", async () => {
    const s = await seedDealership("bypass1");
    const { applicationId, saleId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    // `runDeal` only returns a null `saleId` when called with `finalize: false`.
    if (!saleId) throw new Error("runDeal was expected to finalize a sale");
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    // `cancelApplication` refuses this, but it is not the only way to cancel.
    // `sales.update` never loaded the finance application, and the supplier
    // confirmation deliberately records no receipt against the margin claim —
    // so `cancelSupplierReceivablesForSale`'s receipt guard does not fire
    // either. The sale reversed, the claim cancelled, a handed-over car went
    // back to sellable inventory, and the application stayed CLOSED still
    // carrying its payment confirmation.
    //
    // A lock with two doors and a bolt on one is not a lock.
    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId, saleId, status: "CANCELLED" as const,
      })
    ).rejects.toThrow(/already paid the supplier/i);

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as never)) as { status: string };
    expect(sale.status).toBe("COMPLETED");
  });
});

describe("the settlement advice is recorded as stated", () => {
  test("an amount that differs from the customer's financing principal is stored verbatim", async () => {
    const s = await seedDealership("adv1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", downPayment: 3_000 });

    // What the company pays the supplier is a transaction between two other
    // parties. It is NOT `totalFinancedAmount`, which is the customer's
    // principal and differs from it by the down payment — so recording the
    // dealership's own expectation in place of the advice is systematically
    // wrong on any deal with one.
    const advised = 17_450 * SCALE;
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: advised, reference: "CHQ-771",
    });

    const app = await s.t.run((ctx) => ctx.db.get(applicationId as never)) as {
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementReference?: string;
    };
    expect(app.supplierDisbursedAmountMinor).toBe(advised);
    // The reference is half the point of recording the advice; without this a
    // regression that drops it passes.
    expect(app.supplierDisbursementReference).toBe("CHQ-771");
  });

  test("a nonsensical disbursement date is refused rather than stored", async () => {
    const s = await seedDealership("adv2");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER" });

    // Convex accepts NaN as a v.number(), and every other timestamp on this
    // record comes from Date.now(). The documented purpose is backdating an
    // advice that already arrived, so a future date is not a valid one.
    await expect(
      s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
        orgId: s.orgId, applicationId,
        disbursedAmountMinor: VEHICLE_PRICE * SCALE,
        disbursedAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    ).rejects.toThrow(/future/i);
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

/**
 * `companyId` is set only on CONFIGURED_FINANCE_COMPANY quotes — `quotes.
 * saveQuote` rejects it on every other mode. Using it as the proxy for "an
 * external financier exists" therefore misread an ordinary MANUAL_FINANCE_COMPANY
 * deal, the "other finance option" a dealership types in by name, as having no
 * financier at all: the finalize guard never fired so the deal defaulted through
 * the dealership, and the route control refused the direct answer that would
 * have described it. The same field, wrong in both directions on the same deal.
 */
describe("an external financier the deal does not name with a companyId", () => {
  test("a manual finance company is asked the settlement route before finalizing", async () => {
    const s = await seedDealership("manual1");
    await expect(
      runDeal(s, { mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Cairo Amman Finance" })
    ).rejects.toThrow(/record the settlement route/i);
  });

  test("a manual finance company can settle direct to the supplier", async () => {
    const s = await seedDealership("manual2");
    const { applicationId } = await runDeal(s, {
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Cairo Amman Finance",
      route: "DIRECT_TO_SUPPLIER",
    });

    // The whole point of the route: no customer receivable for the car, no
    // finance-company receivable, and the margin sitting as a claim on the
    // supplier.
    const posted = await ledgerBySystemKey(s);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBeGreaterThan(0);

    // And the settlement advice can be recorded against the named provider,
    // which `companyId`-gating made permanently impossible for this mode.
    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    expect(result.disbursedAmountMinor).toBe(VEHICLE_PRICE * SCALE);
  });

  test("a manual finance company with no provider name cannot take the direct route", async () => {
    const s = await seedDealership("manual3");
    const { applicationId } = await runDeal(s, {
      mode: "MANUAL_FINANCE_COMPANY",
      finalize: false,
    });

    // External, but nobody a settlement advice could name. Recording that "the
    // financier paid the supplier" with no financier identity is an
    // unattributable payment, so it is refused rather than stored.
    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/not named/i);
  });
});

/**
 * A lease is externally financed in business terms, so it must not silently
 * default through the dealership — but the data model carries no lease-provider
 * identity anywhere, so it cannot record a direct payment either. Being unable
 * to store the right answer is not a reason to post the wrong one quietly: it is
 * asked the question and refused that one answer, with the reason named.
 */
describe("a lease, which is external but has no provider identity", () => {
  test("is asked the settlement route before finalizing", async () => {
    const s = await seedDealership("lease1");
    await expect(runDeal(s, { mode: "LEASE" })).rejects.toThrow(/record the settlement route/i);
  });

  test("is refused the direct route, naming the missing provider as the reason", async () => {
    const s = await seedDealership("lease2");
    const { applicationId } = await runDeal(s, { mode: "LEASE", finalize: false });

    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/leasing provider is not recorded/i);
  });

  test("finalizes normally once it is told to settle through the dealership", async () => {
    const s = await seedDealership("lease3");
    const { saleId } = await runDeal(s, { mode: "LEASE", route: "THROUGH_DEALERSHIP" });
    expect(saleId).toBeTruthy();
  });
});

/**
 * `mode` is optional on both the quote and the application, and `saveQuote`
 * explicitly allows a `companyId` with no mode at all — so a deal written before
 * the field existed carries a real configured financier and nothing to identify
 * it by mode.
 *
 * Deriving "is there an external financier?" purely from the mode therefore
 * regressed exactly the population the mode fallback was supposed to protect:
 * a legacy consigned deal stopped being asked the route question and defaulted
 * THROUGH_DEALERSHIP, while the direct route it may genuinely need was refused.
 * The snapshotted company IS the answer when the mode cannot give one.
 */
describe("a legacy deal that has a finance company but no recorded mode", () => {
  test("is still asked the settlement route before finalizing", async () => {
    const s = await seedDealership("legacy1");
    await expect(runDeal(s, { omitMode: true })).rejects.toThrow(/record the settlement route/i);
  });

  test("can still take the direct route", async () => {
    const s = await seedDealership("legacy2");
    const { applicationId } = await runDeal(s, { omitMode: true, route: "DIRECT_TO_SUPPLIER" });

    const posted = await ledgerBySystemKey(s);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBeGreaterThan(0);

    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    expect(result.disbursedAmountMinor).toBe(VEHICLE_PRICE * SCALE);
  });
});

/**
 * The screen and the server must not be able to disagree about who pays.
 *
 * `applications.get` returns `canSettleDirectToSupplier` so the dialog can
 * enable or disable the direct option, and `setSupplierSettlementRoute` decides
 * whether to accept it. Those are two reads of one rule, and a drift between
 * them produces the failure this PR keeps circling: a control the UI offers and
 * the server refuses, or one it hides on a deal the server would have accepted.
 * Nothing pinned them together until this test.
 */
describe("the screen's answer and the server's answer are the same answer", () => {
  const cases = [
    { name: "a configured finance company", opts: {}, direct: true },
    {
      name: "a named manual provider",
      opts: { mode: "MANUAL_FINANCE_COMPANY" as const, manualProviderName: "Cairo Amman Finance" },
      direct: true,
    },
    { name: "an unnamed manual provider", opts: { mode: "MANUAL_FINANCE_COMPANY" as const }, direct: false },
    { name: "a lease", opts: { mode: "LEASE" as const }, direct: false },
    { name: "an internal installment", opts: { mode: "INTERNAL_INSTALLMENT" as const }, direct: false },
    { name: "a legacy deal with no mode but a finance company", opts: { omitMode: true }, direct: true },
    // The payer is not the only thing that refuses this route. A held عربون
    // does too, because the direct route bills the customer nothing for the car
    // and the deposit has nowhere to land — so a screen that asks only "who
    // pays?" offers an option the server rejects.
    { name: "a deal holding a reservation deposit", opts: { deposit: 3_000 }, direct: false },
  ];

  for (const [index, c] of cases.entries()) {
    test(`${c.name}: get() and setSupplierSettlementRoute agree`, async () => {
      const s = await seedDealership(`agree${index}`);
      const { applicationId } = await runDeal(s, { ...c.opts, finalize: false });

      const view = await s.asUser.query(api.applications.get, { orgId: s.orgId, applicationId });
      expect(view?.canSettleDirectToSupplier).toBe(c.direct);

      const attempt = s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER",
      });
      if (c.direct) {
        await expect(attempt).resolves.toBeDefined();
      } else {
        await expect(attempt).rejects.toThrow();
      }
    });
  }
});

/**
 * The mobile applications list renders `companyName` directly and knows nothing
 * about `companyLabelKey`, so an empty string leaves a dangling separator on the
 * phone — and the mobile bundle publishes over the air on merge. The contract
 * test only checks that mobile's function references resolve; `""` is still a
 * string, so nothing else pins this.
 */
describe("the applications list always has something to show for the financier", () => {
  const shapes = [
    { name: "a configured finance company", opts: {} },
    { name: "an internal installment", opts: { mode: "INTERNAL_INSTALLMENT" as const } },
    { name: "a lease", opts: { mode: "LEASE" as const } },
    { name: "an unnamed manual provider", opts: { mode: "MANUAL_FINANCE_COMPANY" as const } },
    {
      name: "a manual provider named only with whitespace",
      opts: { mode: "MANUAL_FINANCE_COMPANY" as const, manualProviderName: "   " },
    },
    { name: "a legacy deal with no mode", opts: { omitMode: true } },
  ];

  for (const [index, shape] of shapes.entries()) {
    test(`${shape.name}: companyName is never blank`, async () => {
      const s = await seedDealership(`label${index}`);
      await runDeal(s, { ...shape.opts, finalize: false });

      const page = await s.asUser.query(api.applications.list, {
        orgId: s.orgId,
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(page.page).toHaveLength(1);
      expect(page.page[0]!.companyName.trim()).not.toBe("");
    });
  }
});

/**
 * The cockpit screen's single query.
 *
 * Its whole reason to exist is that the client must not do this arithmetic:
 * `صافي ربح المعرض` is derived from the finance company's approved purchase
 * amount, not from what the customer paid, and it is a MANAGEMENT figure with
 * no journal behind it. So these assert the SHAPE of the answer as much as the
 * numbers — a figure that can be rendered without its qualifier, or a party row
 * the client has to interpret for itself, is the defect.
 */
describe("the deal cockpit query", () => {
  test("a deal from another org is not readable, even with a valid id", async () => {
    const s = await seedDealership("cockpitTenant");
    const { applicationId } = await runDeal(s, { finalize: false });
    const other = await seedDealership("cockpitTenantOther");

    const seen = await other.asUser.query(api.applications.dealCockpit, {
      orgId: other.orgId,
      applicationId,
    });
    expect(seen).toBeNull();
  });

  test("the money panel is withheld from a role without view:finance", async () => {
    const s = await seedDealership("cockpitPerm");
    const { applicationId } = await runDeal(s, { finalize: false });

    // Withheld on the SERVER, not hidden by the component: a salesperson can
    // follow their own deal without seeing what the dealership makes on it.
    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: role.permissions.filter((p) => p !== "view:finance"),
        isSystemOwnerRole: false,
      });
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(view!.money).toBeNull();
    // ...but the deal itself still renders. A permission that blanks the whole
    // screen turns "you cannot see the profit" into "this deal is broken".
    expect(view!.stages.length).toBeGreaterThan(0);
  });

  test("THROUGH_DEALERSHIP: the dealership owes the supplier and is owed by the financier", async () => {
    const s = await seedDealership("cockpitThrough");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const by = (party: string) => view!.money!.parties.find((p) => p.party === party)!;

    expect(view!.money!.settlesDirectToSupplier).toBe(false);
    expect(by("SUPPLIER").position).toBe("DEALERSHIP_OWES");
    expect(by("FINANCIER").position).toBe("OWED_TO_DEALERSHIP");
  });

  test("DIRECT_TO_SUPPLIER inverts both rows — the same three parties, opposite directions", async () => {
    const s = await seedDealership("cockpitDirect");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const by = (party: string) => view!.money!.parties.find((p) => p.party === party)!;

    expect(view!.money!.settlesDirectToSupplier).toBe(true);
    // The supplier now owes the dealership its agency margin...
    expect(by("SUPPLIER").position).toBe("OWED_TO_DEALERSHIP");
    expect(by("SUPPLIER").amountMinor).toBe(MARGIN * SCALE);
    // ...and the financier never owed the dealership anything on this deal.
    // NOT_INVOLVED rather than a zero balance: a zero reads as a debt that was
    // settled, and there was never one to settle.
    expect(by("FINANCIER").position).toBe("NOT_INVOLVED");
  });

  test("the supplier payable is converted from major units at the currency's own scale", async () => {
    // The trap: `amountDue` is stored in MAJOR units on both supplier tables,
    // while every `*Minor` field on the application is minor. JOD is a
    // three-decimal currency, so reading one as the other is off by 1,000.
    const s = await seedDealership("cockpitScale");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    expect(supplier.amountMinor).toBe(SUPPLIER_ENTITLEMENT * SCALE);
  });

  test("the headline figure never travels without its classification", async () => {
    const s = await seedDealership("cockpitProfit");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    // Set directly rather than through `approveDealerPurchaseAmount`, which
    // needs a recorded quotation, an appraisal and an LTV basis to reach —
    // machinery this read query does not touch and which has its own suite.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    // What the finance company actually paid the supplier, off the advice.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const profit = view!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;

    // On the direct route the economics reduce to the agency margin less
    // expenses: the financier pays the supplier the gross and the supplier owes
    // the margin back, so approved − (approved − margin) = margin. Computing it
    // the long way and landing on the short answer is the cross-check.
    expect(profit.amountMinor).toBe(MARGIN * SCALE);

    // Amount and qualifier are one object, so a caller cannot render the first
    // having dropped the second.
    expect(profit).toHaveProperty("classification");
    expect(profit.postable).toBe(false);
    // And the headline is the sum of the lines the screen renders, never a
    // second computation that could disagree with them.
    expect(profit.lines.reduce((t, l) => t + l.sign * l.amountMinor, 0)).toBe(profit.amountMinor);
  });

  test("an unstarted deal reports that the profit cannot be computed, not that it is zero", async () => {
    const s = await seedDealership("cockpitNoProfit");
    const { applicationId } = await runDeal(s, { finalize: false });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const profit = view!.money!.managementProfit;
    // Zero profit and unknowable profit are different claims, and this is the
    // screen where a dealership decides whether a deal made money.
    expect(profit).toEqual({ available: false, reason: "NoApprovedPurchaseAmount" });
  });

  test("the stage rail always names exactly one place to act", async () => {
    const s = await seedDealership("cockpitStages");
    const { applicationId } = await runDeal(s, { finalize: false });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const live = view!.stages.filter((st) => st.state === "CURRENT" || st.state === "BLOCKED");
    expect(live).toHaveLength(1);
  });
});

/**
 * Regressions for the eight defects an independent review found in the first
 * cut of `applications.dealCockpit`. Every one of these failed against commit
 * 8fd99131 before the fix; a money test that never failed proves nothing.
 */
describe("the deal cockpit, under the conditions that broke it", () => {
  /** A fee row, which the fixture does not otherwise create. */
  async function addFee(
    s: Seeded,
    applicationId: string,
    opts: { actualMinor: number; paidBy: "DEALER" | "CUSTOMER" | "FINANCE_COMPANY"; reconciled?: boolean }
  ) {
    await s.t.run(async (ctx) => {
      await ctx.db.insert("financeDealFees", {
        orgId: s.orgId as never,
        applicationId: applicationId as never,
        feeType: "LICENSING",
        currency: "JOD",
        actualAmountMinor: opts.actualMinor,
        paidBy: opts.paidBy,
        paidTo: "GOVERNMENT",
        accountingTreatment: opts.paidBy === "DEALER" ? "SELLING_EXPENSE" : "CUSTOMER_RECEIVABLE",
        includedInQuotation: false,
        deductedFromSettlement: false,
        refundable: false,
        source: "MANUAL",
        ...(opts.reconciled ? { reconciledAt: Date.now() } : {}),
        createdBy: s.userId as never,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function cockpitOf(s: Seeded, applicationId: string) {
    return await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
  }

  /**
   * C-1. The headline subtracted what the supplier STILL owes rather than what
   * he settles at, so every dinar he repaid reduced reported profit one-for-one
   * and a fully-collected deal reported a loss equal to its expenses.
   */
  test("collecting from the supplier does not change the deal's profit", async () => {
    const s = await seedDealership("regC1");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE });
    });
    // The headline now derives from the RECORDED advice rather than from the
    // approved amount, so the advice has to exist for there to be a figure.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const before = await cockpitOf(s, applicationId);
    const profitBefore = before!.money!.managementProfit;
    expect(profitBefore.available).toBe(true);

    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN / 2,
    });

    const after = await cockpitOf(s, applicationId);
    const profitAfter = after!.money!.managementProfit;
    // Collecting a receivable converts a claim into cash. It does not make the
    // deal less profitable.
    expect(profitAfter.available && profitAfter.amountMinor).toBe(
      profitBefore.available && profitBefore.amountMinor
    );
  });

  /**
   * H-2. `paidBy` was ignored, so a fee the CUSTOMER paid was subtracted from
   * the dealership's own profit.
   */
  test("only expenses the dealership actually bore reduce its profit", async () => {
    const s = await seedDealership("regH2");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE });
    });
    // The headline now derives from the RECORDED advice rather than from the
    // approved amount, so the advice has to exist for there to be a figure.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    await addFee(s, applicationId, { actualMinor: 200 * SCALE, paidBy: "DEALER" });
    await addFee(s, applicationId, { actualMinor: 500 * SCALE, paidBy: "CUSTOMER" });

    const view = await cockpitOf(s, applicationId);
    const profit = view!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    // Reduced by the dealership's 200, never by the customer's 500.
    expect(profit.amountMinor).toBe(MARGIN * SCALE - 200 * SCALE);
  });

  /**
   * H-3. When the sale behind a deal could not be loaded the query reported the
   * route as unknown — and then rendered a complete THROUGH_DEALERSHIP layout
   * anyway, showing "nobody owes anybody anything" on a deal with a live open
   * claim against the supplier.
   */
  test("a deal whose sale cannot be loaded claims nothing about who holds the money", async () => {
    const s = await seedDealership("regH3");
    const { applicationId, saleId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: true,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.delete(saleId as never);
    });

    const view = await cockpitOf(s, applicationId);
    expect(view!.money!.routeKnown).toBe(false);
    // Not "nothing outstanding" — the supplier claim is still open.
    for (const party of view!.money!.parties) {
      expect(party.position).toBe("UNKNOWN");
    }
  });

  /**
   * H-4. The route was re-derived partly from the LIVE vehicle after the sale
   * existed, so converting the vehicle to dealer stock — a supported workflow
   * after a cancellation — silently flipped a settled DIRECT deal into a
   * THROUGH_DEALERSHIP rendering, while still reporting the route as known.
   */
  test("editing the vehicle afterwards cannot flip how a settled deal reads", async () => {
    const s = await seedDealership("regH4");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceType: "STOCK" });
    });

    const view = await cockpitOf(s, applicationId);
    // The sale is the authority once it exists. A later edit to the vehicle is
    // not allowed to rewrite what a posted deal did.
    expect(view!.money!.settlesDirectToSupplier).toBe(true);
  });

  /**
   * H-6. `deposits.amountMinor` is optional and every other reader in the
   * codebase falls back to converting `amount`. This one fell back to zero, so
   * a deal with a real customer deposit reported the customer as not involved.
   */
  test("a deposit predating amountMinor is still counted as money held", async () => {
    const s = await seedDealership("regH6");
    const { applicationId } = await runDeal(s, { deposit: 1_000, finalize: false });

    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!;
      // The legacy shape: major units only.
      await ctx.db.patch(deposit._id, { amountMinor: undefined });
    });

    const view = await cockpitOf(s, applicationId);
    const customer = view!.money!.parties.find((p) => p.party === "CUSTOMER")!;
    expect(customer.position).toBe("DEALERSHIP_HOLDS");
    expect(customer.amountMinor).toBe(1_000 * SCALE);
  });

  /**
   * M-1. The supplier payable showed its ORIGINAL amount regardless of what had
   * been paid against it, so a part-paid payable overstated the debt and a
   * settled one still displayed a full balance.
   */
  test("a part-paid supplier payable shows what is left, not what it started at", async () => {
    const s = await seedDealership("regM1");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });

    await s.t.run(async (ctx) => {
      const payable = (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === s.orgId
      )!;
      await ctx.db.patch(payable._id, {
        amountPaid: 5_000,
        status: "PARTIALLY_PAID",
      });
    });

    const view = await cockpitOf(s, applicationId);
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    expect(supplier.amountMinor).toBe((SUPPLIER_ENTITLEMENT - 5_000) * SCALE);
  });

  /**
   * M-4. "Actual" was claimed on figures somebody typed but nobody checked.
   * `deriveFeeStatus` already draws that line: recorded and reconciled are
   * different claims, and only the second may close a deal.
   */
  test("an unreconciled expense keeps the figure estimated", async () => {
    const s = await seedDealership("regM4");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        settlementStatus: "FULLY_SETTLED",
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    await addFee(s, applicationId, { actualMinor: 200 * SCALE, paidBy: "DEALER", reconciled: false });

    const view = await cockpitOf(s, applicationId);
    const profit = view!.money!.managementProfit;
    expect(profit.available && profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });
});

/**
 * H-5. A DIRECT deal can never reach `FULLY_SETTLED` through the status field:
 * the only writer of it is `confirmDisbursement`, which refuses the direct route
 * outright, and `confirmSupplierDisbursement` deliberately writes `EXPECTED`. So
 * the terminal stage stayed permanently BLOCKED and the qualifier permanently
 * "estimated" on deals that were completely finished — a rail an operator could
 * never clear, on the screen they use to decide what to do next.
 */
describe("a direct-settled deal that is genuinely finished", () => {
  test("reaches its final stage and stops calling the figure an estimate", async () => {
    const s = await seedDealership("regH5");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });

    // The financier's advice, then the supplier repaying the margin in full.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    const settlement = view!.stages.find((st) => st.key === "SETTLEMENT")!;
    expect(settlement.state).toBe("COMPLETE");

    const profit = view!.money!.managementProfit;
    // Still not postable — settling a deal does not turn a management figure
    // into an accounting one — but no longer described as awaiting a settlement
    // that already happened.
    expect(profit.available && profit.classification).toBe("ACTUAL_UNPOSTABLE");
    expect(profit.available && profit.postable).toBe(false);
    // And collecting in full has not moved the profit.
    expect(profit.available && profit.amountMinor).toBe(MARGIN * SCALE);
  });
});

/**
 * When is a financed consigned deal actually FINISHED?
 *
 * The first cut answered this with one boolean that grew a condition per bug.
 * Three defects came straight out of that: a partial advice counted as full
 * payment, a through-route deal counted as settled while the supplier was still
 * owed, and a zero-margin deal could never finish because the proof it demanded
 * was a receivable that correctly does not exist.
 *
 * The answer is per-route EVIDENCE, and each obligation is proven closed,
 * proven absent, or unknown. Unknown is never completion.
 */
describe("proving a deal is settled, rather than assuming it", () => {
  async function cockpitOf(s: Seeded, applicationId: string) {
    return await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
  }
  const stageOf = (view: Awaited<ReturnType<typeof cockpitOf>>, key: string) =>
    view!.stages.find((st) => st.key === key)!.state;

  /**
   * CX-1. The financier pays the supplier the approved purchase amount. An
   * advice for less than that is a PART payment, and the money is not finished.
   * The old predicate accepted any positive advice, so a 10,000 advice against a
   * 20,000 approval reported the deal complete and its profit "actual".
   */
  test("a partial supplier disbursement is not a settled deal", async () => {
    const s = await seedDealership("redesignPartial");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    // Half of what the financier owes the supplier.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: (VEHICLE_PRICE / 2) * SCALE,
    });
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
    // And the headline must not present itself as a finished figure.
    const profit = view!.money!.managementProfit;
    expect(profit.available && profit.classification).not.toBe("ACTUAL_UNPOSTABLE");
  });

  /**
   * CX-1b. An advice BELOW the margin produced a negative supplier settlement
   * and therefore a profit larger than the entire approved purchase amount.
   */
  test("an advice smaller than the margin never yields a profit above the approval", async () => {
    const s = await seedDealership("redesignNegative");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: Math.floor((MARGIN / 2) * SCALE),
    });

    const view = await cockpitOf(s, applicationId);
    const profit = view!.money!.managementProfit;
    if (profit.available) {
      expect(profit.amountMinor).toBeLessThanOrEqual(VEHICLE_PRICE * SCALE);
    }
  });

  /**
   * CX-2. `settlementStatus` says the financier paid the dealership. It says
   * nothing about whether the dealership then paid the supplier, and on a
   * consigned deal that is a separate obligation to a separate party.
   */
  test("a through-route deal is not settled while the supplier payable is open", async () => {
    const s = await seedDealership("redesignThrough");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });
    await s.t.run(async (ctx) => {
      // The financier's side is done...
      await ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" });
      // ...and the supplier is still owed every dinar.
      const payable = (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === s.orgId
      )!;
      await ctx.db.patch(payable._id, { status: "DUE_ON_SALE", amountPaid: 0 });
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
  });

  /**
   * CX-8. Sale completion deliberately opens NO supplier receivable when the
   * margin is zero. Demanding a PAID claim as proof therefore demanded a record
   * whose absence is the correct state, and the deal could never finish.
   */
  test("a zero-margin direct deal can finish, because there is nothing to collect", async () => {
    const s = await seedDealership("redesignZeroMargin");
    // The dealership earns nothing on this one: it sells at the supplier's cost.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const claims = (await supplierClaimsOf(s)).filter((row) => row.status !== "CANCELLED");
    expect(claims).toHaveLength(0); // the premise: no claim is correct here

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
  });

  /**
   * The full direct-route path still completes, so the redesign has not simply
   * made completion unreachable — which would satisfy every test above.
   */
  test("a fully paid direct deal still completes", async () => {
    const s = await seedDealership("redesignFullDirect");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
    const profit = view!.money!.managementProfit;
    expect(profit.available && profit.classification).toBe("ACTUAL_UNPOSTABLE");
  });
});

/**
 * The money-entry guards on `supplierReceivables.recordReceipt`.
 *
 * It had no caller until the cockpit gave it one, so its inputs had never been
 * reachable from a browser. Everything a client can now send has to be checked
 * on the side that posts the journal.
 */
describe("what the supplier-receipt mutation accepts", () => {
  async function directClaim(tag: string) {
    const s = await seedDealership(tag);
    await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    return { s, claim };
  }

  /** CX-5. A future receipt date marks a claim paid against a journal dated ahead of now. */
  test("a receipt dated in the future is refused", async () => {
    const { s, claim } = await directClaim("guardFuture");
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: 1_000,
        receivedAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    ).rejects.toThrow();
  });

  test("a receipt date that is not a real instant is refused", async () => {
    const { s, claim } = await directClaim("guardNaN");
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: 1_000,
        receivedAt: Number.NaN,
      })
    ).rejects.toThrow();
  });

  /**
   * CX-4. JOD carries three decimals. A half-fils receipt cannot be represented
   * in the ledger, so the subledger would record it while the journal rounded —
   * two receipts of 0.0005 marking a 0.001 claim PAID while posting two fils
   * against a one-fils receivable.
   */
  test("an amount finer than the currency can represent is refused", async () => {
    const { s, claim } = await directClaim("guardFraction");
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: 0.0005,
      })
    ).rejects.toThrow();
  });

  /**
   * The idempotency fingerprint must cover every input that changes the stored
   * record. The cockpit deliberately REUSES its key when a response is lost, so
   * an operator who corrects the date and retries would otherwise get the old
   * receipt replayed back as success while the ledger kept the original date.
   */
  test("replaying a key with a corrected date is refused, not silently replayed", async () => {
    const { s, claim } = await directClaim("guardFingerprint");
    const key = "receipt-key-1";
    const dayOne = Date.UTC(2026, 7, 1);
    const dayTwo = Date.UTC(2026, 7, 2);

    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: 1_000,
      receivedAt: dayOne,
      idempotencyKey: key,
    });

    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: 1_000,
        receivedAt: dayTwo,
        idempotencyKey: key,
      })
    ).rejects.toThrow();
  });

  test("a genuine replay of the identical receipt is still idempotent", async () => {
    // The point is to reject CHANGED content, not to break retry safety.
    const { s, claim } = await directClaim("guardReplay");
    const key = "receipt-key-2";
    const at = Date.UTC(2026, 7, 1);
    const once = {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: 1_000,
      receivedAt: at,
      idempotencyKey: key,
    };
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, once);
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, once);

    const after = (await supplierClaimsOf(s)).find((row) => row._id === claim._id)!;
    expect(after.amountReceived).toBe(1_000);
  });
});

/**
 * CX-7. `sales.update` can cancel a completed sale, which cancels the supplier
 * claim, but the finance application keeps its own status. The cockpit read the
 * sale only for the route and ignored its status, so a cancelled deal still
 * rendered as live work with a next step and a blocked settlement stage.
 */
describe("a deal whose sale was cancelled from the sales side", () => {
  test("is shown as stopped, not as work still to do", async () => {
    const s = await seedDealership("cancelViaSale");
    const { applicationId, saleId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: true,
    });

    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId as never, { status: "CANCELLED" });
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    // Every unfinished stage belongs to a deal that is over.
    const live = view!.stages.filter((st) => st.state === "CURRENT" || st.state === "BLOCKED");
    expect(live).toHaveLength(0);
    expect(view!.stages.find((st) => st.key === "SETTLEMENT")!.state).toBe("STOPPED");
  });
});

/**
 * One response must not contradict itself.
 *
 * The obligation model is the authority on whether a party still owes anything.
 * The `أطراف الصفقة` rows were re-deriving that from the claim independently, so
 * a zero-margin direct deal reported supplier obligation NONE and a COMPLETE
 * settlement stage while the supplier ROW in the same payload said UNKNOWN —
 * the screen simultaneously saying the deal is finished and that it cannot tell.
 */
describe("the party rows and the stage rail agree", () => {
  test("a zero-margin direct deal shows nothing outstanding, not an unknown", async () => {
    const s = await seedDealership("rowAgreesZeroMargin");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view!.stages.find((st) => st.key === "SETTLEMENT")!.state).toBe("COMPLETE");
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    // There is genuinely nothing to collect, and the row must say so rather
    // than claiming it cannot tell.
    expect(supplier.position).toBe("NOT_INVOLVED");
    expect(supplier.amountMinor).toBe(0);
  });

  test("an open margin claim still reads as owed to the dealership", async () => {
    // The guard against satisfying the test above by collapsing every row.
    const s = await seedDealership("rowAgreesOpenClaim");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    expect(supplier.position).toBe("OWED_TO_DEALERSHIP");
    expect(supplier.amountMinor).toBe(MARGIN * SCALE);
  });
});
