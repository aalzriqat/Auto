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
import * as applicationsModule from "./applications";
import * as financingEconomicsModule from "./financingEconomics";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
// The notification a recipient actually reads, rendered by the same function
// every channel uses — asserting the stored row alone would not catch a
// template whose placeholders are never filled.
import { renderNotification } from "../lib/notifications/render";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    // The reports read through `check`, which is a different method from
    // `limit` — it inspects the bucket without consuming from it. Stubbing only
    // `limit` left every report query throwing "not a function".
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
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
  // The sales reports read the same deals this file completes, and SCRUM-30
  // requires them to agree with the ledger about what one earned.
  "view:reports",
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
    /**
     * What the finance company approved, in major units. Direct route only —
     * it is the amount that reaches the supplier. Defaults to the vehicle
     * price, which is the shape every pre-existing expectation assumes.
     */
    approvedAmount?: number;
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
    /** Runs after the route is chosen and before the vehicle goes out. */
    beforeHandover?: (applicationId: Id<"financeApplications">) => Promise<void>;
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

  // Anything that must be on the record BEFORE the vehicle goes out.
  //
  // Handover seals the approved amount: `approveDealerPurchaseAmount` now
  // refuses to change a recorded one afterwards, as `reopenApproval` and
  // `recordAppraisal` already did. A case that needs a CORRECTION on the record
  // — an override history, say — has to make it while the door is still open,
  // which is also the only order an operator could achieve.
  await opts.beforeHandover?.(applicationId);

  // The stamp of the economics as they stand at this moment, taken from the
  // deal payload the way a real screen gets it. Read rather than assumed:
  // `beforeHandover` may have recorded an approval, and most callers here have
  // not, so the stamp differs between cases.
  await registerHandover(s.asUser, api, s.orgId, applicationId);
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });

  // On the direct route the finance company's APPROVED amount is what reaches
  // the supplier, so the dealership's claim on him is measured from it and
  // `finalizeDeal` refuses without one.
  //
  // Approved AT the vehicle price, which is what every expectation in this file
  // was written against: with `approved === salePrice` the claim is
  // `salePrice − entitlement`, exactly as before, so this records a fact that
  // was previously implicit rather than changing any deal's economics. The case
  // where they DIFFER is the one that matters, and it is exercised through the
  // real writers — `recordSubmittedQuotation` then `approveDealerPurchaseAmount`
  // — rather than from here, because that is the path a real deal takes.
  //
  // Only `approvedDealerPurchaseAmountMinor` is written. The funding split is
  // deliberately left alone: `assertDealerEconomicsRecorded` requires it only
  // once a quotation is recorded, and tests that care about the contribution set
  // it themselves — including the one that proves an UNRECORDED contribution
  // withholds the headline instead of assuming zero.
  // AFTER the `finalize: false` return, deliberately. A caller that stops short
  // of finalizing is one that intends to drive the economics itself through the
  // real writers, and `recordSubmittedQuotation` refuses to run once an approval
  // exists — so seeding one here would make that path unreachable.
  if (opts.finalize === false) return { quoteId, applicationId, saleId: null };

  if (opts.route === "DIRECT_TO_SUPPLIER") {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: (opts.approvedAmount ?? VEHICLE_PRICE) * SCALE,
      });
    });
  }

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
    // Approved at the figure the company actually pays him, which is neither the
    // vehicle price nor the customer's principal.
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      downPayment: 3_000,
      approvedAmount: 17_450,
    });

    // What the company pays the supplier is a transaction between two other
    // parties. It is NOT `totalFinancedAmount`, which is the customer's
    // principal and differs from it by the down payment — so recording the
    // dealership's own expectation in place of the advice is systematically
    // wrong on any deal with one. Here the principal is 17,000 and the advice
    // is 17,450; the advice tracks the APPROVAL, not the principal.
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
      dealerContributionMinor: 0,
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

  /**
   * The scenario every other management-profit test forecloses.
   *
   * They all set approved amount = supplier advice = VEHICLE_PRICE, so A = D = S
   * and the two formulas are forced to agree no matter what they mean. On the
   * DIRECT route the cockpit derives the supplier's settlement as `D − margin`,
   * where `margin` is frozen at sale time as `salePrice − sourceCost`. That
   * identity only collapses to the supplier's real entitlement when the advice
   * equals the sale price; otherwise the two differ by exactly `S − D`.
   *
   * Reachable through the real workflow, not a patched row: the finance company
   * can approve LESS than the quotation (`basis: "MANUAL"` takes any amount),
   * while `finalizeDeal` still records the sale at `quote.vehiclePrice`. Nothing
   * ties them together.
   *
   * Economics of the case below: the supplier is owed 15,000. The financier
   * approves — and therefore pays him — 18,000. He is holding 3,000 of the
   * dealership's money and owes exactly that back.
   *
   * The sale is recorded at 20,000, so the dealership's TOTAL margin is 5,000.
   * The other 2,000 never passes through the supplier's hands: it is
   * `salePrice − approved`, which the customer either pays the dealership
   * directly or nobody pays at all, and which SCRUM-23 rules a management figure
   * on no invoice. A claim of 5,000 bills the supplier for it anyway.
   *
   * The dealership does NOT net 3,000 here, and an earlier draft of this test
   * asserted that it did. At the 90% LTV this test itself configures, the
   * finance company funds only 16,200 of the 18,000 it approved, and with no
   * customer down payment the dealership puts in the remaining 1,800 — so it
   * holds a 3,000 claim against 1,800 of its own money and nets 1,200. Every
   * line is asserted below rather than just the total, because a headline that
   * happens to land on the right number through two offsetting errors is exactly
   * what this screen keeps producing.
   */
  test("the direct-route headline agrees with the canonical dealer economics when the advice is not the sale price", async () => {
    const APPROVED = 18_000;
    const s = await seedDealership("cockpitApprovalBelowSale");
    // The quotation solver refuses a company with no LTV, and this suite's
    // fixture has none because no other test quotes through the real writer.
    // Before the deal, so the application freezes a snapshot that carries it.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 90 });
    });

    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });

    // Through the real writers, so the approval carries whatever the engine
    // derives alongside it (notably the dealer contribution).
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: APPROVED * SCALE,
      basis: "MANUAL",
      notes: "Approved below the quotation.",
    });

    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: APPROVED * SCALE,
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const profit = view!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;

    // The debt the system OPENED against the supplier. He received 18,000 and
    // was entitled to 15,000, so he owes 3,000 back — not the 5,000 sale-price
    // margin. A receivable larger than the excess that actually reached him is
    // a debt the dealership would age, display and offer to collect.
    const claimDue = await s.t.run(async (ctx) => {
      const rows = await ctx.db.query("vehicleSupplierReceivables").collect();
      return rows.find((r) => r.orgId === s.orgId)?.amountDue;
    });
    expect(claimDue).toBe(APPROVED - SUPPLIER_ENTITLEMENT);

    // THE INVARIANT, stated directly: the claim may never exceed the dealership
    // money the supplier is actually holding. He received the approved amount
    // and keeps his entitlement; everything else about the deal is irrelevant to
    // what he owes.
    expect(claimDue! * SCALE).toBe(APPROVED * SCALE - SUPPLIER_ENTITLEMENT * SCALE);
    // And specifically NOT the total dealer margin, which is 2,000 larger.
    expect(claimDue).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);

    // What the supplier actually keeps is his entitlement, never `advice − margin`.
    const line = (key: string) => profit.lines.find((l) => l.key === key)?.amountMinor;
    expect(line("SUPPLIER_SETTLEMENT")).toBe(SUPPLIER_ENTITLEMENT * SCALE);
    expect(line("APPROVED_PURCHASE")).toBe(APPROVED * SCALE);
    expect(line("CUSTOMER_DIRECT_TO_DEALER")).toBe(0);
    expect(line("ACTUAL_EXPENSES")).toBe(0);
    // 90% of the 18,000 approval is 16,200; the dealership funds the rest.
    expect(line("DEALER_CONTRIBUTION")).toBe(1_800 * SCALE);

    // The canonical dealer economics: what the supplier holds for it, less what
    // it put in itself.
    expect(profit.amountMinor).toBe(
      (APPROVED - SUPPLIER_ENTITLEMENT) * SCALE - 1_800 * SCALE
    );
    // The headline is the sum of the lines the screen renders, not a second
    // formula that happens to agree today.
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
      await ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE, dealerContributionMinor: 0 });
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
      await ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE, dealerContributionMinor: 0 });
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
  /**
   * SCRUM-30 widened when this headline appears, and that is a deliberate
   * ruling rather than a side effect.
   *
   * It used to require `financierObligation === "CLOSED"` and a recorded
   * disbursement, because the figure was derived from the advice. It no longer
   * is: the margin is `approved − entitlement`, both of which are known the
   * moment the deal is finalized, so withholding it until somebody else's
   * payment is confirmed would be withholding a number the dealership already
   * knows.
   *
   * What must NOT widen with it is the confidence. An unconfirmed deal shows
   * the figure and says it is an estimate, because nobody has yet proven the
   * money moved. Publishing it as actual on the strength of an accrual is the
   * failure this pins against.
   */
  test("a direct deal with no advice yet shows the margin, and says it is only an estimate", async () => {
    const s = await seedDealership("regAccrual");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    // Recorded, so the OTHER reason the headline can be withheld is out of the
    // way and this test is about the advice and nothing else. An unrecorded
    // contribution withholds it too, and deliberately — that is pinned
    // separately.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { dealerContributionMinor: 0 });
    });

    // Nothing confirmed: the finance company has not been recorded as having
    // paid anyone.
    const app = (await s.t.run((ctx) => ctx.db.get(applicationId))) as {
      supplierDisbursementConfirmedAt?: number;
    };
    expect(app.supplierDisbursementConfirmedAt).toBeUndefined();

    const view = await cockpitOf(s, applicationId);
    const profit = view!.money!.managementProfit;
    // Available — the two figures it is made of are both frozen on the deal.
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    // And explicitly an estimate. This is the assertion that stops a later
    // change quietly promoting an accrued figure to a settled one.
    expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("an unreconciled expense keeps the figure estimated", async () => {
    const s = await seedDealership("regM4");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        dealerContributionMinor: 0,
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
      dealerContributionMinor: 0,
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
  /**
   * SUPERSEDED BY SCRUM-30, and strengthened rather than relaxed.
   *
   * This used to record a half-sized advice and then prove the deal did not read
   * as settled. Under the dealership's ruling the finance company pays the
   * supplier in exactly ONE payment for the approved amount, so a partial advice
   * is not a thing that can happen — and storing one meant holding two
   * contradictory records of the same fact and reading the contradiction back as
   * evidence.
   *
   * The guarantee therefore moved twice, and this test follows it.
   *
   * Refusing the advice was the first answer and was withdrawn: it rolled back
   * the evidence of the very payment it objected to, and left a funded sale
   * cancellable. The advice is now recorded and marked
   * REQUIRES_RECONCILIATION — so this test's original point has to be made
   * against a STORED contradiction, which is the harder version of it. A
   * half-sized advice must not carry the deal to a settled state on the
   * strength of a figure the dealership does not believe.
   */
  test("a partial supplier disbursement does not settle the deal, even though it is recorded", async () => {
    const s = await seedDealership("redesignPartial");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    // Half of what the financier owes the supplier.
    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: (VEHICLE_PRICE / 2) * SCALE,
    });
    expect(result.status).toBe("REQUIRES_RECONCILIATION");

    // Stored, because it is evidence about a payment somebody made.
    const app = (await s.t.run((ctx) => ctx.db.get(applicationId as never))) as {
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementStatus?: string;
    };
    expect(app.supplierDisbursedAmountMinor).toBe((VEHICLE_PRICE / 2) * SCALE);
    expect(app.supplierDisbursementStatus).toBe("REQUIRES_RECONCILIATION");

    // And the deal is still not settled, which was this test's original point
    // and is the assertion that must survive every change to how the mismatch
    // is handled.
    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
  });

  /**
   * CX-1b, also superseded by SCRUM-30 and also strengthened.
   *
   * An advice BELOW the margin used to produce a negative supplier settlement
   * and therefore a profit larger than the entire approved purchase amount. The
   * redesign removes the arithmetic that could do that — the settlement line is
   * the supplier's recorded entitlement and never `advice − margin`.
   *
   * That removal is what this test now pins, and it is the stronger claim: the
   * advice IS recorded, flagged as contradicting the approval, and the headline
   * is unmoved by it. Under the old arithmetic this exact advice produced a
   * profit larger than the whole deal; the figure now cannot depend on it at all.
   */
  test("an advice smaller than the margin cannot move the headline, and is flagged", async () => {
    const s = await seedDealership("redesignNegative");
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { dealerContributionMinor: 0 });
    });

    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: Math.floor((MARGIN / 2) * SCALE),
    });
    expect(result.status).toBe("REQUIRES_RECONCILIATION");

    const view = await cockpitOf(s, applicationId);
    const profit = view!.money!.managementProfit;
    // The headline no longer depends on the advice at all, so it is available
    // from sale-time facts — and it is the margin, nowhere near the approval.
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    expect(profit.amountMinor).toBe(MARGIN * SCALE);
    expect(profit.amountMinor).toBeLessThan(VEHICLE_PRICE * SCALE);
    // Still an estimate: nobody has proven the money moved.
    expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
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
      dealerContributionMinor: 0,
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
      dealerContributionMinor: 0,
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
      dealerContributionMinor: 0,
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

/**
 * The settlement derivation after the PATCH HALT.
 *
 * Round 2 and round 3 each fixed a defect and introduced another, all in this
 * one subsystem, which is what the circuit breaker exists to detect. The common
 * cause was not any single patch: the derivation inferred money facts from live
 * mutable state, compared money as major-unit floats, and treated missing
 * evidence as zero. These cover the redesign, not the patches.
 */
describe("settlement derived from sale-time facts, in integer minor units", () => {
  async function cockpitOf(s: Seeded, applicationId: string) {
    return await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
  }
  const stageOf = (view: Awaited<ReturnType<typeof cockpitOf>>, key: string) =>
    view!.stages.find((st) => st.key === key)!.state;
  const supplierRow = (view: Awaited<ReturnType<typeof cockpitOf>>) =>
    view!.money!.parties.find((p) => p.party === "SUPPLIER")!;

  /** A finished DIRECT deal whose supplier claim is left open for the caller. */
  async function directDeal(tag: string) {
    const s = await seedDealership(tag);
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
      dealerContributionMinor: 0,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    return { s, applicationId };
  }

  /**
   * OP-H1. Money was compared by subtracting major-unit floats, and JOD carries
   * three decimals. A 4.440 claim collected in three receipts of 1.480 lands on
   * 4.4399999999999995 — so `amountDue - amountReceived` is 8.9e-16, which is
   * greater than zero.
   *
   * That stranded the claim twice over. `recordReceipt` never set PAID, because
   * it tested `projected === amountDue` exactly; and it refused every further
   * receipt, because any positive amount exceeds a residue smaller than a
   * thousandth of a fils. The supplier had paid in full, the deal could never
   * reach COMPLETE, and no amount existed that could close it.
   */
  test("a claim paid in instalments that do not sum exactly is still fully settled", async () => {
    const { s, applicationId } = await directDeal("residueClaim");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(claim._id, { amountDue: 4.44, amountReceived: undefined, status: "OPEN" });
    });

    for (let i = 0; i < 3; i++) {
      await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: 1.48,
      });
    }

    const settled = (await supplierClaimsOf(s)).find((row) => row._id === claim._id)!;
    // The residue is real; the point is that it must not be treated as a debt.
    expect(settled.amountReceived).not.toBe(4.44);
    expect(settled.status).toBe("PAID");

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
    // And the row must stop inviting a receipt from a supplier who owes nothing.
    expect(supplierRow(view).position).toBe("SETTLED");
  });

  /**
   * OP-H2. `marginBack = supplierClaimOriginalMinor ?? 0` — so a claim the
   * screen could not read became "the supplier owes nothing back", and the
   * headline published the ENTIRE disbursement as the dealership's profit.
   *
   * A claim denominated in another currency is the reachable case: it is
   * present and valid, and only unreadable here.
   */
  test("a claim in another currency withholds the headline instead of inventing one", async () => {
    const { s, applicationId } = await directDeal("foreignClaim");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(claim._id, { currency: "USD" });
    });

    const profit = (await cockpitOf(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(false);
    // Pinned to the REASON, not merely to unavailability. Without this the test
    // would still pass if the figure were withheld for an unrelated cause —
    // and the `if (profit.available)` guard it used to carry asserted nothing
    // at all, which is the same shape as the two vacuous tests fixed above.
    if (!profit.available) expect(profit.reason).toBe("NoSupplierSettlement");
  });

  /**
   * CX-9. The margin was re-derived as `salePrice − computeVehicleCapitalizedCost`,
   * and that helper reads the vehicle's CURRENT `sourceCost`. So a deal with no
   * live claim was judged against a figure any later edit could move: correcting
   * the supplier's price up to the sale price made the margin look like zero,
   * which the derivation read as "nothing was ever owed" and used to report the
   * deal COMPLETE — with an uncollected margin and a cancelled claim on file.
   *
   * The sale-time margin says 5,000 and keeps saying it. Nothing here is a
   * judgement about whether the correction was right; it is that a settled deal
   * must not be re-decided by a field the settlement no longer depends on.
   *
   * (Codex also reported a NEGATIVE margin reaching this branch. It cannot:
   * `completeSale` refuses a consigned sale priced below the supplier's
   * entitlement outright — see saleCompletion.ts:866 — so that half is rejected.)
   */
  test("a later correction to the vehicle cost cannot close an uncollected deal", async () => {
    const { s, applicationId } = await directDeal("costEditedNoClaim");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      // The claim is voided, so no live claim speaks for the margin...
      await ctx.db.patch(claim._id, { status: "CANCELLED" });
      // ...and the cost is corrected up to the sale price, which is what made
      // the old derivation compute a zero margin.
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE });
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });

  /**
   * CX-9, second half. The margin used to be re-derived through
   * `computeVehicleCapitalizedCost`, which reads the vehicle's CURRENT
   * `sourceCost`. Correcting a supplier's price after the sale therefore
   * reopened a settled deal — the screen changed its mind about history because
   * an editable field moved.
   */
  test("editing the vehicle cost after the sale does not disturb a settled deal", async () => {
    const { s, applicationId } = await directDeal("costEditedAfter");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });
    const before = await cockpitOf(s, applicationId);
    expect(stageOf(before, "SETTLEMENT")).toBe("COMPLETE");

    // Somebody corrects what the supplier actually charged, months later.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE - 1 });
    });

    const after = await cockpitOf(s, applicationId);
    expect(stageOf(after, "SETTLEMENT")).toBe("COMPLETE");
    expect(after!.money!.managementProfit).toEqual(before!.money!.managementProfit);
  });

  /**
   * CX-10. On a consigned THROUGH_DEALERSHIP deal the dealership collects the
   * gross and owes the supplier his share, so the payable is the record of a
   * debt that certainly exists. Its absence is a missing record, not a settled
   * one — and answering NONE marked the deal complete while the supplier was
   * still unpaid.
   */
  test("a consigned through-route deal with no payable on record is not complete", async () => {
    const s = await seedDealership("payableMissing");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" });
      const payable = (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === s.orgId
      )!;
      await ctx.db.delete(payable._id);
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });

  /**
   * H-7, ruled by the dealership on 2026-08-10. `صافي ربح المعرض` nets the
   * dealership's own contribution to the purchase amount. Calling the
   * pre-contribution number "net profit" while the dealership still has to put
   * money in overstated a real deal by roughly 875 JOD at 85% LTV.
   */
  test("the headline nets the dealership contribution, and shows it as its own line", async () => {
    const { s, applicationId } = await directDeal("h7Contribution");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });
    const contribution = 875 * SCALE;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { dealerContributionMinor: contribution });
    });

    const profit = (await cockpitOf(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;

    const line = profit.lines.find((l) => l.key === "DEALER_CONTRIBUTION")!;
    expect(line).toBeDefined();
    expect(line.sign).toBe(-1);
    expect(line.amountMinor).toBe(contribution);
    // The headline is the lines, so the two cannot disagree.
    expect(profit.amountMinor).toBe(
      profit.lines.reduce((total, l) => total + l.sign * l.amountMinor, 0)
    );
  });

  /**
   * The other half of H-7: defaulting an unrecorded contribution to zero would
   * republish the pre-contribution figure under the post-contribution name,
   * which is the exact error the ruling corrects.
   */
  test("an unrecorded contribution withholds the headline rather than assuming zero", async () => {
    const { s, applicationId } = await directDeal("h7Missing");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: MARGIN,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { dealerContributionMinor: undefined });
    });

    const profit = (await cockpitOf(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(false);
    if (!profit.available) expect(profit.reason).toBe("NoDealerContribution");
  });

  /**
   * OP-F1. Cancelling a sale SOFT-deletes its `VEHICLE_SALE` transaction
   * (`utils/saleCancellation.ts` patches `isDeleted: true`) rather than removing
   * it. The margin fallback counted those rows, so a vehicle that had been sold,
   * cancelled and re-sold looked permanently ambiguous.
   *
   * The victim is the case the obligations redesign existed to rescue: a genuine
   * zero-margin direct resale opens no supplier claim, so the fallback is the
   * only evidence there is — and it answered UNKNOWN forever. Settlement could
   * never complete, and no operator action could produce the missing proof,
   * because there is nothing to collect. A dead end reintroduced by a different
   * door.
   */
  test("a vehicle re-sold after a cancellation is judged on the live sale only", async () => {
    // ⚠️ RED UNTIL PHASE 3, BY OWNER RULING c15589 — not a regression.
    //
    // This fixture starts a SECOND deal on a car whose FIRST deal has ended.
    // SCRUM-195 Phase 1 installs the acquisition boundary but not the release
    // side: a claim is not released when its deal finishes, so the car still
    // reads as held and the second acquisition is correctly refused.
    //
    // Phase 3 (release / finalization semantics) must turn this green by
    // releasing the ended deal's claim. It must NOT be fixed by loosening the
    // acquisition boundary, which is what this authority exists to enforce.
    const s = await seedDealership("resaleAfterCancel");
    const first = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    // Cancelled before any receipt, so the supplier-paid guard does not fire.
    await s.asApprover.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: first.saleId as never,
      status: "CANCELLED" as const,
    });

    // The financier leg of the DEAD deal is then closed. This ordering is the
    // reachable one: `sales.update` refuses to cancel a sale whose supplier
    // disbursement is already confirmed, so the confirmation has to come after.
    // Without it the dead deal's settlement is incomplete for an unrelated
    // reason and the assertion at the end of this test proves nothing — which
    // is exactly how it was first written.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(first.applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        dealerContributionMinor: 0,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId: first.applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    // The dead transaction is still on the vehicle. That is the premise.
    const dead = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter(
        (row) => row.orgId === s.orgId && row.category === "VEHICLE_SALE"
      )
    );
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((row) => row.isDeleted === true)).toBe(true);

    // Re-sold at exactly the supplier's entitlement: a real zero-margin deal,
    // for which sale completion deliberately opens no claim.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE });
    });
    const second = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(second.applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        dealerContributionMinor: 0,
      });
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId: second.applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const claims = (await supplierClaimsOf(s)).filter((row) => row.status !== "CANCELLED");
    expect(claims).toHaveLength(0);

    const view = await cockpitOf(s, second.applicationId);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
    expect(supplierRow(view).position).toBe("NOT_INVOLVED");

    // And the DEAD deal must not read the live one's margin. Cancelling a sale
    // never clears `finalizedSaleId`, so the first application is still a
    // reachable screen — and an earlier fix that counted live transaction rows
    // for the VEHICLE gave it its successor's figure, turning a withheld number
    // into a confidently wrong one. The claim rows are keyed by SALE, so the
    // cancelled deal can only ever find its own cancelled claim.
    const deadView = await cockpitOf(s, first.applicationId);
    expect(stageOf(deadView, "SETTLEMENT")).not.toBe("COMPLETE");
    expect(deadView!.money!.managementProfit.available).toBe(false);
  });

  /**
   * CX-13. The false zero.
   *
   * An earlier design read "no claim row for this sale" as proof the margin was
   * zero, because completion opens a claim only when it is positive. Absence
   * proves no such thing. `hardDeleteOrg` removes `vehicleSupplierReceivables`
   * (step 58) BEFORE `sales` (step 70), so a run that fails between them leaves
   * a sale whose claim is gone — and a sale predating the claims table looks
   * identical. Both would have reported the deal fully settled with the whole
   * margin still uncollected.
   *
   * The sale records what it earned. A missing claim on a sale that recorded a
   * POSITIVE margin is a missing record, and missing records are never NONE.
   */
  test("a deleted claim does not become proof that the margin was zero", async () => {
    const { s, applicationId } = await directDeal("deletedClaim");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    // Exactly what a half-completed org wipe leaves behind: the claim gone,
    // the sale still present.
    await s.t.run(async (ctx) => {
      await ctx.db.delete(claim._id);
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });

  /**
   * The other side of the same fact: a sale that predates `consignedMarginMinor`
   * has no recorded margin, and that is UNKNOWN rather than zero.
   */
  test("a sale with no recorded margin is unknown, not zero", async () => {
    const { s, applicationId } = await directDeal("legacyNoMargin");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.delete(claim._id);
      const sale = (await ctx.db.query("sales").collect()).find((row) => row.orgId === s.orgId)!;
      await ctx.db.patch(sale._id, { consignedMarginMinor: undefined });
    });

    const view = await cockpitOf(s, applicationId);
    expect(supplierRow(view).position).toBe("UNKNOWN");
    expect(view!.money!.managementProfit.available).toBe(false);
  });

  /**
   * And the case all of this exists to keep working: a genuine zero-margin deal
   * records a zero, so it can still finish.
   */
  test("a recorded zero margin still lets the deal complete", async () => {
    const s = await seedDealership("recordedZero");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, { sourceCost: VEHICLE_PRICE });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        dealerContributionMinor: 0,
      });
      const sale = (await ctx.db.query("sales").collect()).find((row) => row.orgId === s.orgId)!;
      // The premise: completion recorded a zero rather than recording nothing.
      expect(sale.consignedMarginMinor).toBe(0);
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });

    const view = await cockpitOf(s, applicationId);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
    expect(supplierRow(view).position).toBe("NOT_INVOLVED");
  });

  /**
   * OP-F3 follow-through. A stored amount this currency cannot represent must
   * mark ONE row unknown, not reject the query — `dealCockpit` is the whole
   * screen, and Convex accepts NaN as a `v.number()`, which the admin raw-JSON
   * editor can write.
   *
   * A first attempt guarded only the settlement predicate, so the same NaN
   * reached the party-row conversion a few lines later and threw anyway.
   */
  test("an unreadable stored amount marks the row unknown instead of blanking the screen", async () => {
    const { s, applicationId } = await directDeal("nanAmount");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(claim._id, { amountDue: Number.NaN });
    });

    const view = await cockpitOf(s, applicationId);
    expect(view).toBeDefined();
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });

  test("an amount that overflows minor units also degrades rather than throwing", async () => {
    // `Number.isFinite(1e18)` is true, so a finiteness check alone misses this:
    // 1e18 JOD is 1e21 minor units, which is not a safe integer.
    const { s, applicationId } = await directDeal("overflowAmount");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(claim._id, { amountDue: 1e18 });
    });

    const view = await cockpitOf(s, applicationId);
    expect(view).toBeDefined();
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });


  /**
   * OP-F3 / CX-12. The mirror of the receivable residue, on the PAYABLE that
   * the through-route cockpit reads.
   *
   * `recordPartialPayment` compared major-unit floats exactly as `recordReceipt`
   * did, so a 4.440 JOD payable paid in three instalments of 1.480 accumulated
   * to 4.4399999999999995 — never PAID, and no further payment accepted, since
   * the residue owing is under a thousandth of a fils.
   *
   * The cockpit made it worse rather than better: judging the same row in minor
   * units it reported the supplier SETTLED while the payables screen and the
   * aging report reported PARTIALLY_PAID forever. Two screens, one supplier,
   * opposite answers about whether he had been paid. Both sides of the
   * comparison now agree.
   */
  test("a payable paid in instalments that do not sum exactly is settled on both surfaces", async () => {
    const s = await seedDealership("payableResidue");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });

    const payable = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === s.orgId && row.status !== "CANCELLED"
      )!
    );
    await s.t.run(async (ctx) => {
      await ctx.db.patch(payable._id, {
        amountDue: 4.44,
        amountPaid: undefined,
        status: "DUE_ON_SALE",
      });
    });

    for (let i = 0; i < 3; i++) {
      await s.asApprover.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId,
        payableId: payable._id,
        amount: 1.48,
      });
    }

    const after = await s.t.run(async (ctx) => await ctx.db.get(payable._id));
    // The residue is real; what must not happen is treating it as a debt.
    expect(after!.amountPaid).not.toBe(4.44);
    expect(after!.status).toBe("PAID");
    // And the settled timestamp must exist on a row that reports itself settled.
    expect(after!.paidAt).toBeDefined();

    // The cockpit and the subledger now agree.
    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    expect(supplier.position).toBe("SETTLED");
  });

  /**
   * The representability guard the receivable side already had. Two payments of
   * 0.0005 would otherwise settle a 0.001 payable while each accounting hook
   * rounded to a fils — discharging two fils against a one-fils liability.
   */
  test("a payment finer than the currency can represent is refused", async () => {
    const s = await seedDealership("payableFraction");
    await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });
    const payable = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === s.orgId && row.status !== "CANCELLED"
      )!
    );

    await expect(
      s.asApprover.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId,
        payableId: payable._id,
        amount: 0.0005,
      })
      // Matched on the message: a bare `rejects.toThrow()` would also pass on an
      // authorization or not-found failure, and prove nothing about the guard.
    ).rejects.toThrow(/finer than the currency/i);
  });


  /**
   * OP-F6.1. `completeExistingSale` — the PENDING → COMPLETED draft transition —
   * is the SECOND writer of the recorded margin, and it is the one a reader of
   * the diff cannot verify by inspection. If only `completeSale` wrote the
   * field, every draft-completed consigned deal would read UNKNOWN forever.
   */
  test("completing a draft sale records the margin too", async () => {
    const s = await seedDealership("draftMargin");
    const { applicationId, saleId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: true,
    });
    expect(saleId).toBeTruthy();

    const sale = await s.t.run(async (ctx) => await ctx.db.get(saleId as never));
    expect((sale as { consignedMarginMinor?: number }).consignedMarginMinor).toBe(MARGIN * SCALE);
    expect((sale as { consignedMarginCurrency?: string }).consignedMarginCurrency).toBe("JOD");

    // And the cockpit reads it rather than inferring anything.
    const view = await cockpitOf(s, applicationId);
    expect(view).toBeDefined();
  });

  /**
   * OP-F4/F-5. The recorded margin is denominated. The writer uses the ORG's
   * currency; this query resolves its own from the application, and
   * `orgSettings` does not count `financeApplications` among the rows that lock
   * an org's currency — so the two can genuinely diverge. Subtracting USD cents
   * from JOD fils and publishing the difference as profit is the failure.
   */
  test("a margin recorded in another currency is not read as this deal's", async () => {
    const { s, applicationId } = await directDeal("marginCurrency");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.delete(claim._id);
      const sale = (await ctx.db.query("sales").collect()).find((row) => row.orgId === s.orgId)!;
      await ctx.db.patch(sale._id, { consignedMarginCurrency: "USD" });
    });

    const view = await cockpitOf(s, applicationId);
    expect(supplierRow(view).position).toBe("UNKNOWN");
    expect(view!.money!.managementProfit.available).toBe(false);
  });

  /**
   * A negative recorded margin cannot come from the write path — completion
   * refuses a sourced sale below the supplier's entitlement — which is exactly
   * why the READER must reject it. `sales` is editable through the super-admin
   * raw-JSON editor, and a negative would flow through as `disbursed − (−X)`
   * and publish an inflated profit no downstream guard would catch.
   */
  test("a negative recorded margin is refused rather than inflating the headline", async () => {
    const { s, applicationId } = await directDeal("negativeRecorded");
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.t.run(async (ctx) => {
      await ctx.db.delete(claim._id);
      const sale = (await ctx.db.query("sales").collect()).find((row) => row.orgId === s.orgId)!;
      await ctx.db.patch(sale._id, { consignedMarginMinor: -1_000 * SCALE });
    });

    const view = await cockpitOf(s, applicationId);
    expect(supplierRow(view).position).toBe("UNKNOWN");
    expect(view!.money!.managementProfit.available).toBe(false);
  });

  /**
   * OP-F6.2. The cancelled-deal short-circuit needs its own coverage: the dead
   * deal's figure was already withheld for a different reason, so nothing
   * asserted the REASON the operator actually reads.
   */
  test("a cancelled deal says so, rather than blaming a missing figure", async () => {
    const s = await seedDealership("cancelledReason");
    const { applicationId, saleId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: true,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: VEHICLE_PRICE * SCALE,
        dealerContributionMinor: 0,
      });
    });
    await s.asApprover.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleId as never,
      status: "CANCELLED" as const,
    });

    const profit = (await cockpitOf(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(false);
    if (!profit.available) expect(profit.reason).toBe("DealCancelled");
  });


  /**
   * CodeRabbit. `deposit.amountMinor ?? convert(...)` put the currency check
   * inside the FALLBACK only, so a foreign-currency deposit that happened to
   * carry `amountMinor` was added to the customer's total unconverted — 500 USD
   * cents counted as 500 JOD fils. The stored minor amount is denominated too;
   * it is not a currency-free number.
   */
  test("a foreign-currency deposit is not summed into the customer's total", async () => {
    const s = await seedDealership("foreignDeposit");
    // THROUGH_DEALERSHIP because the direct route refuses to be chosen while an
    // unresolved reservation deposit is held — and the deposit is the point of
    // this test. It is also the route the mockup depicts.
    const { applicationId } = await runDeal(s, {
      route: "THROUGH_DEALERSHIP",
      finalize: false,
      deposit: 300,
    });

    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find(
        (row) => row.orgId === s.orgId
      )!;
      // Present AND in another currency — the combination the old expression
      // could not see.
      await ctx.db.patch(deposit._id, { currency: "USD", amountMinor: 300 * SCALE });
    });

    const view = await cockpitOf(s, applicationId);
    const customer = view!.money!.parties.find((p) => p.party === "CUSTOMER")!;
    expect(customer.amountMinor).toBe(0);
    // And the row must say it cannot speak for the customer, not that the
    // customer put nothing in.
    expect(customer.position).toBe("UNKNOWN");
  });

});

/**
 * SCRUM-30. The one invariant this whole redesign exists to make structural:
 *
 *   **A claim on the supplier may never exceed the portion of money he actually
 *   received that economically belongs to the dealership.**
 *
 * Every test here drives the REAL writers — `recordSubmittedQuotation`,
 * `approveDealerPurchaseAmount`, `finalizeDeal`, `confirmSupplierDisbursement`,
 * `recordReceipt` — because the defect was never in the arithmetic. The pure
 * function was fine; the wrong quantity was handed to it. A helper-level test
 * would have passed throughout the entire period the bug was live.
 *
 * The deals below deliberately break the identity every other test in this file
 * relies on. Elsewhere the approval equals the vehicle price, so `approved`, the
 * sale price and what the supplier receives are the same number, and no formula
 * can be told apart from any other. Here they are three different numbers.
 */
describe("the supplier is never made debtor for money that did not reach him", () => {
  /** Walks a direct deal to APPROVED, then approves `approvedAmount` for real. */
  async function directDealApprovedAt(tag: string, approvedAmount: number) {
    const s = await seedDealership(tag);
    // The quotation solver refuses a company with no LTV, and this suite's
    // fixture has none. Set before the deal, so the application freezes a
    // snapshot carrying it. At 100% the finance company funds the whole
    // approval and the dealership contributes nothing, which keeps these tests
    // about the supplier rather than about the funding split.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });

    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });

    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: approvedAmount * SCALE,
      basis: "MANUAL",
      notes: `Approved at ${approvedAmount}.`,
    });
    return { s, applicationId };
  }

  /** The live claim's opening amount, in major units, or undefined if none. */
  async function claimDueOf(s: Seeded) {
    const rows = await supplierClaimsOf(s);
    return rows.find((r) => r.status !== "CANCELLED")?.amountDue;
  }

  const cockpit = (s: Seeded, applicationId: string) =>
    s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });

  test("a supplier paid exactly his entitlement owes nothing, and no claim is opened", async () => {
    const { s, applicationId } = await directDealApprovedAt("s30Exact", SUPPLIER_ENTITLEMENT);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    // He received 15,000 and was owed 15,000. A claim for anything at all would
    // be a debt he does not have — and a zero-amount claim is worse than none,
    // because it sits on the aging report forever and no receipt can close it.
    expect(await claimDueOf(s)).toBeUndefined();

    // The ledger must agree: no receivable from suppliers, no commission.
    const ledger = await ledgerBySystemKey(s);
    expect(ledger[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
    expect(ledger[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE] ?? 0).toBe(0);
  });

  test("a supplier paid 3,000 above his entitlement owes exactly 3,000, not the 5,000 dealer margin", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Excess", APPROVED);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    // The excess that genuinely reached him.
    expect(await claimDueOf(s)).toBe(APPROVED - SUPPLIER_ENTITLEMENT);
    // NOT the dealership's total margin on the deal, which is 2,000 larger and
    // is what the subledger used to raise.
    expect(await claimDueOf(s)).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);

    // GL and subledger reconcile — the same integer, not merely similar figures.
    const ledger = await ledgerBySystemKey(s);
    expect(ledger[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(
      (APPROVED - SUPPLIER_ENTITLEMENT) * SCALE
    );
    // Revenue is the legally supported claim, never the management spread.
    expect(ledger[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(
      -(APPROVED - SUPPLIER_ENTITLEMENT) * SCALE
    );
  });

  test("money the customer pays the dealership directly cannot become the supplier's debt", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30CustomerGap", APPROVED);

    // The customer covers the 2,000 the financier did not approve, straight to
    // the dealership. It is the dealership's money and always was — it never
    // passed through the supplier's hands for a moment.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        customerGapCashToDealerMinor: 1_200 * SCALE,
        customerGapInstallmentToDealerMinor: 800 * SCALE,
      });
    });
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    // Unmoved by the customer's payment. This is the case that shows the old
    // model was not merely off by a rounding: it billed the SUPPLIER for money
    // the CUSTOMER had already paid the dealership.
    expect(await claimDueOf(s)).toBe(APPROVED - SUPPLIER_ENTITLEMENT);

    const ledger = await ledgerBySystemKey(s);
    expect(ledger[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(
      (APPROVED - SUPPLIER_ENTITLEMENT) * SCALE
    );

    // And the headline counts it on the DEALERSHIP's side, where it belongs.
    const profit = (await cockpit(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    expect(profit.lines.find((l) => l.key === "CUSTOMER_DIRECT_TO_DEALER")?.amountMinor).toBe(
      2_000 * SCALE
    );
    expect(profit.lines.find((l) => l.key === "SUPPLIER_SETTLEMENT")?.amountMinor).toBe(
      SUPPLIER_ENTITLEMENT * SCALE
    );
  });

  test("a dealership contribution moves its own profit, never the supplier's debt", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Contribution", APPROVED);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    const before = await claimDueOf(s);

    // The dealership funds part of the purchase itself. That is money going OUT
    // of the dealership, so it reduces what the deal earns — but the supplier is
    // still holding exactly the same excess, so he still owes exactly the same.
    // Settling a contribution on the wrong side of the settlement is a
    // documented failure mode, which is why it is pinned here.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { dealerContributionMinor: 875 * SCALE });
    });

    expect(await claimDueOf(s)).toBe(before);
    expect(await claimDueOf(s)).toBe(APPROVED - SUPPLIER_ENTITLEMENT);

    const profit = (await cockpit(s, applicationId))!.money!.managementProfit;
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    // Its own line, subtracted — and the supplier line untouched beside it.
    expect(profit.lines.find((l) => l.key === "DEALER_CONTRIBUTION")?.amountMinor).toBe(875 * SCALE);
    expect(profit.lines.find((l) => l.key === "SUPPLIER_SETTLEMENT")?.amountMinor).toBe(
      SUPPLIER_ENTITLEMENT * SCALE
    );
    expect(profit.amountMinor).toBe((APPROVED - SUPPLIER_ENTITLEMENT - 875) * SCALE);
  });

  test("a receipt above the corrected claim is refused — the old claim was 2,000 larger", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Overpay", APPROVED);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    const claim = (await supplierClaimsOf(s)).find((r) => r.status !== "CANCELLED")!;

    // 5,000 is exactly what the OLD model would have opened, so it is the amount
    // an operator working from the previous screen would have tried to collect.
    // It must be refused, not quietly absorbed as an overpayment.
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId: claim._id,
        amount: VEHICLE_PRICE - SUPPLIER_ENTITLEMENT,
      })
    ).rejects.toThrow();

    // The exact claim settles it in full.
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: APPROVED - SUPPLIER_ENTITLEMENT,
    });
    const settled = (await supplierClaimsOf(s)).find((r) => r._id === claim._id)!;
    expect(settled.status).toBe("PAID");
  });

  test("a partial receipt leaves the remainder outstanding, against the corrected claim", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Partial", APPROVED);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });

    const claim = (await supplierClaimsOf(s)).find((r) => r.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: 1_000,
    });

    const row = (await supplierClaimsOf(s)).find((r) => r._id === claim._id)!;
    expect(row.status).not.toBe("PAID");
    expect(row.amountReceived).toBe(1_000);
    // The opening amount never moves when a receipt lands.
    expect(row.amountDue).toBe(APPROVED - SUPPLIER_ENTITLEMENT);
  });

  test("cancelling the deal reverses the corrected claim in both the GL and the subledger", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Cancel", APPROVED);
    const saleId = await s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
    });

    const ledgerBefore = await ledgerBySystemKey(s);
    expect(ledgerBefore[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(
      (APPROVED - SUPPLIER_ENTITLEMENT) * SCALE
    );

    await s.asApprover.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleId as never,
      status: "CANCELLED" as const,
    });

    // The subledger claim is withdrawn...
    const claims = await supplierClaimsOf(s);
    expect(claims.every((r) => r.status === "CANCELLED")).toBe(true);

    // ...and the GL nets to nothing, rather than posting 3,000 and reversing
    // 5,000. A reversal that does not match its original is how a subledger and
    // a ledger drift apart while every individual entry still balances.
    const ledgerAfter = await ledgerBySystemKey(s);
    expect(ledgerAfter[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
    expect(ledgerAfter[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE] ?? 0).toBe(0);
  });

  test("the cockpit reports the same economic state the subledger and the GL hold", async () => {
    const APPROVED = 18_000;
    const { s, applicationId } = await directDealApprovedAt("s30Reconcile", APPROVED);
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: APPROVED * SCALE,
    });

    const claim = (await supplierClaimsOf(s)).find((r) => r.status !== "CANCELLED")!;
    const ledger = await ledgerBySystemKey(s);
    const view = await cockpit(s, applicationId);

    // Three records of one fact, asserted equal in integer minor units: the
    // subledger's claim, the GL's debit, and the party row the operator acts on.
    const supplierParty = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    expect(claim.amountDue * SCALE).toBe(ledger[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]);
    expect(supplierParty.amountMinor).toBe(ledger[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]);
    expect(supplierParty.amountMinor).toBe((APPROVED - SUPPLIER_ENTITLEMENT) * SCALE);
  });

  test("an approval below the supplier's entitlement is refused, not clamped to no claim", async () => {
    const s = await seedDealership("s30Floor");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });

    // 14,000 against an entitlement of 15,000: the supplier ends up 1,000 short.
    // The old `salePrice >= entitlement` guard passed this without complaint,
    // because 20,000 is comfortably above 15,000 — a different quantity entirely.
    await expect(
      s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId,
        applicationId,
        approvedAmountMinor: 14_000 * SCALE,
        basis: "MANUAL",
        notes: "Below the supplier's entitlement.",
      })
    ).rejects.toThrow(/he is owed/i);
  });

  test("choosing the direct route after a too-low approval is refused by the mirror guard", async () => {
    const s = await seedDealership("s30FloorMirror");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    // No route yet, so the approval-time guard has nothing to check against.
    const { applicationId } = await runDeal(s, { finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: 14_000 * SCALE,
      basis: "MANUAL",
      notes: "Approved before the route was chosen.",
    });

    // The other ordering reaches the same illegal state. A guard that covers
    // only one of the two has a documented way around it.
    await expect(
      s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId,
        applicationId,
        route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/he is owed/i);
  });

  test("a direct deal with no approved amount is refused rather than settled at the sale price", async () => {
    const s = await seedDealership("s30NoApproval");
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });

    // The fallback this replaces is the whole defect: with no approval recorded,
    // `completeSale` measured the supplier's debt against `quote.vehiclePrice`
    // and opened a claim for money nobody had paid him.
    await expect(
      s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId })
    ).rejects.toThrow(/approved purchase amount is not recorded/i);

    expect(await claimDueOf(s)).toBeUndefined();
  });
});

/**
 * SCRUM-30 HIGH #2. The arm of the cancellation guard nothing exercised.
 *
 * `sales.update` refuses to cancel a deal whose finance company has already paid
 * — and to know that, it has to READ the application. The readable already-paid
 * case is covered above. What was not covered is what happens when the evidence
 * itself cannot be read: a deleted application row, or one belonging to another
 * organization.
 *
 * That arm is the dangerous one. Written as `if (app && app.orgId === orgId)`
 * the guard skips BOTH refusals whenever the application cannot be read, so
 * unavailable evidence becomes permission to proceed — on a cancellation that
 * reverses money a finance company has already sent the supplier, returns a
 * handed-over car to sellable inventory, and cancels the dealership's claim.
 *
 * Every `return`/skip toward a guard's evidence is an ALLOW. These pin that the
 * code refuses instead, and that it says which case it is rather than failing
 * with a message about a payment it could not actually check.
 */
describe("cancelling a deal whose financing evidence cannot be read", () => {
  async function paidDirectDeal(tag: string) {
    const s = await seedDealership(tag);
    const { applicationId, saleId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: true,
    });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: VEHICLE_PRICE * SCALE,
    });
    return { s, applicationId, saleId: saleId as never };
  }

  test("a MISSING application refuses the cancellation rather than waving it through", async () => {
    const { s, applicationId, saleId } = await paidDirectDeal("cancelMissingApp");

    // The super-admin panel can hard-delete a row, and `hardDeleteOrg` removes
    // tables in an order that can leave a sale whose application is gone.
    await s.t.run(async (ctx) => {
      await ctx.db.delete(applicationId as never);
    });

    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId,
        status: "CANCELLED" as const,
      })
    ).rejects.toThrow(/can't be read/i);

    // And nothing moved. A refusal that still reversed the sale would be worse
    // than no refusal, because it would look like it had held.
    const sale = (await s.t.run((ctx) => ctx.db.get(saleId))) as { status: string };
    expect(sale.status).toBe("COMPLETED");
    const claims = await supplierClaimsOf(s);
    expect(claims.every((r) => r.status !== "CANCELLED")).toBe(true);
  });

  test("an application belonging to ANOTHER org refuses the cancellation", async () => {
    const { s, applicationId, saleId } = await paidDirectDeal("cancelForeignApp");

    // The foreign org is created INSIDE this deal's database, not by a second
    // `seedDealership`. Each `convexTest` instance is its own database and they
    // allocate ids from the same deterministic counter, so a second fixture's
    // "other" org id is byte-for-byte the FIRST org's id — the patch below would
    // be a no-op and the test would pass against a guard that does nothing.
    const foreignOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Another Dealership", createdAt: Date.now() })
    );

    // Readable, but not this tenant's. `ctx.db.get` returns the row regardless —
    // tenancy is the caller's job, and this is the check that does it.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId as never, { orgId: foreignOrgId as never });
    });

    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId,
        status: "CANCELLED" as const,
      })
    ).rejects.toThrow(/can't be read/i);

    const sale = (await s.t.run((ctx) => ctx.db.get(saleId))) as { status: string };
    expect(sale.status).toBe("COMPLETED");
  });

  test("the refusal names the unreadable evidence, not a payment it never checked", async () => {
    const { s, applicationId, saleId } = await paidDirectDeal("cancelMessage");
    await s.t.run(async (ctx) => {
      await ctx.db.delete(applicationId as never);
    });

    // A guard that cannot read its evidence must not claim to have found a
    // payment — the operator would go and unwind a disbursement nobody has
    // confirmed. The two refusals are different instructions and must stay
    // distinguishable.
    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId,
        status: "CANCELLED" as const,
      })
    ).rejects.toThrow(/isn't possible to confirm whether the finance company has already paid/i);
  });

  test("a readable application with nothing paid still cancels normally", async () => {
    // The control. Without it the three refusals above are equally satisfied by
    // a guard that refuses every cancellation, which would be its own defect.
    const s = await seedDealership("cancelReadableClean");
    const { saleId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: true });

    await s.asApprover.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleId as never,
      status: "CANCELLED" as const,
    });

    const sale = (await s.t.run((ctx) => ctx.db.get(saleId as never))) as { status: string };
    expect(sale.status).toBe("CANCELLED");
  });
});

/**
 * Round-2 findings from the Codex adversarial review of `deaeff3e`, each
 * reproduced before it was fixed.
 *
 * The first round grounded the supplier claim in `approved − entitlement` and
 * proved it through `finalizeDeal`. Two ways around that remained, and both
 * reopen the original defect rather than merely bending it:
 *
 *   - the approved amount is denominated in the APPLICATION's pinned
 *     `economicsCurrency`, while `completeSale` resolves the sale's currency
 *     from the ORG. When those differ in scale the claim is not slightly off,
 *     it is off by a factor of ten or more — and the GL and subledger agree
 *     with each other on the wrong figure, so nothing reconciles them.
 *   - `sales.create` accepts `financingType: "FINANCED"` together with
 *     `DIRECT_TO_SUPPLIER` and has no field for the approved amount at all, so
 *     it fell straight to the sale-price fallback. The first round's tests all
 *     went through `finalizeDeal` and never touched this door.
 */
describe("the claim cannot be reopened through a second door", () => {
  test("a currency change between approval and finalization is refused, not silently mixed", async () => {
    const s = await seedDealership("s30CurrencyMix");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });

    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: 18_000 * SCALE,
      basis: "MANUAL",
      notes: "Approved in the deal's pinned currency.",
    });

    // The org switches reporting currency AFTER the approval is frozen.
    // `orgSettings` does not count `financeApplications` among the rows that
    // lock an org's currency, so nothing prevents this.
    await s.t.run(async (ctx) => {
      const settings = (await ctx.db.query("orgSettings").collect()).find(
        (row) => row.orgId === s.orgId
      );
      if (settings) await ctx.db.patch(settings._id, { currency: "USD" });
    });

    // 18,000,000 fils compared against an entitlement converted to 1,500,000
    // cents would derive a claim of 16,500,000 — USD 165,000 against a supplier
    // holding JOD 3,000 of dealership money. Refusing is the only safe answer:
    // there is no exchange rate in the model, and inventing one would be worse
    // than stopping.
    await expect(
      s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId })
    ).rejects.toThrow(/currency/i);

    // Nothing was written on the way to the refusal.
    const claims = await supplierClaimsOf(s);
    expect(claims.length).toBe(0);
  });

  test("a financed direct sale created outside the application workflow is refused", async () => {
    const s = await seedDealership("s30DirectWriter");

    // `sales.create` takes `financingType` and `supplierSettlementRoute` but has
    // no field for what the financier approved — it cannot know it. Falling back
    // to the sale price here opened a claim of 5,000 against a supplier holding
    // 3,000, which is the exact defect SCRUM-30 exists to close, reached through
    // a writer the first round's tests never exercised.
    await expect(
      s.asUser.mutation(api.sales.create, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: VEHICLE_PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        financingType: "FINANCED" as const,
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
      })
    ).rejects.toThrow(/finance application|approved/i);

    const claims = await supplierClaimsOf(s);
    expect(claims.length).toBe(0);
  });

  test("a CASH direct sale created the same way still completes, at the sale price", async () => {
    // The control. The refusal above must be about financing, not about the
    // direct route — a cash direct sale is exactly the case where the buyer pays
    // the supplier the sale price, and PR #204 shipped it deliberately.
    const s = await seedDealership("s30CashWriter");

    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: VEHICLE_PRICE,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      financingType: "CASH" as const,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
    });

    const claim = (await supplierClaimsOf(s)).find((r) => r.status !== "CANCELLED")!;
    expect(claim.amountDue).toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);
  });
});

/**
 * SCRUM-30 — automatic salesperson commission is measured on RECOGNIZED
 * dealership earnings, never on `salePrice − cost`.
 *
 * Dealership ruling, 2026-08-10. On a financed DIRECT deal the two are
 * different numbers: with a sale at 20,000, an entitlement of 15,000 and an
 * approved purchase amount of 18,000, the dealership recognizes 3,000 of agency
 * revenue and the remaining 2,000 is `salePrice − approved` — a management
 * figure on no invoice and no receipt (SCRUM-23).
 *
 * Commission is not a display number. It accrues to Commission Payable and
 * becomes payroll money owed to an employee, so its base has to be an
 * economically supported dealership earning. Left on `salePrice − cost`, the
 * same invalid 2,000 this whole redesign removes from the supplier subledger
 * and the GL would have survived intact through employee compensation — which
 * is why this is part of SCRUM-30 rather than a follow-up.
 *
 * The customer paying that 2,000 directly does NOT make it commissionable. It
 * must first be recorded and classified as dealership income belonging to the
 * sale; only then may the commission plan mark that component eligible, and the
 * base becomes the SUM of two recognized components. It must never be reached
 * by falling back to `salePrice − cost`, because that path also moves payroll
 * whenever an internal quotation figure changes with no money behind it.
 */
describe("automatic commission is based on recognized earnings, not the commercial spread", () => {
  const RATE_PERCENT = 10;

  async function directDealCommissionedAt(tag: string, approvedAmount: number) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
      // The salesperson earns a straight percentage of the deal's margin.
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE_PERCENT });
    });

    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: approvedAmount * SCALE,
      basis: "MANUAL",
      notes: `Approved at ${approvedAmount}.`,
    });
    const saleId = await s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
    });
    const sale = (await s.t.run((ctx) => ctx.db.get(saleId as never))) as {
      commissionAmount?: number;
    };
    return { s, applicationId, saleId, sale };
  }

  test("the 20k/18k/15k deal commissions on 3,000, not on the 5,000 spread", async () => {
    const { sale } = await directDealCommissionedAt("s30Commission", 18_000);

    // 10% of the recognized agency revenue: (18,000 − 15,000) × 10%.
    expect(sale.commissionAmount).toBe(300);
    // And specifically NOT 10% of `salePrice − cost`, which is what the
    // calculator produced before the ruling. That figure pays an employee for
    // 2,000 that appears on no invoice and that nobody has committed to paying.
    expect(sale.commissionAmount).not.toBe(500);
  });

  test("the commission accrued to the ledger matches the recognized base", async () => {
    const { s } = await directDealCommissionedAt("s30CommissionGl", 18_000);

    // Not just the stored figure — the money actually posted. A commission that
    // agrees with the sale row but not with Commission Payable would leave
    // payroll and the ledger disagreeing about the same obligation.
    const ledger = await ledgerBySystemKey(s);
    expect(ledger[SYSTEM_KEYS.COMMISSION_PAYABLE] ?? 0).toBe(-300 * SCALE);
    // The commission expense is 10% of what the ledger recognized as revenue,
    // and revenue is the claim — so the two are consistent by construction.
    expect(ledger[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-3_000 * SCALE);
  });

  test("the base tracks the approval, while the sale price stays put", async () => {
    // Same car, same customer, same 20,000 sale price in both deals — only the
    // finance company's approval differs. If commission were measured on
    // `salePrice − cost` these two would be identical; they are not.
    const lower = await directDealCommissionedAt("s30CommissionLow", 18_000);
    const higher = await directDealCommissionedAt("s30CommissionHigh", 19_000);

    expect(lower.sale.commissionAmount).toBe(300);
    expect(higher.sale.commissionAmount).toBe(400);
    // The management-only spread moved from 2,000 to 1,000 between these two
    // deals and payroll did not follow it — it followed the recognized earning.
    expect(lower.sale.commissionAmount).not.toBe(higher.sale.commissionAmount);
  });

  test("a supplier paid exactly his entitlement earns the salesperson nothing", async () => {
    // Zero recognized revenue is a real outcome, not a broken one: the
    // dealership placed the car and made nothing on the metal. Commission of
    // zero is the honest answer, and `salePrice − cost` would have paid 500.
    const { sale } = await directDealCommissionedAt("s30CommissionZero", SUPPLIER_ENTITLEMENT);

    expect(sale.commissionAmount).toBe(0);
  });

  test("a THROUGH_DEALERSHIP deal still commissions on the sale price", async () => {
    // The ruling is scoped to what it should be. On this route the dealership
    // collects the gross and the customer is contractually liable for the whole
    // sale price, so the spread over the entitlement genuinely IS recognized —
    // and this deal must be untouched by the change.
    const s = await seedDealership("s30CommissionThrough");
    await s.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE_PERCENT });
    });

    const { saleId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });
    const sale = (await s.t.run((ctx) => ctx.db.get(saleId as never))) as {
      commissionAmount?: number;
    };

    // 10% of (20,000 − 15,000).
    expect(sale.commissionAmount).toBe(500);
  });
});

/**
 * SCRUM-30 — the sales reports agree with the ledger about what a deal earned.
 *
 * `getSalesAndProfitReport` and `getSalespersonPerformance` both derived the
 * consigned margin as `salePrice − capitalizedCost`. Before this branch that
 * agreed with the GL by construction. It no longer does: on a financed DIRECT
 * deal the ledger recognizes `approved − entitlement`, and the difference is
 * `salePrice − approved` — money that reaches no party.
 *
 * Left alone, the owner opened the sales report and saw 5,000 profit on a deal
 * whose P&L, GL and supplier subledger all said 3,000, in a report file whose
 * own comment claims it "can no longer disagree with them about a vehicle's
 * margin". Two owner-facing profit figures for one deal is worse than either
 * number being wrong on its own, because it destroys trust in both.
 */
describe("the sales reports reconcile to the ledger on a financed direct deal", () => {
  async function reportedDeal(tag: string, approvedAmount: number) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
    });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: approvedAmount * SCALE,
      basis: "MANUAL",
      notes: `Approved at ${approvedAmount}.`,
    });
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    return s;
  }

  const range = () => ({ startDate: Date.now() - 86_400_000, endDate: Date.now() + 86_400_000 });

  test("the sales-and-profit report shows the recognized margin, not the sale-price spread", async () => {
    const s = await reportedDeal("s30Report", 18_000);

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });

    // What the ledger recognized.
    expect(report.totalProfit).toBe(3_000);
    expect(report.totalRevenue).toBe(3_000);
    // And NOT `salePrice − cost`, which is 2,000 larger and is what this report
    // published beside a P&L that said 3,000.
    expect(report.totalProfit).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);

    // Asserted against the GL itself rather than against a second expectation,
    // so the two cannot drift apart again without this failing.
    const ledger = await ledgerBySystemKey(s);
    expect(report.totalRevenue * SCALE).toBe(-ledger[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]);
  });

  test("salesperson performance ranks on the recognized margin too", async () => {
    const s = await reportedDeal("s30ReportPerf", 18_000);

    const perf = await s.asUser.query(api.reports.getSalespersonPerformance, {
      orgId: s.orgId,
      ...range(),
    });

    const row = perf.find((r: { totalProfit: number }) => r.totalProfit !== 0) ?? perf[0];
    expect(row.totalProfit).toBe(3_000);
    expect(row.totalProfit).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);
  });

  test("a THROUGH_DEALERSHIP deal still reports the full spread", async () => {
    // The control. There the dealership collects the gross and the customer is
    // liable for the whole sale price, so `salePrice − entitlement` genuinely is
    // the recognized margin and this report must be unchanged.
    const s = await seedDealership("s30ReportThrough");
    await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });
    expect(report.totalProfit).toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);
  });
});

/**
 * SCRUM-30 — missing settlement evidence is UNKNOWN, never the sale price.
 *
 * The commission ruling and the report correction both read one persisted fact:
 * what the finance company actually paid the supplier. Both were written with a
 * fallback — `supplierGrossReceipt ?? salePrice`, `recordedMargin ?? salePrice −
 * cost` — which is correct for every shape where the buyer really does hand the
 * supplier the sale price: owned stock, THROUGH_DEALERSHIP, and cash direct.
 *
 * It is not correct for a FINANCED direct deal. There the finance company pays
 * only what it approved, `salePrice − approved` reaches no party, and the fact
 * is the only thing separating the recognized 3,000 from the commercial 5,000.
 * Reading its absence as "then use the sale price" restores the exact basis the
 * ruling removed — silently, and on the two paths that pay payroll and inform
 * the owner.
 *
 * It is reachable rather than theoretical. `/admin`'s raw-JSON record editor can
 * clear any field on any row (convex/adminData.ts), rows written before this
 * branch never carried it, and a future writer can simply forget. So the
 * evidence is required where it is required: commission refuses and leaves the
 * existing figure alone, and the reports withhold the number and say they did.
 */
describe("financed direct evidence that has gone missing fails closed", () => {
  const RATE = 10;

  /** A complete, valid financed DIRECT deal, with the salesperson on 10%. */
  async function financedDirectSale(
    tag: string,
    approvedAmount: number,
    /**
     * Complete the sale under MANUAL commission with none entered — the state
     * in which `recalculateCommission` is legitimately reachable later, because
     * nothing was computed and nothing was accrued.
     */
    opts: { manualCommission?: boolean } = {}
  ) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, {
        commissionRate: opts.manualCommission ? undefined : RATE,
      });
      if (opts.manualCommission) {
        const settings = (await ctx.db.query("orgSettings").collect()).find(
          (x) => x.orgId === s.orgId
        )!;
        await ctx.db.patch(settings._id, { commissionMode: "MANUAL" });
      }
    });

    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: approvedAmount * SCALE,
      basis: "MANUAL",
      notes: `Approved at ${approvedAmount}.`,
    });
    const saleId = (await s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
    })) as never;
    return { s, applicationId, saleId };
  }

  const range = () => ({ startDate: Date.now() - 86_400_000, endDate: Date.now() + 86_400_000 });

  /**
   * The recalculation path must measure a consigned commission on the SAME
   * recognized earning the ledger booked — not re-derive it from a vehicle that
   * has moved since.
   *
   * `recalculateCommission` already reads the sale's frozen supplier receipt
   * rather than the application's, and says so. But it hands the LIVE vehicle
   * to the calculator, which recomputes the capitalized cost from it — so only
   * one of the two operands is frozen. The receipt is 18,000 forever; the cost
   * is whatever the vehicle says today.
   *
   * On `origin/main` that asymmetry was harmless: financed + DIRECT is refused
   * there, so no sale existed whose recognized earning differed from
   * `salePrice − cost` in the first place. This release creates that sale
   * shape, which is what makes an old helper a new defect — the calculator is
   * now handed data it was never written for.
   *
   * Reachability, precisely. Both of `recalculateCommission`'s guards have to
   * be absent, and there is an ordinary way to get there: complete under
   * MANUAL commission without entering one (nothing is computed,
   * `accrueAtCompletion` is false, so no accrual is posted), then have the
   * owner switch the org to automatic later — `orgSettings` locks the currency
   * once financial records exist, but deliberately not `commissionMode`.
   */
  test("recalculating a consigned commission uses the frozen margin, not a cost the vehicle has moved to", async () => {
    const { s, saleId } = await financedDirectSale("s30CommFrozen", 18_000, {
      manualCommission: true,
    });

    const completed = (await s.t.run((ctx) => ctx.db.get(saleId))) as unknown as {
      commissionAmount?: number;
      consignedMarginMinor?: number;
      vehicleId: never;
    };
    // The preconditions that make recalculation legal at all. Asserted rather
    // than assumed: if completion ever starts writing a commission here, this
    // test would silently stop exercising the path it exists for.
    expect(completed.commissionAmount).toBeUndefined();
    expect(completed.consignedMarginMinor).toBe(3_000 * SCALE);
    const accrualsBefore = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).filter(
        (e) => e.eventType === "COMMISSION_ACCRUED"
      )
    );
    expect(accrualsBefore).toHaveLength(0);

    // The supplier cost is corrected afterwards. Permitted: a consigned car is
    // never capitalized into Vehicle Inventory, so the acquisition lock that
    // guards an owned vehicle's cost never engages here.
    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: completed.vehicleId,
      sourceCost: 16_000,
    } as never);

    // ...and the dealership moves to automatic commission at 10%.
    await s.t.run(async (ctx) => {
      const settings = (await ctx.db.query("orgSettings").collect()).find(
        (x) => x.orgId === s.orgId
      )!;
      await ctx.db.patch(settings._id, { commissionMode: "AUTO_MEMBER" });
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE });
    });

    await s.asUser.mutation(api.sales.recalculateCommission, {
      orgId: s.orgId,
      saleId,
    });

    const after = (await s.t.run((ctx) => ctx.db.get(saleId))) as {
      commissionAmount?: number;
    };
    // 10% of the 3,000 the GL, the supplier claim and every report recognized —
    // not 10% of 18,000 − 16,000, which is a margin no party transacted and
    // which the ledger never booked.
    expect(after.commissionAmount).toBe(300);
  });

  test("and the accrual it posts carries that same basis", async () => {
    // The payable is the part that reaches the employee. A sale row corrected
    // in isolation would still owe them the wrong money.
    const { s, saleId } = await financedDirectSale("s30CommFrozenGl", 18_000, {
      manualCommission: true,
    });
    const completed = (await s.t.run((ctx) => ctx.db.get(saleId))) as unknown as {
      vehicleId: never;
    };

    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: completed.vehicleId,
      sourceCost: 16_000,
    } as never);
    await s.t.run(async (ctx) => {
      const settings = (await ctx.db.query("orgSettings").collect()).find(
        (x) => x.orgId === s.orgId
      )!;
      await ctx.db.patch(settings._id, { commissionMode: "AUTO_MEMBER" });
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE });
    });

    await s.asUser.mutation(api.sales.recalculateCommission, {
      orgId: s.orgId,
      saleId,
    });

    const accrued = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).find(
        (e) => e.eventType === "COMMISSION_ACCRUED"
      )
    );
    expect(accrued).toBeTruthy();
    expect((accrued as { payload?: { amountMinor?: number } })?.payload?.amountMinor).toBe(
      300 * SCALE
    );
  });

  /**
   * The dashboard is the screen the owner opens first, and it was the one
   * surface this change did not reach.
   *
   * `dashboard.stats` recomputed `salePrice − capitalizedCost` for a consigned
   * car while the sales report, the supplier claim, the journal and the cockpit
   * all read the margin the sale froze. Before this release every one of them
   * was on `salePrice − entitlement` and they agreed — wrongly, which is the
   * defect being fixed. Correcting five of six surfaces is what created the
   * contradiction: the home KPI said 5,000 and the P&L said 3,000 for the same
   * deal, in the same period.
   */
  test("the dashboard and the sales report state the same profit for one deal", async () => {
    const { s } = await financedDirectSale("s30DashAgrees", 18_000);

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesTrend: Array<{ Profit: number; Revenue: number }>;
      truncated: { profit: boolean };
    };
    const dashProfit = dash.salesTrend.reduce((sum, p) => sum + p.Profit, 0);
    const dashRevenue = dash.salesTrend.reduce((sum, p) => sum + p.Revenue, 0);

    // The premise, asserted so this cannot pass by both being wrong together.
    expect(report.totalProfit).toBe(3_000);
    expect(dashProfit).toBe(3_000);
    expect(dashRevenue).toBe(3_000);
    // Specifically not the commercial spread, which is what it published.
    expect(dashProfit).not.toBe(5_000);
    expect(dash.truncated.profit).toBe(false);
  });

  test("and a deal whose earning is unknown is excluded from it, not published at gross", async () => {
    // The fail-closed arm. The reports withhold such a row and say so; the
    // dashboard was publishing a confident 5,000 for it.
    const { s, saleId } = await financedDirectSale("s30DashUnknown", 18_000);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesTrend: Array<{ Profit: number; Revenue: number }>;
      truncated: { profit: boolean };
    };

    expect(dash.salesTrend.reduce((sum, p) => sum + p.Profit, 0)).toBe(0);
    expect(dash.salesTrend.reduce((sum, p) => sum + p.Revenue, 0)).toBe(0);
    // Short, and saying so — an understated total presented as complete is the
    // same failure as an overstated one.
    expect(dash.truncated.profit).toBe(true);
  });

  /**
   * The KPI deltas compare this period against the one before it, and the two
   * halves were derived by different rules.
   *
   * The current window was moved onto the frozen recognized earning; the
   * comparison window went on recomputing `salePrice − liveVehicleCost`. So the
   * same deal counted 3,000 while it was current and 5,000 once it aged out,
   * and the dealer read the difference as a collapse that never happened. Worse
   * than either figure alone: the arrow is derived from both.
   */
  const FORTY_FIVE_DAYS = 45 * 86_400_000;

  const monthDash = (s: Seeded) =>
    s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "MONTH",
    }) as Promise<{
      previousPeriod?: { sales?: number; netProfit?: number; expenses?: number };
      truncated: { profit: boolean };
    }>;

  test("the comparison window is on the same basis as the current one", async () => {
    const { s, saleId } = await financedDirectSale("s30DashPrev", 18_000);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { saleDate: Date.now() - FORTY_FIVE_DAYS });
    });

    const dash = await monthDash(s);

    // The premise, so this cannot pass by the window being empty: MONTH compares
    // the last 30 days against the 30 before them, and a 45-day-old sale is in
    // the second of those and not the first.
    expect(dash.previousPeriod).toBeDefined();
    expect(dash.previousPeriod!.sales).toBe(3_000);
    // Specifically not 5,000 — the commercial spread the current window had
    // already stopped publishing, still being published here.
    expect(dash.previousPeriod!.sales).not.toBe(5_000);
  });

  test("and an unknown earning there withholds the comparison instead of filling it in", async () => {
    const { s, saleId } = await financedDirectSale("s30DashPrevUnknown", 18_000);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, {
        saleDate: Date.now() - FORTY_FIVE_DAYS,
        consignedMarginMinor: undefined,
      });
    });

    const dash = await monthDash(s);

    // The current window fails closed on this row. The comparison window fell
    // through to the live vehicle and produced a confident number, so a period
    // that CANNOT be totalled was being compared against one that could.
    expect(dash.previousPeriod!.sales).toBeUndefined();
    expect(dash.previousPeriod!.netProfit).toBeUndefined();
    // And the incompleteness is published, not merely acted on internally.
    expect(dash.truncated.profit).toBe(true);
  });

  /**
   * The evidence requirement was decided by asking a set that only ever holds
   * the first 500 costed vehicles. Past that line the same deal stopped being
   * recognized as one needing frozen evidence, and the turnover fallback
   * published `salePrice − sourceCost` — the exact estimate this release exists
   * to stop publishing. A lot with 500 sales in the window is not exotic.
   */
  test("a deal past the costing cap is still held to the same evidence", async () => {
    const { s, saleId } = await financedDirectSale("s30DashTail", 18_000);
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(saleId)) as unknown as Record<string, unknown> & {
        vehicleId: Id<"vehicles">;
        saleDate: number;
      };
      const vehicle = (await ctx.db.get(sale.vehicleId)) as unknown as Record<string, unknown>;
      const { _id: _vid, _creationTime: _vct, ...vehicleFields } = vehicle;
      const { _id: _sid, _creationTime: _sct, ...saleFields } = sale;

      // 500 filler sales dated BEFORE it, so the index returns them first and
      // the deal under test lands at position 500 — one past the cap. They are
      // dealership-owned, priced at zero and costed at zero, so they contribute
      // nothing to either total and the only figure either assertion can be
      // reading is the deal itself.
      for (let i = 0; i < 500; i += 1) {
        const filler = await ctx.db.insert("vehicles", {
          ...vehicleFields,
          sourceType: "STOCK",
          sourceCost: 0,
          purchasePrice: 0,
          vin: `S30TAILVIN${String(i).padStart(4, "0")}`,
        } as never);
        await ctx.db.insert("sales", {
          ...saleFields,
          vehicleId: filler,
          saleDate: sale.saleDate - (500 - i) * 1_000,
          salePrice: 0,
          supplierSettlementRoute: undefined,
          consignedMarginMinor: undefined,
          consignedMarginCurrency: undefined,
        } as never);
      }

      // The state the fallback is reached from: no recorded earning at all.
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
    });

    // MONTH, deliberately, and not ALL_TIME: with no lower bound the query
    // reads `by_org` and orders by CREATION, which puts the deal under test
    // first and inside the cap however the fillers are dated. Only the dated
    // window uses `by_org_saleDate`, where the fillers precede it and it lands
    // at position 500. An earlier version of this test asserted against the
    // ALL_TIME shape and passed on unfixed code.
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "MONTH",
    })) as { salesTrend: Array<{ Revenue: number; Profit: number }> };

    const revenue = dash.salesTrend.reduce((sum, p) => sum + p.Revenue, 0);
    // Excluded, exactly as the same row is when it sits inside the cap.
    expect(revenue).toBe(0);
    // 20,000 − 15,000: the supplier's own money counted as the dealership's
    // turnover, which is what the tail path published.
    expect(revenue).not.toBe(5_000);
    // Seeding 1,000 rows to reach position 500 costs ~1s locally but exceeds
    // vitest's 5s default under CI's coverage instrumentation, where it timed
    // out. The cost is inherent to the boundary being pinned — the cap is 500,
    // so the deal has to sit past it — and cannot be reduced without testing a
    // different thing. An explicit budget rather than a faster, weaker test.
  }, 30_000);

  /**
   * Ranking is a comparison, and a comparison between a complete total and an
   * incomplete one has no meaning. This is the same defect already closed in
   * the salesperson report, on the tile the owner sees first.
   */
  test("a salesperson holding an unknown earning is not crowned on their partial total", async () => {
    const { s, saleId } = await financedDirectSale("s30TopPerf", 18_000);
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(saleId)) as unknown as Record<string, unknown> & {
        vehicleId: Id<"vehicles">;
        saleDate: number;
      };
      const vehicle = (await ctx.db.get(sale.vehicleId)) as unknown as Record<string, unknown>;
      const { _id: _vid, _creationTime: _vct, ...vehicleFields } = vehicle;
      const { _id: _sid, _creationTime: _sct, ...saleFields } = sale;

      const ownedSale = async (price: number, salespersonId: Id<"users">, tag: string) => {
        const v = await ctx.db.insert("vehicles", {
          ...vehicleFields,
          sourceType: "STOCK",
          sourceCost: 0,
          purchasePrice: 0,
          vin: `S30RANKVIN${tag}`,
        } as never);
        await ctx.db.insert("sales", {
          ...saleFields,
          vehicleId: v,
          salePrice: price,
          salespersonId,
          supplierSettlementRoute: undefined,
          consignedMarginMinor: undefined,
          consignedMarginCurrency: undefined,
        } as never);
      };

      // The deal user: 1,000 of complete earnings, plus one deal whose earning
      // cannot be established at all.
      await ownedSale(1_000, s.userId, "A");
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
      // The approver: 900, and every dinar of it accounted for.
      await ownedSale(900, s.approverId, "B");

      // The tile is drawn only for a role that may see people at all. The
      // file's default role does not carry it, so without this the whole block
      // is skipped and the assertion below passes against anything.
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, { permissions: [...role.permissions, "view:users"] });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      topPerformer: { name: string; revenue: number } | null;
      truncated: Record<string, boolean>;
      teamMembers?: unknown;
    };

    // 1,000 beat 900 and took the tile, on a total that omits an entire deal.
    // The honest winner is the one whose number is whole.
    expect(dash.topPerformer?.name).toBe("Approver");
    expect(dash.topPerformer?.revenue).toBe(900);
    // And the tile says it was drawn from a shortened field, so "best" is not
    // read as "best of everyone".
    expect(dash.truncated.topPerformer).toBe(true);
  });

  test("recalculating a commission whose supplier receipt was erased refuses, and changes nothing", async () => {
    // Approved AT the entitlement, so the honest commission is 0 and no accrual
    // was posted — which is exactly the state `recalculateCommission` exists to
    // repair, and therefore the state in which it is reachable at all.
    const { s, saleId } = await financedDirectSale("s30Erased", SUPPLIER_ENTITLEMENT);

    await s.t.run(async (ctx) => {
      // What `/admin`'s raw-JSON editor does to a completed sale, and what every
      // row written before this branch already looks like.
      //
      // The frozen MARGIN goes too, and that is the point of the test now.
      // Recalculation reads the recorded earning first and only falls back to
      // deriving one; erasing the receipt alone no longer leaves it with
      // nothing to go on, because the margin the sale recorded is a better
      // answer than anything re-derived from a live vehicle. This is the state
      // where there is genuinely no recorded earning at all.
      await ctx.db.patch(saleId, {
        consignedSupplierGrossReceiptMinor: undefined,
        consignedMarginMinor: undefined,
        commissionAmount: undefined,
      });
    });

    await expect(
      s.asUser.mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId })
    ).rejects.toThrow(/no usable record of what the dealership earned/i);

    // The refusal is only worth having if it left the row alone: a Convex
    // mutation that throws rolls back every write it made, so no commission was
    // invented and none of the ledger moved.
    const after = (await s.t.run((ctx) => ctx.db.get(saleId))) as {
      commissionAmount?: number;
    } | null;
    expect(after?.commissionAmount).toBeUndefined();
    // And specifically not 10% of `salePrice − cost`, which is what the
    // fallback produced: 500 of real payroll on a deal that earned nothing.
    expect(after?.commissionAmount).not.toBe(500);
  });

  test("but an erased RECEIPT alone is survivable, because the margin is the record", async () => {
    // The other side of the rule, and the reason the test above had to erase
    // both fields. The receipt is the input the margin was computed FROM; once
    // the margin exists, it is the recognized earning and the receipt is
    // history. Refusing here would strand a sale that has a perfectly good
    // record of what it earned.
    const { s, saleId } = await financedDirectSale("s30ErasedReceiptOnly", 18_000, {
      manualCommission: true,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedSupplierGrossReceiptMinor: undefined });
      const settings = (await ctx.db.query("orgSettings").collect()).find(
        (x) => x.orgId === s.orgId
      )!;
      await ctx.db.patch(settings._id, { commissionMode: "AUTO_MEMBER" });
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE });
    });

    await s.asUser.mutation(api.sales.recalculateCommission, {
      orgId: s.orgId,
      saleId,
    });

    const after = (await s.t.run((ctx) => ctx.db.get(saleId))) as unknown as {
      commissionAmount?: number;
    };
    expect(after.commissionAmount).toBe(300);
  });

  test("a cash direct sale with no recorded receipt still commissions on the sale price", async () => {
    // The control that keeps the refusal scoped. On a cash direct sale the buyer
    // hands the supplier the sale price himself, so an absent receipt is not
    // missing evidence — it is a legacy row, and `salePrice` is exactly what it
    // was posted on. This is the shape that must keep working untouched.
    // The rate is set AFTER completion, so the sale completes at a commission of
    // 0 and accrues nothing — which is the only state `recalculateCommission`
    // will act on, and the same state the financed case above is tested in.
    const s = await seedDealership("s30CashDirect");

    // Straight through sales.create rather than runDeal, which only builds
    // financed deals — and this is the one shape that must NOT be financed.
    const saleId = await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: VEHICLE_PRICE,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      financingType: "CASH" as const,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
    });
    // Completion records the receipt even here — on this route it IS the sale
    // price — so the legacy shape has to be produced deliberately.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId as never, {
        consignedSupplierGrossReceiptMinor: undefined,
        commissionAmount: undefined,
      });
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === s.orgId && m.userId === s.userId
      )!;
      await ctx.db.patch(membership._id, { commissionRate: RATE });
    });

    // Recalculation is the same entry point the financed case refuses. Here it
    // must succeed, on the sale price, because that is what the buyer paid him.
    await s.asUser.mutation(api.sales.recalculateCommission, {
      orgId: s.orgId,
      saleId: saleId as never,
    });

    const sale = (await s.t.run((ctx) => ctx.db.get(saleId as never))) as {
      commissionAmount?: number;
      financingType?: string;
    };
    expect(sale.financingType).toBe("CASH");
    // 10% of (20,000 − 15,000): the whole spread, because the whole spread
    // really did pass through the supplier.
    expect(sale.commissionAmount).toBe(500);
  });

  test("the sales report withholds the profit it cannot establish instead of publishing 5,000", async () => {
    const { s, saleId } = await financedDirectSale("s30ReportErased", 18_000);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });

    const row = report.sales.find((r: { _id: string }) => r._id === saleId)!;
    // UNKNOWN, and distinguishable from zero — a sale that earned nothing and a
    // sale whose earning is unknown are different answers to the owner.
    expect(row.netProfit).toBeNull();
    expect(row.recognizedRevenue).toBeNull();
    expect(row.netProfit).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);

    // Excluded from the totals rather than folded in at either value...
    expect(report.totalProfit).toBe(0);
    expect(report.totalRevenue).toBe(0);
    // ...and the exclusion is declared, so an understated total is never
    // presented as the complete picture.
    expect(report.unknownMarginSaleCount).toBe(1);
  });

  test("salesperson performance does not rank a rep on an earning nobody can substantiate", async () => {
    const { s, saleId } = await financedDirectSale("s30PerfErased", 18_000);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
    });

    const perf = await s.asUser.query(api.reports.getSalespersonPerformance, {
      orgId: s.orgId,
      ...range(),
    });

    const row = perf[0]!;
    expect(row.totalProfit).toBe(0);
    expect(row.totalProfit).not.toBe(VEHICLE_PRICE - SUPPLIER_ENTITLEMENT);
    expect(row.unknownMarginSaleCount).toBe(1);
    // The sale is still counted as sold — the rep did place the car. Only the
    // money is withheld.
    expect(row.vehiclesSold).toBe(1);
  });

  test("an intact financed direct sale is unaffected by any of this", async () => {
    // The whole point of the guard is that it fires on absence and nothing else.
    const { s } = await financedDirectSale("s30Intact", 18_000);

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });
    expect(report.totalProfit).toBe(3_000);
    expect(report.unknownMarginSaleCount).toBe(0);
  });
});

/**
 * SCRUM-30 — an advice that disagrees with the approval is evidence, not an error.
 *
 * The first attempt at enforcing "one payment, for the approved amount" REFUSED
 * a mismatched advice. That enforcement was correct about the invariant and
 * wrong about what to do with a violation of it, in a way that made the system
 * less safe than before:
 *
 *   - the approval is immutable once the deal is finalized — `finalizeDeal`
 *     closes the application and `approveDealerPurchaseAmount` refuses a closed
 *     one — so there was no legal way to make the two figures agree. An advice
 *     differing by a wire fee could never be recorded at all;
 *   - `supplierDisbursementConfirmedAt` therefore stayed absent, and that field
 *     is the ONLY thing stopping a sale being cancelled after the finance
 *     company has paid. So the refusal disarmed the guard it was meant to
 *     strengthen: the dealership knew the supplier had been paid, held no
 *     record saying so, and the sale stayed freely cancellable.
 *
 * The advice is now always recorded and a disagreement is recorded with it. The
 * approval is still immutable — nothing here edits it — and the supplier claim
 * raised against it does not move. What changes is that the contradiction is a
 * stored fact a human resolves, rather than a mutation that rolls back the
 * evidence of itself.
 */
describe("a settlement advice that contradicts the approval", () => {
  async function paidDeal(tag: string, approvedAmount: number) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: approvedAmount * SCALE,
      basis: "MANUAL",
      notes: `Approved at ${approvedAmount}.`,
    });
    const saleId = await s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
    });
    return { s, applicationId, saleId };
  }

  const cockpit = (s: Seeded, applicationId: string) =>
    s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });

  const appOf = (s: Seeded, applicationId: string) =>
    s.t.run((ctx) => ctx.db.get(applicationId as never)) as Promise<{
      supplierDisbursementConfirmedAt?: number;
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementStatus?: string;
      supplierDisbursementApprovedAtRecordingMinor?: number;
      approvedDealerPurchaseAmountMinor?: number;
    }>;

  test("is recorded rather than refused, and flagged for reconciliation", async () => {
    const { s, applicationId } = await paidDeal("s30Recon", 18_000);

    // 17,995 — the approved amount less a five-dinar wire fee. A real advice,
    // and one the deal can never be made to agree with, because the approval it
    // disagrees with is frozen.
    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });
    expect(result.status).toBe("REQUIRES_RECONCILIATION");

    const app = await appOf(s, applicationId);
    // The evidence survived. Before this, the mutation threw and Convex rolled
    // the write back, so nothing about the payment was recorded anywhere.
    expect(app.supplierDisbursedAmountMinor).toBe(17_995 * SCALE);
    expect(app.supplierDisbursementConfirmedAt).toBeDefined();
    expect(app.supplierDisbursementStatus).toBe("REQUIRES_RECONCILIATION");
    // Frozen beside it, so the discrepancy stays legible later.
    expect(app.supplierDisbursementApprovedAtRecordingMinor).toBe(18_000 * SCALE);

    // And the approval itself did NOT move. It is the basis the supplier claim,
    // the agency revenue and the commission were all measured from; recording
    // what was actually paid must not restate it.
    expect(app.approvedDealerPurchaseAmountMinor).toBe(18_000 * SCALE);
  });

  /**
   * The discrepancy has two halves and they do not carry the same permission.
   *
   * That there is an unresolved contradiction is a WORKFLOW condition: it says
   * this deal is waiting on a human, and hiding it produces exactly the dead
   * end the reconciliation state was invented to escape — a flag nobody is
   * shown is not a recovery path.
   *
   * What the finance company was approved to pay the supplier, what its advice
   * says it paid, the cheque number and the date are EVIDENCE, and they are the
   * same class of figure `money` exists to withhold. The default SALES template
   * carries `view:sales` and not `view:finance` precisely so a salesperson can
   * follow their own deal without learning what the dealership makes on it, and
   * `approvedMinor` is one subtraction away from that.
   *
   * The two permissions are also INDEPENDENT — roles here are customizable, so
   * an org can define a role holding `manage:finance` without `view:finance`.
   * The correction form must therefore key off the evidence it actually
   * received, never off the authority alone.
   */
  test("the reconciliation flag survives the finance gate; the evidence behind it does not", async () => {
    const { s, applicationId } = await paidDeal("s30ReconGate", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: role.permissions.filter((p) => p !== "view:finance"),
        isSystemOwnerRole: false,
      });
    });

    const view = await cockpit(s, applicationId);
    expect(view!.money).toBeNull();
    // Every figure, the cheque number and the date go with it.
    expect(view!.settlementAdviceDiscrepancy).toBeNull();
    // The condition is still visible — this deal is stuck and the screen says so.
    expect(view!.settlementAdviceRequiresReconciliation).toBe(true);
  });

  /**
   * The one push signal for the one blocking state this release introduces.
   *
   * It reused `application.created`, whose template reads "{actorName} submitted
   * a new finance application for {customerName}" — and `customerName` was never
   * supplied, so the renderer left the placeholder in the text. Managers were
   * told a new application had arrived, for a customer named `{customerName}`,
   * about a deal that had in fact frozen. Nothing in the message says
   * reconciliation, so the recovery path this state was invented to provide was
   * announced to nobody.
   *
   * The payload is the second half and the more serious one. `dispatch` stores
   * `data` on the row verbatim and `notifications.list` returns rows
   * unprojected, so `amount` — the settlement figure the cockpit gates behind
   * `view:finance` — was readable by every holder of `manage:users`, a
   * permission an org can grant an office administrator.
   */
  test("the people told about a frozen deal are told what froze, and nothing they may not see", async () => {
    const { s, applicationId } = await paidDeal("s30ReconNotify", 18_000);

    // A back-office role: manages people, has no business with the money.
    const clerkId = await s.t.run(async (ctx) => {
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "Office Admin",
        permissions: ["manage:users", "view:sales"],
      } as never);
      const userId = await ctx.db.insert("users", {
        clerkId: "s30ReconNotify_clerk",
        email: "s30ReconNotify.clerk@example.com",
        name: "Office Admin",
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });

    // Answers for the deal, is not allowed to see what it earns. A shape an org
    // can define, because these two permissions are independent.
    const financeOnlyId = await s.t.run(async (ctx) => {
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "Settlements",
        permissions: ["manage:finance", "view:sales"],
      } as never);
      const userId = await ctx.db.insert("users", {
        clerkId: "s30ReconNotify_fin",
        email: "s30ReconNotify.fin@example.com",
        name: "Settlements Officer",
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });

    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    const rows = await s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.orgId === s.orgId)
    );

    // Nobody selected on `manage:users` alone is told about somebody else's
    // settlement advice.
    expect(rows.filter((n) => n.userId === clerkId)).toHaveLength(0);

    // The boundary this actually has to hold. `manage:finance` and
    // `view:finance` are INDEPENDENT permissions and roles here are
    // customizable, so the person who can correct the advice is not necessarily
    // allowed to see its figures. They must still be told the deal is stuck —
    // and the row they receive must carry no evidence, because `dispatch`
    // stores `data` verbatim and `notifications.list` hands the row back
    // unprojected.
    const financeOnlyRows = rows.filter((n) => n.userId === financeOnlyId);
    expect(financeOnlyRows).toHaveLength(1);
    expect(financeOnlyRows[0].type).toBe("application.settlement_advice_discrepancy");
    const financeOnlyPayload = JSON.stringify(financeOnlyRows[0].data ?? {});
    for (const evidence of [
      String(17_995 * SCALE),
      String(18_000 * SCALE),
      "17995",
      "18000",
      "WIRE-4471",
    ]) {
      expect(financeOnlyPayload).not.toContain(evidence);
    }

    const notice = rows.find((n) => n.type === "application.settlement_advice_discrepancy");
    // Its own type, not `application.created` borrowed.
    expect(notice?.type).toBe("application.settlement_advice_discrepancy");
    const noticeType = notice!.type as string;

    const rendered = renderNotification("en", noticeType, notice!.data);
    // No placeholder survives, in either language.
    expect(rendered.title + rendered.message).not.toContain("{");
    expect(renderNotification("ar", noticeType, notice!.data).message).not.toContain("{");
    // And it says what happened, rather than announcing a new application.
    expect(rendered.message.toLowerCase()).toContain("reconcil");

    // The row itself, which is what a recipient's client actually receives.
    const stored = JSON.stringify(notice!.data ?? {});
    for (const evidence of [
      String(17_995 * SCALE),
      String(18_000 * SCALE),
      "17995",
      "18000",
      "WIRE-4471",
    ]) {
      expect(stored).not.toContain(evidence);
    }
  });

  /**
   * The other query that returns the same document.
   *
   * Round 4 gated `dealCockpit`, and gating one of two doors is not a gate.
   * `applications.get` authorizes on VIEW_SALES and spreads the whole
   * application — a query that predates this release, carrying settlement
   * fields that do not: `supplierDisbursedAmountMinor`,
   * `supplierDisbursementReference`, `supplierDisbursementStatus` and
   * `supplierDisbursementApprovedAtRecordingMinor` appear nowhere in
   * `origin/main`'s schema. The default SALES template holds `view:sales`
   * without `view:finance`, so it could read exactly what the cockpit withholds.
   */
  /**
   * A cancelled sale leaves its application CLOSED — `saleCancellation` never
   * touches `financeApplications` — so the application's own status cannot
   * answer whether the deal is still live. The cockpit already shows such a
   * deal as STOPPED; the mutation behind it did not know.
   */
  test("a disbursement on a cancelled deal is still recorded, but nobody is sent to reconcile it", async () => {
    const { s, applicationId } = await paidDeal("s30CancelledSettle", 18_000);

    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.query("sales").collect()).find((x) => x.orgId === s.orgId)!;
      await ctx.db.patch(sale._id, { status: "CANCELLED" });
    });

    // Disagrees with the approval, so on a LIVE deal this is precisely the case
    // that raises the reconciliation notice.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-DEAD",
    });

    // The payment is a fact about two other parties and it is written down.
    // Refusing would leave an operator unable to record money that really moved,
    // and `sales.update` will not cancel a sale whose disbursement is already
    // confirmed — so this order is the only one in which it can happen.
    const app = (await s.t.run((ctx) => ctx.db.get(applicationId as never))) as unknown as {
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementStatus?: string;
    };
    expect(app.supplierDisbursedAmountMinor).toBe(17_995 * SCALE);
    expect(app.supplierDisbursementStatus).toBe("REQUIRES_RECONCILIATION");

    // Nobody is told to go and RECONCILE it: nothing can be reconciled on a
    // cancelled deal, and the cockpit already renders it STOPPED.
    const all = await s.t.run(async (ctx) => await ctx.db.query("notifications").collect());
    expect(all.filter((n) => n.type === "application.settlement_advice_discrepancy")).toHaveLength(
      0
    );

    // But the exception still has an owner. Suppression alone left a payment
    // recorded outside any live deal with nobody told at all — the supplier has
    // been paid for a car whose sale was reversed and which may be back in
    // sellable inventory.
    const onCancelled = all.filter((n) => n.type === "application.payment_on_cancelled_deal");
    expect(onCancelled.length).toBeGreaterThan(0);
    const rendered = renderNotification("en", onCancelled[0].type as string, onCancelled[0].data);
    expect(rendered.title + rendered.message).not.toContain("{");
    expect(renderNotification("ar", onCancelled[0].type as string, onCancelled[0].data).message)
      .not.toContain("{");
    // Qualitative only — these recipients hold the finance ACTION permission,
    // which is independent of permission to see the figures.
    const payload = JSON.stringify(onCancelled[0].data ?? {});
    expect(payload).not.toContain(String(17_995 * SCALE));
    expect(payload).not.toContain("WIRE-DEAD");
  });

  test("the application query withholds settlement evidence from a caller who cannot see money", async () => {
    const { s, applicationId } = await paidDeal("s30GetGate", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        // Neither permission. Dropping `view:finance` alone is not this case —
        // the confirmation permission legitimately carries the workflow fields
        // (see the MANAGER test above), so a role that keeps it is a different
        // caller with a different, correct answer.
        permissions: role.permissions.filter(
          (p) => p !== "view:finance" && p !== "confirm:finance_disbursement"
        ),
        isSystemOwnerRole: false,
      });
    });

    const view = (await s.asUser.query(api.applications.get, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;

    // The premise: this caller can still read the application at all.
    expect(view).toBeTruthy();
    expect(view.status).toBe("CLOSED");

    for (const field of [
      "supplierDisbursedAmountMinor",
      "supplierDisbursementReference",
      "supplierDisbursementApprovedAtRecordingMinor",
      "approvedDealerPurchaseAmountMinor",
    ]) {
      expect(view[field]).toBeUndefined();
    }
    // The STATUS is deliberately still visible, and it carries no amount.
    // Hiding WHETHER a disbursement happened left this role reading "awaiting
    // supplier disbursement" on a deal the financier had already settled —
    // permanently, and contradicting `dealCockpit`, which tells the same caller
    // the advice needs reconciling.
    expect(view.supplierDisbursementStatus).toBe("REQUIRES_RECONCILIATION");
    // Its two former companions are NOT. This assertion used to require the
    // opposite: round 11 ungated all three together, and an external reviewer
    // spent four rounds pointing out that the workflow argument covers the
    // status only. The timestamp and the recorder answer no question this
    // caller has.
    expect(view.supplierDisbursementConfirmedAt).toBeUndefined();
    expect(view.supplierDisbursementConfirmedBy).toBeUndefined();
    // Nothing anywhere in the payload carries the figures either.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("WIRE-4471");
    expect(serialized).not.toContain(String(17_995 * SCALE));

    // The route is deliberately still visible: it says HOW the deal settles,
    // not what anyone was paid, and the people who work the deal need it.
    expect(view.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
  });

  /**
   * The gate has to distinguish EVIDENCE from WORKFLOW.
   *
   * The default MANAGER holds `confirm:finance_disbursement` and `view:sales`
   * but NOT `view:finance`. Withholding the approved amount and the "is one
   * already recorded" facts from that role protects nothing — it opens the
   * confirmation dialog with an empty amount so the figure is typed from
   * memory, leaves the confirm button showing on an already-paid deal, and
   * reports the deal as awaiting a disbursement the financier has made. A
   * mistyped figure then locks it in REQUIRES_RECONCILIATION, which only
   * `manage:finance` can repair. Worse than the disclosure it was avoiding, and
   * it discloses nothing new: MANAGER already holds `view:cost_price`.
   */
  test("a role that may confirm a disbursement can still see what it needs to confirm it", async () => {
    const { s, applicationId } = await paidDeal("s30ConfirmRole", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WIRE-OK",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications", "confirm:finance_disbursement"],
        isSystemOwnerRole: false,
      });
    });

    const view = (await s.asUser.query(api.applications.get, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;

    // What the screen runs on: the approved figure the confirmation dialog
    // prefills, and whether a disbursement is already recorded. Withholding
    // either is round 9's MANAGER trap.
    expect(view.approvedDealerPurchaseAmountMinor).toBe(18_000 * SCALE);
    expect(view.supplierDisbursementStatus).toBe("CONFIRMED");
    // What it does not need, and may not see.
    //
    // `supplierDisbursementConfirmedAt` was on the first list until this round.
    // The claim that the confirmation screen prefilled from it stopped being
    // true when the label, badge and button moved onto the status — both
    // reviewers enumerated the repo and found no client read of it or of
    // `…ConfirmedBy` at all. Evidence with no consumer belongs with the rest of
    // the evidence, behind VIEW_FINANCE.
    expect(view.supplierDisbursementConfirmedAt).toBeUndefined();
    expect(view.supplierDisbursementConfirmedBy).toBeUndefined();
    expect(view.supplierDisbursedAmountMinor).toBeUndefined();
    expect(view.supplierDisbursementReference).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("WIRE-OK");
  });

  /**
   * The third door. `financingEconomics.getEconomics` authorizes on
   * `view:finance_applications` — which the default SALES template holds — and
   * spread the whole application while redacting exactly one field. Gating the
   * cockpit and `applications.get` left the same evidence readable here by a
   * weaker role than the one that had just been closed.
   */
  test("the economics query answers the same question the same way", async () => {
    const { s, applicationId } = await paidDeal("s30EconGate", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      // A sales-shaped role: may see finance APPLICATIONS, may not see money.
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications"],
        isSystemOwnerRole: false,
      });
    });

    const economics = (await s.asUser.query(api.financingEconomics.getEconomics, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as { application: Record<string, unknown> };

    // The premise: this caller is still allowed to read the deal.
    expect(economics.application).toBeTruthy();

    for (const field of [
      "supplierDisbursedAmountMinor",
      "supplierDisbursementReference",
      "supplierDisbursementApprovedAtRecordingMinor",
      "approvedDealerPurchaseAmountMinor",
    ]) {
      expect(economics.application[field]).toBeUndefined();
    }
    const serialized = JSON.stringify(economics.application);
    expect(serialized).not.toContain("WIRE-4471");
    expect(serialized).not.toContain(String(17_995 * SCALE));
  });

  /**
   * The fourth door. `applications.list` authorizes on the same VIEW_SALES as
   * the detail query and spreads the whole document per row, so redacting the
   * detail endpoints while leaving the list open hands the same evidence to the
   * same caller one screen earlier.
   */
  test("the applications list redacts what the detail query redacts", async () => {
    const { s, applicationId } = await paidDeal("s30ListGate", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: role.permissions.filter(
          (p) => p !== "view:finance" && p !== "confirm:finance_disbursement"
        ),
        isSystemOwnerRole: false,
      });
    });

    const listed = (await s.asUser.query(api.applications.list, {
      orgId: s.orgId,
      paginationOpts: { numItems: 20, cursor: null },
    })) as unknown as { page: Array<Record<string, unknown>> };
    const rows = listed.page ?? [];

    // The premise: this caller still sees the deal in the list at all.
    expect(rows.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("WIRE-4471");
    expect(serialized).not.toContain(String(17_995 * SCALE));
    for (const row of rows) {
      expect(row.supplierDisbursedAmountMinor).toBeUndefined();
      expect(row.supplierDisbursementReference).toBeUndefined();
      expect(row.supplierDisbursementApprovedAtRecordingMinor).toBeUndefined();
      expect(row.approvedDealerPurchaseAmountMinor).toBeUndefined();
    }
  });

  /**
   * THE STRUCTURAL TEST — the one meant to end the door-by-door pattern.
   *
   * Six doors were found one at a time, each by a different reviewer pointing
   * at the next, because every test above pins ONE query's shape. This pins the
   * property instead: no exported query in the two application-facing modules
   * may hand settlement evidence to a caller holding only `view:sales` and
   * `view:finance_applications` — the default SALES template.
   *
   * It serializes the WHOLE response rather than one field of it. Both of the
   * last two doors hid inside nested arrays — `getEconomics.overrides`, where
   * the approval writer records the exact amount as a formatted string, and the
   * reconciliation queue's `page` — and the third-door test above could not see
   * either, because it serialized `economics.application` alone. A test scoped
   * to the field you already thought of cannot find the door you did not.
   *
   * The approved amount is deliberately an odd figure. A round 18,000 collides
   * with the quotation and the vehicle price, so a leak would be indistinguishable
   * from a legitimate figure and the assertion would be worthless.
   */
  test("no exported query hands settlement evidence to a sales-only caller", async () => {
    // Two approvals, not one. `recordOverride` fires only when an approval
    // MATERIALLY CHANGES, so a singly-approved deal has an empty override
    // history and `getEconomics` would return an empty array — a door with
    // nothing behind it. The anti-vacuity guard below caught exactly that on
    // the first run of this test.
    //
    // Be precise about what that buys, because it is easy to overclaim: the
    // override carries the approved amount, which is TIER 2, and tier 2 is
    // asserted nowhere in this test because it is not a boundary — see the
    // characterization test below and SCRUM-35. What the populated history
    // buys here is that `getEconomics` is exercised with a non-empty nested
    // array at all, so the TIER 1 scan below is searching a realistic payload
    // rather than an empty one.
    const FIRST_APPROVED = 18_437;
    const SECOND_APPROVED = 18_902;
    const DISBURSED = 17_995;

    const s = await seedDealership("s30AllDoors");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    // Recorded BEFORE the handover, which is the only order the product allows
    // now that the vehicle going out seals the approved amount — and the order
    // an operator would have had to follow anyway. The two approvals are here
    // to populate an override history, not to assert that a post-handover
    // correction is legal; that one is refused, and proved refused elsewhere.
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER",
      finalize: false,
      beforeHandover: async (id) => {
        await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: s.orgId,
          applicationId: id,
          submittedQuotationMinor: VEHICLE_PRICE * SCALE,
          source: "MANUAL_ENTRY",
        });
        for (const amount of [FIRST_APPROVED, SECOND_APPROVED]) {
          await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
            orgId: s.orgId,
            applicationId: id,
            approvedAmountMinor: amount * SCALE,
            basis: "MANUAL",
            notes: `Approved at ${amount}.`,
          });
        }
      },
    });
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: DISBURSED * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      // The queue returns flagged deals only, and an unflagged deal would make
      // this assertion vacuous for exactly the door it is here to cover.
      await ctx.db.patch(applicationId as never, {
        needsFinancingReconciliation: true,
        financingReconciliationReason: "Flagged so the queue actually returns this deal.",
      } as never);
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        // `register:vehicle_handover` is in here because the DEFAULT SALES
        // template holds it — this fixture is meant to be a salesperson, and a
        // salesperson hands vehicles over. It also keeps `handoverStamp`
        // reachable, so the scan below covers the token rather than skipping
        // the one door whose first version leaked the approved amount outright.
        permissions: ["view:sales", "view:finance_applications", "register:vehicle_handover"],
        isSystemOwnerRole: false,
      });
    });

    const paginationOpts = { numItems: 20, cursor: null };
    const listed = (await s.asUser.query(api.applications.list, {
      orgId: s.orgId,
      paginationOpts,
    })) as unknown as { page: unknown[] };
    const detail = await s.asUser.query(api.applications.get, { orgId: s.orgId, applicationId });
    const cockpitView = await cockpit(s, applicationId);
    const log = await s.asUser.query(api.applications.getLog, { orgId: s.orgId, applicationId });
    const handoverToken = await s.asUser.query(api.applications.handoverStamp, {
      orgId: s.orgId,
      applicationId,
    });
    const economics = (await s.asUser.query(api.financingEconomics.getEconomics, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as { application: unknown; overrides: unknown[] };
    const queue = (await s.asUser.query(api.financingEconomics.listNeedingReconciliation, {
      orgId: s.orgId,
      paginationOpts,
    })) as unknown as { page: unknown[] };
    const quotation = await s.asUser.query(
      api.financingEconomics.suggestQuotationForApplication,
      { orgId: s.orgId, applicationId }
    );

    // ANTI-VACUITY. Every door must have actually returned this deal. An empty
    // page or a null document contains no evidence for the trivial reason, and
    // would let this test pass while proving nothing at all.
    expect(listed.page.length).toBeGreaterThan(0);
    expect(detail).toBeTruthy();
    expect(cockpitView).toBeTruthy();
    expect(economics.application).toBeTruthy();
    expect(economics.overrides.length).toBeGreaterThan(0);
    expect(queue.page.length).toBeGreaterThan(0);

    const suggestion = await s.asUser.query(api.financingEconomics.suggestQuotation, {
      orgId: s.orgId,
      companyId: s.companyId,
      targetSellingAmountMinor: VEHICLE_PRICE * SCALE,
      estimatedDealerBorneExpensesMinor: 0,
      customerFirstPaymentMinor: 0,
    });

    const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) {
        for (const item of value) keysOf(item, into);
      } else if (value !== null && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          into.add(key);
          keysOf(nested, into);
        }
      }
      return into;
    };

    const doors: Array<[string, unknown]> = [
      ["applications.list", listed],
      ["applications.get", detail],
      ["applications.dealCockpit", cockpitView],
      ["applications.getLog", log],
      // The handover stamp. It is issued from the UNREDACTED row and served to
      // any caller who may hand over, so it is exactly the kind of door this
      // scan exists for — and the first version of it did leak: the token
      // spelled out the approved amount and its split. It is a revision
      // counter now, and this asserts that rather than trusting the comment.
      ["applications.handoverStamp", handoverToken],
      ["financingEconomics.getEconomics", economics],
      ["financingEconomics.listNeedingReconciliation", queue],
      ["financingEconomics.suggestQuotationForApplication", quotation],
      ["financingEconomics.suggestQuotation", suggestion],
    ];

    // COMPLETENESS, enforced rather than asserted in a comment. The list above
    // is hand-written, so on its own it proves nothing about a query added
    // tomorrow — it would simply not be covered, and this test would stay green
    // while the new door leaked. Deriving the expected set from the modules
    // themselves turns that silent gap into a failure.
    // Enumerated from the REGISTERED FUNCTIONS, not from the source text.
    //
    // An earlier version regex-matched `^export const NAME = query(` and
    // cross-checked it against a count of `query({` call sites. A review
    // demonstrated that guard was weaker than its own comment: a query built
    // through a wrapper factory (`export const x = orgScopedQuery({...})`)
    // produces neither a named match NOR a call site, so the counts agreed and
    // the door passed unnoticed — precisely the silent gap the guard existed to
    // close. It also tripped on `query({` appearing inside a comment or a
    // string, and these are two of the most prose-dense modules in the repo, so
    // it would have cried wolf until somebody deleted it.
    //
    // Convex stamps `isQuery` and `isPublic` on every registered function, so
    // asking the module what it exports is exact and form-independent: it sees
    // factories, re-exports and any future wrapper, and it cannot see prose.
    // (`api` itself is `anyApi`, a non-enumerable proxy, so enumerating
    // `api.applications` would NOT work — this reads the modules directly.)
    const publicQueriesOf = (module: string, mod: Record<string, unknown>) =>
      Object.entries(mod)
        .filter(([, value]) => {
          const fn = value as { isQuery?: boolean; isPublic?: boolean } | null;
          return fn?.isQuery === true && fn?.isPublic === true;
        })
        .map(([name]) => `${module}.${name}`);

    const mustCover = [
      ...publicQueriesOf("applications", applicationsModule),
      ...publicQueriesOf("financingEconomics", financingEconomicsModule),
    ].sort();

    // Anti-vacuity for the enumeration itself: if the markers ever stop being
    // set, every filter returns nothing and this test would assert an empty
    // list against an empty list while covering nothing at all.
    expect(mustCover.length).toBeGreaterThanOrEqual(doors.length);
    expect(doors.map(([name]) => name).sort()).toEqual(mustCover);

    for (const [name, response] of doors) {
      // Prefixed with the query name so a failure names the door rather than
      // making the next reader diff two anonymous JSON blobs.
      const serialized = `${name} → ${JSON.stringify(response ?? null)}`;
      expect(serialized).not.toContain("WIRE-4471");
      expect(serialized).not.toContain(String(DISBURSED * SCALE));

      // Value scanning alone is weaker than it looks: a leak rendered in major
      // units (`17995`) or formatted (`17,995.000`) walks straight past a
      // substring check, and the third tier-1 field cannot be value-scanned at
      // all because its value equals the derivable tier-2 approval.
      //
      // Key absence covers all three and is representation-independent —
      // `JSON.stringify` drops undefined-valued keys, so a redacted field is
      // gone from the payload entirely rather than present and blank.
      //
      // Walked as real keys rather than searched as text: a response whose
      // VALUE happens to equal a field name produces the same quoted substring
      // and would raise a false alarm, and a guard that cries wolf gets
      // deleted. Recursive, because every door found after the first hid its
      // payload inside a nested array.
      for (const field of [
        "supplierDisbursementReference",
        "supplierDisbursedAmountMinor",
        "supplierDisbursementApprovedAtRecordingMinor",
        // Added when these two moved behind VIEW_FINANCE. The whole
        // point of this sweep is that a new gated class gets asserted on EVERY
        // door rather than on the one it was fixed in — without these names the
        // new gate was pinned only against `applications.get`, and dropping
        // `redactSettlementEvidence` from `list` or `getEconomics` would have
        // left this test green.
        "supplierDisbursementConfirmedAt",
        "supplierDisbursementConfirmedBy",
      ]) {
        expect(`${name} exposes ${field}: ${keysOf(response).has(field)}`).toBe(
          `${name} exposes ${field}: false`
        );
      }
    }
  });

  /**
   * A CHARACTERIZATION test. It pins what is true today, not what ought to be.
   *
   * `redactSettlementEvidence` blanks `approvedDealerPurchaseAmountMinor` for a
   * caller without finance permissions, and the comments around it used to read
   * as though that closed something. It does not: the same caller recovers the
   * figure from `applications.list` alone. This asserts that reality so nobody
   * infers a boundary from the presence of the gate.
   *
   * ⚠️ WHEN SCRUM-35 IS DONE THIS TEST MUST FAIL, and that failure is the point
   * — it is what forces the decision to be made deliberately. Do not "repair"
   * it by closing only the override history and the reconciliation queue: both
   * derivations below live in a query that already applies the redaction, so
   * that repair would leave this test passing and the exposure intact.
   */
  test("the approved amount is NOT confidential today — a sales-only caller derives it", async () => {
    const APPROVED = 18_437;
    const { s, applicationId } = await paidDeal("s30Tier2Characterize", APPROVED);
    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications"],
        isSystemOwnerRole: false,
      });
    });

    const listed = (await s.asUser.query(api.applications.list, {
      orgId: s.orgId,
      paginationOpts: { numItems: 20, cursor: null },
    })) as unknown as { page: Array<Record<string, unknown>> };
    const row = listed.page.find((r) => r._id === applicationId)!;
    expect(row).toBeTruthy();

    // The gate itself works — the field really is blanked.
    expect(row.approvedDealerPurchaseAmountMinor).toBeUndefined();

    // ...and the number is right there anyway, twice.
    //
    // 1. The funded portion and the LTV travel together, so the approval is one
    //    division away. At 100% LTV, which this fixture uses, they are equal.
    const funded = row.financeCompanyFundedPortionMinor as number;
    const ltv = row.appliedLtvPercent as number;
    expect(Math.round(funded / (ltv / 100))).toBe(APPROVED * SCALE);

    // 2. And the approval notes record it as free text.
    expect(String(row.approvedPurchaseNotes)).toContain(String(APPROVED));
  });

  /**
   * WHETHER, without WHEN or WHO.
   *
   * Round 11 ungated all three tier-3 fields together, on the reasoning that
   * hiding "whether the supplier was paid" created a workflow dead-end: a
   * settled deal read "awaiting supplier disbursement" forever. That reasoning
   * was right about the STATUS and wrong about the other two. The dead-end is
   * solved by `supplierDisbursementStatus` alone — its presence is the whole
   * signal, since it is written only when an advice is recorded. The exact
   * payment timestamp and the identity of the person who recorded it answer no
   * workflow question a sales caller has; they are settlement-evidence
   * metadata, and they sat beside a deliberately public field for four rounds.
   *
   * The two consumers that branched on the timestamp — the status label and the
   * paid badge — now read the status, so the dead-end stays closed with the
   * metadata gated.
   */
  test("a sales-only caller learns THAT the supplier was paid, not when or by whom", async () => {
    const { s, applicationId } = await paidDeal("s30WhetherOnly", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications"],
        isSystemOwnerRole: false,
      });
    });

    const detail = (await s.asUser.query(api.applications.get, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    expect(detail).toBeTruthy();

    // THE WORKFLOW HALF — truthful, and the reason the dead-end stays closed.
    // Without this the screen would say "awaiting supplier disbursement" on a
    // deal the financier has already settled, with no state that ever clears.
    expect(detail.supplierDisbursementStatus).toBe("CONFIRMED");

    // THE EVIDENCE HALF — absent. Checked as keys, because Convex drops
    // undefined-valued keys on the wire, so a gated field is gone rather than
    // present and blank.
    for (const field of [
      "supplierDisbursementConfirmedAt",
      "supplierDisbursementConfirmedBy",
      "supplierDisbursementReference",
      "supplierDisbursedAmountMinor",
      "supplierDisbursementApprovedAtRecordingMinor",
    ]) {
      expect(`${field}: ${Object.hasOwn(detail, field)}`).toBe(`${field}: false`);
    }
  });

  /**
   * The legacy shape the schema documents, which the gate above nearly broke.
   *
   * `supplierDisbursementStatus` post-dates these rows, so it is legitimately
   * absent on an advice that really was recorded.
   * `amendSupplierDisbursementAdvice` treats absence the same way with
   * `?? "CONFIRMED"`, and `sales.ts` is deliberately defensive about the mirror
   * shape (an amount with no date).
   *
   * ⚠️ Absence means an advice is ON FILE — NOT that its amount agreed with the
   * approval. The schema used to claim those rows "could only be written when
   * the amounts matched"; that claim was false and has been removed. What this
   * test pins is the DISPLAY behaviour below, not any assertion of agreement.
   *
   * Moving the label, the badge and the confirm button onto the status alone
   * therefore handed exactly that row a permanent "awaiting supplier
   * disbursement", a hidden paid badge, and a confirm button that reappears and
   * throws against the server's `confirmedAt` guard — rounds 9 and 10 both
   * resurrected, for every role including OWNER. So the helper now normalizes
   * what it publishes on the one boundary that already decides what "paid"
   * means, rather than leaving three consumers to each rediscover it.
   */
  test("an advice recorded before the status field existed still reads as paid", async () => {
    const { s, applicationId } = await paidDeal("s30LegacyStatus", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WIRE-4471",
    });

    await s.t.run(async (ctx) => {
      // The legacy row: the advice is recorded, the status field is not.
      await ctx.db.patch(applicationId as never, {
        supplierDisbursementStatus: undefined,
      } as never);
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications"],
        isSystemOwnerRole: false,
      });
    });

    const detail = (await s.asUser.query(api.applications.get, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;

    // Reads as paid, so the label, the badge and the button all behave — while
    // the evidence stays gated exactly as it is on a modern row.
    expect(detail.supplierDisbursementStatus).toBe("CONFIRMED");
    expect(detail.supplierDisbursementConfirmedAt).toBeUndefined();
    expect(detail.supplierDisbursementReference).toBeUndefined();
  });

  test("and the same query gives a finance-permitted caller the evidence in full", async () => {
    const { s, applicationId } = await paidDeal("s30GetGateAllowed", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    const view = (await s.asUser.query(api.applications.get, {
      orgId: s.orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;

    expect(view.supplierDisbursedAmountMinor).toBe(17_995 * SCALE);
    expect(view.supplierDisbursementReference).toBe("WIRE-4471");
    expect(view.approvedDealerPurchaseAmountMinor).toBe(18_000 * SCALE);
    // The other half of the gate, and the reason this assertion exists: the
    // tests above prove the timestamp and recorder are withheld from a sales
    // caller and from a confirm-only caller. Without this one, tightening the
    // gate until NOBODY receives them would pass the whole suite. A boundary
    // needs pinning on both sides or it only ever moves one way.
    expect(view.supplierDisbursementConfirmedAt).toBeDefined();
    expect(view.supplierDisbursementConfirmedBy).toBeDefined();
  });

  test("and a role holding view:finance receives the evidence in full", async () => {
    const { s, applicationId } = await paidDeal("s30ReconGateAllowed", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    const view = await cockpit(s, applicationId);
    expect(view!.settlementAdviceRequiresReconciliation).toBe(true);
    expect(view!.settlementAdviceDiscrepancy).toEqual({
      recordedMinor: 17_995 * SCALE,
      approvedMinor: 18_000 * SCALE,
      currency: "JOD",
      recordedReference: "WIRE-4471",
      recordedAt: expect.any(Number),
    });
  });

  test("the supplier claim is untouched by the disagreement", async () => {
    const { s, applicationId } = await paidDeal("s30ReconClaim", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
    });

    // Still 18,000 − 15,000. The claim was accrued at finalization against the
    // approval, and an unresolved contradiction is not authority to restate it.
    const rows = await supplierClaimsOf(s);
    const live = rows.find((r) => r.status !== "CANCELLED");
    expect(live?.amountDue).toBe(3_000);
  });

  /**
   * The completeness predicate must answer to the reconciliation STATE, not to
   * the arithmetic between the two figures.
   *
   * Every mismatch recorded before this one was an advice BELOW the approval,
   * where `disbursed >= approved` happened to be false — so the deal stayed
   * open by accident of the comparison rather than because anybody decided a
   * contradicted advice cannot settle a deal. An advice ABOVE the approval
   * exposed that: 20,000 against an 18,000 approval was stored, flagged
   * REQUIRES_RECONCILIATION, and satisfied `>=` in the same breath — so the
   * cockpit showed the settlement stage COMPLETE and published the headline as
   * ACTUAL rather than ESTIMATED, on a deal whose whole point was that the
   * dealership does not yet know how much money the supplier is holding.
   *
   * Note what is NOT asserted: that the financier still owes money. It does
   * not — it sent too much. The honest answer is that the obligation is
   * UNKNOWN, and `settlementIsComplete` already treats UNKNOWN as not-done.
   */
  test("an advice larger than the approval cannot carry the deal to a settled state", async () => {
    const { s, applicationId } = await paidDeal("s30ReconOver", 18_000);

    // The cheque was written for the quotation, not the approval. Nothing
    // refuses it — it is evidence about a payment somebody made.
    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 20_000 * SCALE,
    });
    expect(result.status).toBe("REQUIRES_RECONCILIATION");

    // Collect the dealership's 3,000 claim, so the ONLY thing left standing
    // between this deal and "settled" is the contradicted advice.
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: 3_000,
    });

    const view = await cockpit(s, applicationId);
    expect(view!.stages.find((st) => st.key === "SETTLEMENT")!.state).not.toBe("COMPLETE");
    const profit = view!.money!.managementProfit;
    // Still an estimate. Promoting it to ACTUAL asserts the money is finished.
    expect(profit.available && profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  /**
   * The other half of the same rule, and the reason it is a state check rather
   * than an equality check: correcting the advice back into agreement has to
   * RELEASE the deal. A predicate that blocks on the contradiction but never
   * clears it would trade a false completion for a permanent dead end, which is
   * the failure this whole reconciliation path was built to escape.
   */
  test("and correcting the advice back to the approval releases it", async () => {
    const { s, applicationId } = await paidDeal("s30ReconOverFixed", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 20_000 * SCALE,
    });
    const claim = (await supplierClaimsOf(s)).find((row) => row.status !== "CANCELLED")!;
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: claim._id,
      amount: 3_000,
    });

    await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reason: "Advice re-read: the cheque was for the approved amount after all.",
    });

    const view = await cockpit(s, applicationId);
    expect(view!.stages.find((st) => st.key === "SETTLEMENT")!.state).toBe("COMPLETE");
  });

  test("locks cancellation, which the refusal had left wide open", async () => {
    const { s, applicationId, saleId } = await paidDeal("s30ReconCancel", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
    });

    // The whole point. The finance company has demonstrably paid the supplier;
    // that the amount is disputed is a question about how much, never about
    // whether. Cancelling here would reverse a funded sale.
    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleId as never,
        status: "CANCELLED",
      })
    ).rejects.toThrow(/already paid the supplier/i);
  });

  test("a funded deal cannot be cancelled even when recording its advice was rejected", async () => {
    // The hole the refusal opened, reproduced in the shape it actually had.
    //
    // The recording attempt is allowed to fail here on purpose: under the old
    // guard it DID fail, and the point is what the system permitted afterwards.
    // Refusing the advice left `supplierDisbursementConfirmedAt` unset, and that
    // field was the only thing standing between a funded sale and cancellation
    // — so the dealership knew the finance company had paid the supplier, held
    // no record saying so, and let the sale be reversed anyway.
    //
    // This assertion is era-independent: it does not care whether recording
    // succeeded, only that a deal the company has paid on cannot be cancelled.
    const { s, applicationId, saleId } = await paidDeal("s30ReconHole", 18_000);
    try {
      await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 17_995 * SCALE,
        reference: "WIRE-4471",
      });
    } catch {
      // Old behavior. Deliberately swallowed — see above.
    }

    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleId as never,
        status: "CANCELLED",
      })
    ).rejects.toThrow(/already paid the supplier/i);

    // And the sale is genuinely still live, rather than merely having thrown.
    const sale = (await s.t.run((ctx) => ctx.db.get(saleId as never))) as { status: string };
    expect(sale.status).toBe("COMPLETED");
  });

  test("cancelling the APPLICATION is locked by the same evidence", async () => {
    // `sales.update` is not the only door to a reversal. `cancelApplication`
    // unwinds the sale, the vehicle, the deposits and the posted accounting
    // records, and it carried its own copy of the same timestamp-only check —
    // so closing one door and not the other would leave the reversal reachable
    // by a route nobody was looking at.
    const { s, applicationId } = await paidDeal("s30ReconCancelApp", 18_000);
    try {
      await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 17_995 * SCALE,
      });
    } catch {
      // Old behavior; the assertion below is what matters either way.
    }

    await expect(
      s.asUser.mutation(api.applications.cancelApplication, {
        orgId: s.orgId,
        applicationId,
        reason: "Trying to unwind a deal the company has already funded.",
      })
    ).rejects.toThrow(/already paid the supplier/i);

    // And the cockpit says so, rather than leaving the deal stuck in a state
    // nobody can see it is in.
    const view = await cockpit(s, applicationId);
    expect(view!.settlementAdviceDiscrepancy).not.toBeNull();
    expect(view!.settlementAdviceDiscrepancy!.recordedMinor).toBe(17_995 * SCALE);
    expect(view!.settlementAdviceDiscrepancy!.approvedMinor).toBe(18_000 * SCALE);
  });

  test("an agreeing advice is confirmed outright and still locks cancellation", async () => {
    const { s, applicationId, saleId } = await paidDeal("s30ReconExact", 18_000);
    const result = await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
    });
    expect(result.status).toBe("CONFIRMED");

    const app = await appOf(s, applicationId);
    expect(app.supplierDisbursementStatus).toBe("CONFIRMED");
    // Not written when there is nothing to reconcile.
    expect(app.supplierDisbursementApprovedAtRecordingMinor).toBeUndefined();

    await expect(
      s.asApprover.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleId as never,
        status: "CANCELLED",
      })
    ).rejects.toThrow(/already paid the supplier/i);
  });

  test("a mistyped advice can be corrected, and the correction clears the flag", async () => {
    const { s, applicationId } = await paidDeal("s30ReconAmend", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
    });

    // The operator transposed two digits; the company really did pay the
    // approved amount. Correcting the TRANSCRIPTION is legitimate and is the
    // only restatement this deal allows.
    const amended = await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WIRE-4471",
      reason: "Advice re-read: the amount was transposed on entry.",
    });
    expect(amended.status).toBe("CONFIRMED");

    const app = await appOf(s, applicationId);
    expect(app.supplierDisbursedAmountMinor).toBe(18_000 * SCALE);
    expect(app.supplierDisbursementStatus).toBe("CONFIRMED");
    expect(app.supplierDisbursementApprovedAtRecordingMinor).toBeUndefined();
    // Still never the approval.
    expect(app.approvedDealerPurchaseAmountMinor).toBe(18_000 * SCALE);
  });

  test("a correction that still disagrees stays flagged rather than being accepted", async () => {
    const { s, applicationId } = await paidDeal("s30ReconAmendStill", 18_000);
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
    });

    // The reconciliation state is DERIVED from the evidence every time, so an
    // amendment is not a way to declare the discrepancy resolved.
    const amended = await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_990 * SCALE,
      reason: "Advice re-read: the fee was ten, not five.",
    });
    expect(amended.status).toBe("REQUIRES_RECONCILIATION");
    expect((await appOf(s, applicationId)).supplierDisbursementStatus).toBe(
      "REQUIRES_RECONCILIATION"
    );
  });

  test("an amendment must say why, and cannot invent an advice that was never recorded", async () => {
    const { s, applicationId } = await paidDeal("s30ReconAmendGuards", 18_000);

    // Nothing recorded yet: there is no transcription to correct.
    await expect(
      s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 18_000 * SCALE,
        reason: "Trying to record a payment through the correction door.",
      })
    ).rejects.toThrow(/no recorded settlement advice/i);

    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
    });

    // An amendment with no stated cause is indistinguishable from someone
    // making the discrepancy go away.
    await expect(
      s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 18_000 * SCALE,
        reason: "fix",
      })
    ).rejects.toThrow(/why the recorded advice was wrong/i);
  });
});

/**
 * SCRUM-30 — correcting one field of an advice must not erase the others.
 *
 * The amendment path exists to PRESERVE evidence about a payment somebody else
 * made. Its first implementation destroyed some of it: the dialog opened with
 * an empty reference and today's date regardless of what was recorded, and sent
 * both on every submit. An operator fixing a transposed amount therefore also
 * wiped the cheque number and moved the payment date to whenever they happened
 * to notice — on the one screen whose entire purpose is to keep that record
 * straight, and with no indication that anything but the amount had changed.
 *
 * Both halves are closed and both are pinned here: the server preserves what it
 * is not given, and the cockpit hands the dialog the recorded values to prefill
 * (`convex/applications.ts` returns them on `settlementAdviceDiscrepancy`;
 * the rendered half is pinned in DealCockpitView.test.tsx).
 */
describe("amending one field of a settlement advice", () => {
  /**
   * Deliberately NOT midnight, and carrying milliseconds.
   *
   * `confirmSupplierDisbursement` stamps `Date.now()`, so this is the shape a
   * real recorded advice has. A midnight fixture made every assertion about
   * "the date survived" pass under a conversion that silently discards the time
   * of day — which is exactly what the correction form was doing to it.
   */
  const PAID_AT = Date.UTC(2026, 7, 5, 14, 32, 17, 456);

  async function advisedDeal(tag: string) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: 18_000 * SCALE,
      basis: "MANUAL",
      notes: "Approved at 18,000.",
    });
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    // The advice as it actually arrived: wrong amount, but a real cheque number
    // and a real date, both of which are the evidence.
    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 17_995 * SCALE,
      reference: "WIRE-4471",
      disbursedAt: PAID_AT,
    });
    return { s, applicationId };
  }

  const appOf = (s: Seeded, applicationId: string) =>
    s.t.run((ctx) => ctx.db.get(applicationId as never)) as Promise<{
      supplierDisbursedAmountMinor?: number;
      supplierDisbursementReference?: string;
      supplierDisbursementConfirmedAt?: number;
      supplierDisbursementStatus?: string;
    }>;

  test("correcting only the amount leaves the reference and the date untouched", async () => {
    const { s, applicationId } = await advisedDeal("s30Preserve");
    const before = await appOf(s, applicationId);

    await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reason: "Advice re-read: the amount was transposed on entry.",
    });

    const app = await appOf(s, applicationId);
    expect(app.supplierDisbursedAmountMinor).toBe(18_000 * SCALE);
    // The two that were never mentioned. Erasing WIRE-4471 destroys the only
    // link between this row and the bank's own record of the payment.
    expect(app.supplierDisbursementReference).toBe("WIRE-4471");
    // To the MILLISECOND, and asserted against what was actually on the row
    // rather than against the constant it was seeded from. Same instant, not
    // "same day" and not "same hour" — a lossy conversion that lands on the
    // right date would satisfy a looser assertion, and one did: the correction
    // form was rewriting 14:32:17.456 to 00:00:00.000 and every test that
    // watched the date agreed the date was preserved.
    expect(app.supplierDisbursementConfirmedAt).toBe(before.supplierDisbursementConfirmedAt);
    expect(app.supplierDisbursementConfirmedAt).toBe(PAID_AT);
    // And the correction did its job.
    expect(app.supplierDisbursementStatus).toBe("CONFIRMED");
  });

  test("the reference and the date can still be corrected when they are given", async () => {
    // The control. Preserving what is omitted must not become refusing to
    // change what is supplied — the operator who mistyped the cheque number
    // needs this path as much as the one who mistyped the amount.
    const { s, applicationId } = await advisedDeal("s30PreserveControl");
    const correctedAt = Date.UTC(2026, 7, 6);

    await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WIRE-4472",
      disbursedAt: correctedAt,
      reason: "Advice re-read: wrong cheque number and date were entered.",
    });

    const app = await appOf(s, applicationId);
    expect(app.supplierDisbursementReference).toBe("WIRE-4472");
    expect(app.supplierDisbursementConfirmedAt).toBe(correctedAt);
  });

  test("the cockpit hands the dialog what is recorded, so it can prefill it", async () => {
    // The dialog cannot preserve what it is never told. The first version of
    // this payload carried only the two amounts, which is why the correction
    // form opened blank on the reference and on today's date.
    const { s, applicationId } = await advisedDeal("s30PreservePayload");

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
    expect(view!.settlementAdviceDiscrepancy).not.toBeNull();
    expect(view!.settlementAdviceDiscrepancy!.recordedReference).toBe("WIRE-4471");
    expect(view!.settlementAdviceDiscrepancy!.recordedAt).toBe(PAID_AT);
  });
});

/**
 * Round 8. Every surface answers the SAME question about one sale.
 *
 * Round 7 made the dashboard's evidence rule independent of the vehicle so it
 * would survive the costing cap. That fixed the tail and broke the middle: the
 * dashboard stopped asking what `saleEconomics` asks, and `saleEconomics` is
 * what the sales report, the supplier claim and the P&L all use. Being
 * cap-independent was never the goal. Being the SAME rule everywhere is.
 *
 * What these tests pin: the vehicle is authoritative when it is known, and the
 * sale's own frozen evidence answers only when the vehicle is not.
 */
describe("one recognized-earning rule, asked identically by every surface", () => {
  const range = () => ({ startDate: Date.now() - 86_400_000, endDate: Date.now() + 86_400_000 });

  /** The canonical financed-direct deal: 20,000 sale, 15,000 entitlement, 18,000 approved. */
  async function financedDirectDeal(tag: string) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: 18_000 * SCALE,
      basis: "MANUAL",
      notes: "Approved at 18,000.",
    });
    const saleId = (await s.asUser.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId,
      applicationId,
    })) as never;
    return { s, saleId };
  }

  /**
   * A dealer-owned car carrying a settlement route left over from when it was
   * believed to be the supplier's.
   *
   * Every step is a shipped mutation. `sales.update` never re-normalises the
   * route when the vehicle's ownership changes, and the completion carries the
   * stored value into the COMPLETED row — so the finished sale is dealer-owned,
   * direct-routed and financed at once.
   */
  async function staleRouteOnOwnedStock(tag: string) {
    const s = await seedDealership(tag);
    const saleId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 20_000,
      saleDate: Date.now(),
      financingType: "CASH",
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
    } as never);

    // The car turns out to be the dealership's own. Permitted while unsold —
    // `retroactiveOwnershipChangeRefusal` keys on the sale status, and this one
    // is still PENDING. Converting to owned stock capitalizes the acquisition,
    // so it needs a payment method.
    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      sourceType: "STOCK",
      purchasePrice: 15_000,
      purchasePaymentMethod: "CASH",
    } as never);

    await s.asUser.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      financingType: "FINANCED",
    } as never);

    await s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId } as never);

    // The ranking tile is drawn only for a role that may see people at all, and
    // this file's default role does not carry it — without this the tile is
    // always null and the assertion about it proves nothing.
    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, { permissions: [...role.permissions, "view:users"] });
    });
    return { s, saleId };
  }

  test("a car the dealership owns is counted by the dashboard exactly as the report counts it", async () => {
    const { s } = await staleRouteOnOwnedStock("s30Stale");

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesVolumeThisMonth: number;
      truncated: { turnover: boolean; profit: boolean };
      topPerformer: { name: string } | null;
    };
    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });

    // The ledger took the owned-stock path and the report agrees with it. The
    // premise, asserted so this cannot pass by both being wrong together.
    expect(report.totalRevenue).toBe(20_000);
    expect(report.unknownMarginSaleCount).toBe(0);

    // The dashboard excluded the row entirely and called the rest complete.
    // Cross-surface equality is what actually pins the rule — a dashboard-only
    // assertion is exactly what let this through.
    expect(dash.salesVolumeThisMonth).toBe(report.totalRevenue);
    expect(dash.truncated.profit).toBe(false);
    // And its salesperson did not vanish from the ranking over a correct row.
    expect(dash.topPerformer).not.toBeNull();
  });

  /**
   * The same sale, in the comparison window instead of the current one.
   *
   * `vehicleKnown` was answered from a map populated only from CURRENT-window
   * sales, so every comparison-window sale looked like "vehicle unknown" and
   * that window silently kept the rule this change replaced. It errs closed —
   * the delta is withheld rather than wrong — but a correct owned-stock sale
   * suppressed the period comparison and marked the current month's exact
   * turnover "Partial". The rule has to hold in both windows or it is not the
   * same rule.
   */
  test("and it holds in the comparison window too, not only the current one", async () => {
    const { s } = await staleRouteOnOwnedStock("s30StalePrev");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.query("sales").collect()).find((x) => x.orgId === s.orgId)!;
      await ctx.db.patch(sale._id, { saleDate: Date.now() - 45 * 86_400_000 });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "MONTH",
    })) as {
      previousPeriod?: { sales?: number; netProfit?: number };
      truncated: { turnover: boolean; profit: boolean };
    };

    // The comparison window counted it, exactly as the report does.
    expect(dash.previousPeriod?.sales).toBe(20_000);
    // And nothing was withheld or marked partial over a row that is complete.
    expect(dash.truncated.turnover).toBe(false);
    expect(dash.truncated.profit).toBe(false);
  });

  /**
   * A viewer without profit permission is ranked on GROSS, and on that basis
   * nothing is unknown — every sale contributes its full price. Excluding a
   * salesperson there withholds a complete number for a reason that does not
   * apply, and the shipped SALES template is exactly this viewer.
   */
  test("a gross-basis viewer ranks on gross, where no earning is unknown", async () => {
    const { s, saleId } = await financedDirectDeal("s30Gross");

    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:users"],
        isSystemOwnerRole: false,
      });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesVolumeBasis: string;
      topPerformer: { name: string } | null;
      truncated: { topPerformer: boolean };
    };

    // Premise: this viewer is on the gross basis.
    expect(dash.salesVolumeBasis).toBe("GROSS_TRANSACTION_VALUE");
    // Their 20,000 IS in this viewer's headline, so removing them from the tile
    // beside it puts two figures on one screen in contradiction.
    expect(dash.topPerformer?.name).toBe("Deal User");
    expect(dash.truncated.topPerformer).toBe(false);
  });

  /**
   * The marker the product actually renders. `truncated.profit` is read by no
   * consumer anywhere; the web dashboard's trailing "+" and its amber note, and
   * the mobile home's equivalent, all read `truncated.turnover`. So a headline
   * shortened by an unknown earning was displayed as exact.
   */
  test("a turnover shortened by an unknown earning says so on the flag the UI reads", async () => {
    const { s, saleId } = await financedDirectDeal("s30TurnFlag");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, { consignedMarginMinor: undefined });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as { salesVolumeThisMonth: number; truncated: { turnover: boolean } };

    expect(dash.salesVolumeThisMonth).toBe(0);
    expect(dash.truncated.turnover).toBe(true);
  });

  /**
   * A hard-deleted vehicle — reachable through the `/admin` raw editor — made
   * the REPORT discard the margin the sale froze and publish the whole ticket
   * as the dealership's revenue and profit.
   */
  test("a sale whose vehicle row is gone keeps the earning the sale itself recorded", async () => {
    const { s, saleId } = await financedDirectDeal("s30NoVehicle");

    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(saleId)) as unknown as { vehicleId: Id<"vehicles"> };
      await ctx.db.delete(sale.vehicleId);
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });

    // 3,000 is what the GL, the supplier claim and the cockpit recognized.
    expect(report.totalRevenue).toBe(3_000);
    expect(report.totalProfit).toBe(3_000);
    // Specifically not the whole ticket against a cost basis that vanished
    // along with the vehicle.
    expect(report.totalRevenue).not.toBe(20_000);
  });

  /**
   * Both halves of one row have to be on one basis.
   *
   * The margin was moved onto the figure the sale froze; the supplier
   * settlement beside it was still derived from the live vehicle. A consigned
   * car is never capitalized into inventory, so `sourceCost` stays editable
   * after the sale — and the deal then reported the frozen 3,000 next to a
   * live 16,000, disagreeing with the GL, the subledger and the claim that was
   * actually raised.
   */
  test("a supplier cost corrected after the sale does not restate what the supplier was owed", async () => {
    const { s, saleId } = await financedDirectDeal("s30FrozenEntitlement");

    const before = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });
    expect(before.totalSupplierSettlement).toBe(15_000);

    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(saleId)) as unknown as { vehicleId: Id<"vehicles"> };
      await ctx.db.patch(sale.vehicleId, { sourceCost: 16_000 });
    });

    const after = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId,
      ...range(),
    });

    // The entitlement the claim was raised against, unchanged by a later edit.
    expect(after.totalSupplierSettlement).toBe(15_000);
    expect(after.totalSupplierSettlement).not.toBe(16_000);
    // And the margin beside it is still the one the ledger recognized, so the
    // two halves of the row remain on the same basis.
    expect(after.totalProfit).toBe(3_000);
  });

  /**
   * Removing a cheque number that was never on the advice.
   *
   * Omission means "no change" here, and deliberately so — that is what fixed
   * an earlier defect where an amount-only correction erased the reference and
   * moved the payment date. But the audit recorded `args.reference ?? null`
   * while the write recorded `args.reference ?? existing`, so the two disagreed
   * about exactly one case: the operator who clears the field. They were told it
   * worked, the old reference survived, and the audit asserted it was removed.
   *
   * On the record whose entire purpose is to state what somebody else's
   * document said, an audit entry that contradicts the stored value is worse
   * than the failed edit.
   */
  test("clearing a wrongly transcribed reference removes it, and the audit says what actually happened", async () => {
    const { s, applicationId } = await paidDealForClearing("s30ClearRef");

    await s.asUser.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      reference: "WRONG-CHEQUE-9",
    });

    await s.asUser.mutation(api.applications.amendSupplierDisbursementAdvice, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 18_000 * SCALE,
      clearReference: true,
      reason: "The cheque number belonged to a different deal entirely.",
    } as never);

    const app = (await s.t.run((ctx) => ctx.db.get(applicationId as never))) as unknown as {
      supplierDisbursementReference?: string;
    };
    expect(app.supplierDisbursementReference).toBeUndefined();

    const entry = await s.t.run(async (ctx) =>
      (await ctx.db.query("financialAuditLog").collect())
        .filter((l) => l.actionType === "AMEND_SUPPLIER_DISBURSEMENT_ADVICE")
        .at(-1)
    );
    // Asserted to exist first. `entry?.after?.x ?? null` is null when there is
    // no entry at all, so the interesting assertion below would pass against a
    // missing audit record — it did, while this test was reading a table name
    // that does not exist.
    expect(entry).toBeTruthy();
    const after = (entry as unknown as { after?: Record<string, unknown> }).after!;
    const before = (entry as unknown as { before?: Record<string, unknown> }).before!;
    // What was actually removed, and what it was before — the audit now states
    // the value that is really on the row rather than the argument it was sent.
    expect(before.supplierDisbursementReference).toBe("WRONG-CHEQUE-9");
    expect(after.supplierDisbursementReference).toBeNull();
  });

  async function paidDealForClearing(tag: string) {
    const s = await seedDealership(tag);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 100 });
    });
    const { applicationId } = await runDeal(s, { route: "DIRECT_TO_SUPPLIER", finalize: false });
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: 18_000 * SCALE,
      basis: "MANUAL",
      notes: "Approved at 18,000.",
    });
    await s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId });
    return { s, applicationId };
  }
});

/**
 * Where the deal's canonical screen lives, once a sale exists — and the case
 * where it does NOT live at the sale.
 *
 * SCRUM-29 makes `/sales/{saleId}/deal` the one address a deal has, so the
 * application-keyed route redirects there once the application is finalized.
 * `app.finalizedSaleId` is the obvious thing to redirect on and it is the WRONG
 * thing: it outlives the sale. `sales.softDelete` sets `isDeleted` and nothing
 * anywhere clears the application's pointer, so the id stays plausible while
 * `sales.dealCockpit` starts returning null for it — and the redirect would
 * replace a screen that renders with one reporting the sale does not exist.
 * Settlement notifications deep-link to the application URL, so that strands a
 * real audit path.
 *
 * Hence `canonicalSaleId`, validated on the server. The client cannot see
 * `isDeleted` and must not be the thing deciding whether a destination is real.
 */
describe("the deal cockpit's canonical sale destination", () => {
  test("a finalized deal offers its sale as the canonical destination", async () => {
    const s = await seedDealership("canonicalOk");
    const { applicationId, saleId } = await runDeal(s, {
      finalize: true,
      route: "THROUGH_DEALERSHIP",
    });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view!.saleId).toBe(saleId);
    expect(view!.canonicalSaleId).toBe(saleId);
  });

  test("a deal whose sale was cancelled then deleted offers NO canonical destination", async () => {
    const s = await seedDealership("canonicalDeleted");
    const { applicationId, saleId } = await runDeal(s, {
      finalize: true,
      route: "THROUGH_DEALERSHIP",
    });

    // Reached through the two SUPPORTED mutations rather than by planting an
    // `isDeleted` flag production never sets: `softDelete` refuses a COMPLETED
    // sale outright ("Cannot delete a completed sale. Cancel it first."), and
    // `sales.update` explicitly permits COMPLETED -> CANCELLED. Neither clears
    // `finalizedSaleId`.
    await s.t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === s.orgId)!;
      await ctx.db.patch(role._id, {
        permissions: [...role.permissions, "delete:sales"],
      });
    });
    // A different actor: `sales.update` refuses to let a salesperson approve the
    // cancellation of their own sale, which is a real separation-of-duties rule
    // and not something to work around with a direct patch.
    await s.asApprover.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleId!,
      status: "CANCELLED" as const,
    });
    await s.asApprover.mutation(api.sales.softDelete, { orgId: s.orgId, saleId: saleId! });

    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    // The pointer survives, and is still reported as a fact about the deal...
    expect(view!.saleId).toBe(saleId);
    // ...but it is NOT offered as somewhere to send the operator.
    expect(view!.canonicalSaleId).toBeNull();
    // And the application's own screen still renders, which is the whole point:
    // the deal remains reachable rather than becoming a dead link.
    expect(view!.dealRef).toBe(applicationId);
  });
});


/**
 * SCRUM-49 Lane 4 / SCRUM-42 — the financed cockpit's own classification.
 *
 * `resolveSettlement` asked `vehicle != null && isConsignedAgentSale(vehicle)`,
 * the NARROW test. `saleEconomics` has always applied the broader one: a vehicle
 * row that is gone does not stop a sale from having BEEN an agent sale when the
 * sale's own frozen evidence survives. The two disagree exactly when the vehicle
 * has been hard-deleted — reachable through `/admin`'s raw-JSON editor, and
 * through a `hardDeleteOrg` that fails part-way.
 *
 * The consequence is in `resolveSupplierObligation`'s THROUGH branch: with no
 * payable row to read it answers `consigned ? "UNKNOWN" : "NONE"`. Wrongly
 * `false`, a debt that certainly exists reads as PROVEN ABSENT, and
 * `settlementIsComplete` treats NONE as done. The rail then reports the deal
 * settled while the supplier is still owed his entire entitlement.
 *
 * Both erasures are the SAME failure mode, which is why the pair is realistic
 * rather than contrived: `hardDeleteOrg` removes the supplier rows and the
 * vehicles in one run, so a run that dies in the middle leaves precisely this.
 *
 * SCRUM-29 fixed the identical classification bug on the CASH cockpit and
 * deliberately left this production accounting surface alone — which is why it
 * is its own ticket, with its own regression, on its own review.
 */
describe("SCRUM-42 — a lost vehicle must not turn an unpaid supplier into a settled one", () => {
  async function cockpitOfApp(s: Seeded, applicationId: string) {
    return await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: applicationId as never,
    });
  }
  const stageOf = (view: Awaited<ReturnType<typeof cockpitOfApp>>, key: string) =>
    view!.stages.find((st) => st.key === key)!.state;
  const supplierRow = (view: Awaited<ReturnType<typeof cockpitOfApp>>) =>
    view!.money!.parties.find((p) => p.party === "SUPPLIER")!;

  async function throughRouteDeal(tag: string) {
    const s = await seedDealership(tag);
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: true });
    // The financier's own leg finished. Without this the rail could never read
    // COMPLETE whatever the supplier leg said, and the test would prove nothing.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" });
    });
    return { s, applicationId };
  }

  async function payableOf(s: Seeded) {
    return await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierPayables").collect()).find(
        (row) => row.orgId === (s.orgId as never) && row.status !== "CANCELLED"
      )
    );
  }

  test("the rail does not report a deal settled when the debt record and the vehicle are both gone", async () => {
    const { s, applicationId } = await throughRouteDeal("s42Through");

    // Premise 1: the dealership really does owe him, and the record says so.
    const payable = await payableOf(s);
    expect(payable).toBeDefined();
    expect(payable!.amountDue).toBeGreaterThan(0);

    // Premise 2: with the record present the rail is already not complete, so
    // the assertion below cannot pass merely because completion is unreachable.
    expect(stageOf(await cockpitOfApp(s, applicationId), "SETTLEMENT")).not.toBe("COMPLETE");

    // What a half-finished `hardDeleteOrg` leaves behind: the supplier rows
    // removed before the vehicles, and the sale still standing.
    const sale = await s.t.run(async (ctx) => await ctx.db.get(payable!.saleId!));
    await s.t.run(async (ctx) => {
      await ctx.db.delete(payable!._id);
      await ctx.db.delete(sale!.vehicleId);
    });

    const view = await cockpitOfApp(s, applicationId);

    // The debt did not stop existing because its record did. UNKNOWN is the
    // honest answer and it is not completion; NONE is the claim that nobody is
    // owed anything, and it is what this read before the fix.
    expect(stageOf(view, "SETTLEMENT")).not.toBe("COMPLETE");

    // Name the REASON, not just the outcome. A stage can be incomplete for
    // reasons that have nothing to do with the supplier, so `not COMPLETE`
    // alone would keep passing if the obligation silently went back to NONE.
    // The supplier's projected position is where "we cannot tell" is stated.
    expect(supplierRow(view).position).toBe("UNKNOWN");
  });

  test("a genuinely dealer-owned deal still reports nothing owed to a supplier", async () => {
    // The other side of the guard. A fix that simply answered "consigned" more
    // often would strand every ordinary financed sale in UNKNOWN for ever.
    const s = await seedDealership("s42Owned");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.vehicleId as never, {
        sourceType: "STOCK",
        purchasePrice: 15_000,
      });
    });
    const { applicationId } = await runDeal(s, { finalize: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" });
    });

    const view = await cockpitOfApp(s, applicationId);
    const supplier = view!.money!.parties.find((p) => p.party === "SUPPLIER")!;
    // No supplier, nothing owed, and the deal is free to finish.
    expect(supplier.amountMinor).toBe(0);
    expect(stageOf(view, "SETTLEMENT")).toBe("COMPLETE");
  });
});

/**
 * A deal walked to APPROVED with the vehicle handed over and NOTHING else.
 *
 * `runDeal` registers the expected payment on its way past, which is right for
 * every settlement case in this file and wrong for the two below: they are about
 * the moment before that registration, and about what happens when it is
 * refused.
 */
async function approvedHandedOverDeal(s: Seeded): Promise<Id<"financeApplications">> {
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId,
    totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  await s.asUser.mutation(api.applications.updateStatus, {
    orgId: s.orgId,
    applicationId,
    status: "UNDER_REVIEW",
  });
  await s.asApprover.mutation(api.applications.updateStatus, {
    orgId: s.orgId,
    applicationId,
    status: "APPROVED",
  });
  await registerHandover(s.asUser, api, s.orgId, applicationId);
  return applicationId;
}

/**
 * The workflow facts the DEAL COCKPIT projects, and the boundary that keeps one
 * of them from becoming unreachable state.
 *
 * SCRUM-78 moved handover, expected payment and close onto the cockpit, so the
 * screen now has to answer "can this step be taken" for itself. Two adversarial
 * findings landed exactly there, and both are the query and the mutation
 * disagreeing about the same deal.
 */
describe("the cockpit's workflow projections", () => {
  test("names the settlement route as outstanding before it offers a close", async () => {
    const s = await seedDealership("cockpitroute");
    const { applicationId } = await runDeal(s, { finalize: false });

    const before = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    // A consigned car, an external financier, no route chosen — the ordinary
    // shape of a consigned financed deal, and the one `finalizeDeal` refuses.
    // Without this projection the cockpit offered a close that was certain to
    // be rejected, one step AFTER handover had sealed the approved amount.
    expect(before!.supplierSettlementRouteRequired).toBe(true);
    // And it really would have been refused — asserted against the mutation
    // rather than assumed from reading it, because "the screen and the server
    // agree about this deal" is the only thing this projection is for.
    await expect(
      s.asUser.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId })
    ).rejects.toThrow(/settlement route/i);

    await s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });

    const after = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(after!.supplierSettlementRouteRequired).toBe(false);
  });

  test("reports the expected payment only once one is really on file", async () => {
    const s = await seedDealership("cockpitpay");
    const applicationId = await approvedHandedOverDeal(s);

    const before = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(before!.expectedPaymentRegistered).toBe(false);

    await s.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });

    const after = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    // Asserted across the REAL writer rather than by setting the flag in a
    // fixture. The component tests hand this boolean to the screen, so nothing
    // there proves the query computes it at all.
    expect(after!.expectedPaymentRegistered).toBe(true);
  });

  test("refuses an expected-payment date that would strand the deal", async () => {
    const s = await seedDealership("cockpitzero");
    const applicationId = await approvedHandedOverDeal(s);

    // 1970-01-01, which the date field will happily produce. `v.number()`
    // admits it and `finalizeDeal` tests the value for truth — so it used to be
    // accepted here, stamped as registered, and then block the close forever
    // while this mutation refused a second attempt and the sealed approval could
    // no longer be reopened. There was no way out but cancelling the deal.
    await expect(
      s.asUser.mutation(api.applications.registerExpectedPayment, {
        orgId: s.orgId,
        applicationId,
        method: "BANK_TRANSFER",
        expectedDate: 0,
      })
    ).rejects.toThrow(/valid date/i);

    // The refusal has to leave the deal exactly where it was, or it has only
    // moved the dead end: a stamped `expectedPaymentRegisteredAt` would refuse
    // every later attempt too.
    const view = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(view!.expectedPaymentRegistered).toBe(false);

    await s.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    const recovered = await s.asUser.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(recovered!.expectedPaymentRegistered).toBe(true);
  });

  test("tells a caller who cannot see the money which step the deal is on", async () => {
    const s = await seedDealership("cockpitgate");
    const { applicationId } = await runDeal(s, { finalize: false });

    // `view:sales` and nothing financial — the salesperson tracking their own
    // deal's progress. The money block is withheld from them by design, and the
    // workflow conditions have to survive that: a step nobody is shown is the
    // same dead end in a different place.
    const watcherId = await s.t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "cockpitgate_watch",
        email: "watch.cockpitgate@example.com",
        name: "Watcher",
      })
    );
    const watcherRoleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.orgId, name: "Watcher", permissions: ["view:sales"] })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: s.orgId, userId: watcherId, roleId: watcherRoleId })
    );

    const view = await s.t
      .withIdentity({ subject: "cockpitgate_watch", clerkId: "cockpitgate_watch" })
      .query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });

    expect(view!.money).toBeNull();
    expect(view!.expectedPaymentRegistered).toBe(true);
    expect(view!.supplierSettlementRouteRequired).toBe(true);
  });
});
